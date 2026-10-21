/**
 * Background-work ownership: the per-agent command-job registry, its durable restore, and the
 * `<background_jobs>` turn-context pointer.
 *
 * This used to be three responsibilities spread across `ManagedAgent` (lazy registry + change
 * listener + section builder), the registry itself, and the turn-context middleware. The service is
 * the single owner of the registry lifecycle; the middleware remains the delivery layer for the
 * one-shot completion notification.
 *
 * The registry is created lazily because the agent is built before `ensureSessionData()` mints the
 * disk session id; both the env and the owner id are getters for that reason.
 */

import { CommandJobRegistry } from "../../agent/tools/util/command-job-registry.js";
import {
  collectRunCommandToolCallIds,
  formatBackgroundJobsSection,
  TURN_CONTEXT_KINDS,
} from "../../agent/turn-context";

import type { CommandJobSummary, CompletedCommandJob } from "../../agent/tools/util/command-job-registry.js";
import type { TurnContextSection } from "../../agent/turn-context/turn-context-message.js";
import type { ResolvedCoreEnv } from "../../env";
import type { ModelMessage } from "@tanstack/ai";

export interface BackgroundWorkServiceOptions {
  /** Resolved lazily; the agent's runtime env may not exist when the service is constructed. */
  env: () => ResolvedCoreEnv;
  /** The disk session that owns the jobs; resolved lazily for the same reason. */
  ownerSessionId: () => string | undefined | null;
  /** Forwarded to the session `jobs` channel (the registry's change listener). */
  onJobsChange: (jobs: CommandJobSummary[]) => void;
}

export class BackgroundWorkService {
  private registryInstance?: CommandJobRegistry;

  constructor(private readonly options: BackgroundWorkServiceOptions) {}

  /** The registry tools use. Creates it (and its change listener) on first access. */
  registry(): CommandJobRegistry {
    if (!this.registryInstance) {
      const registry = new CommandJobRegistry(this.options.env(), {
        ownerSessionId: this.options.ownerSessionId,
      });
      registry.setChangeListener(this.options.onJobsChange);
      this.registryInstance = registry;
    }
    return this.registryInstance;
  }

  /** Non-creating read: a status snapshot must not mint a registry before any job exists. */
  list(): CommandJobSummary[] {
    return this.registryInstance?.list() ?? [];
  }

  /** Restore this session's durable job records once. */
  async ready(): Promise<void> {
    await this.registry().ready();
  }

  /**
   * The `<background_jobs>` section for the model-visible wire. Only jobs whose `run_command` call
   * is still in `messages` are listed; after compaction drops the call, re-listing it is noise.
   */
  async sectionFor(messages: readonly ModelMessage[], generation: number): Promise<TurnContextSection | undefined> {
    await this.ready();
    const inContext = collectRunCommandToolCallIds(messages);
    const rows = this.registry()
      .listForTurnContext()
      .filter((job) => job.toolCallId !== undefined && inContext.has(job.toolCallId));
    const content = formatBackgroundJobsSection(rows, { generation });
    return content ? { key: TURN_CONTEXT_KINDS.backgroundJobs, content } : undefined;
  }

  /** Peek the completion queue (the notification middleware marks it after delivery). */
  collectCompleted(): Promise<CompletedCommandJob[]> {
    return this.registry().collectCompleted({ markNotified: false });
  }

  /** Mark completions delivered after their synthetic message is persisted. */
  markNotified(jobIds: readonly string[]): Promise<void> {
    return this.registry().markNotified(jobIds);
  }

  /** Kill/destroy the registry (agent destroy); terminal un-notified records are preserved. */
  async destroy(): Promise<void> {
    const registry = this.registryInstance;
    this.registryInstance = undefined;
    registry?.setChangeListener(null);
    await registry?.destroyAll();
  }
}
