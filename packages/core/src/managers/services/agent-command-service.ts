/**
 * Agent command service: the per-agent command-job registry, durable restore, background start /
 * poll / kill, and the `<background_jobs>` turn-context pointer.
 *
 * This used to be three responsibilities spread across `ManagedAgent` (lazy registry + change
 * listener + section builder), the registry itself, and the turn-context middleware. The service is
 * the single owner of the registry lifecycle; the middleware remains the delivery layer for the
 * one-shot completion notification.
 *
 * The registry is created lazily because the agent is built before `ensureSessionData()` mints the
 * disk session id; both the env and the owner id are getters for that reason.
 */

import { CommandJobRegistry } from "../../agent/tools/builtin/shell/jobs/registry.js";
import {
  collectRunCommandToolCallIds,
  formatBackgroundJobsSection,
  TURN_CONTEXT_KINDS,
} from "../../agent/turn-context";
import { errorMessage } from "../../utils/errors.js";

import type {
  CommandJobPollResult,
  CommandJobSummary,
  CompletedCommandJob,
} from "../../agent/tools/builtin/shell/jobs/registry.js";
import type {
  AgentCommandPort,
  StartBackgroundInput,
  StartBackgroundResult,
  KillCommandResult,
} from "../../agent/tools/runtime/command-service.js";
import type { TurnContextSection } from "../../agent/turn-context/turn-context-message.js";
import type { ResolvedCoreEnv } from "../../env";
import type { ModelMessage } from "@tanstack/ai";

export interface AgentCommandServiceOptions {
  /** Resolved lazily; the agent's runtime env may not exist when the service is constructed. */
  env: () => ResolvedCoreEnv;
  /** The disk session that owns the jobs; resolved lazily for the same reason. */
  ownerSessionId: () => string | undefined | null;
  /** Forwarded to the session `jobs` channel (the registry's change listener). */
  onJobsChange: (jobs: CommandJobSummary[]) => void;
}

export class AgentCommandService implements AgentCommandPort {
  private registryInstance?: CommandJobRegistry;

  constructor(private readonly options: AgentCommandServiceOptions) {}

  /** The registry tools use. Creates it (and its change listener) on first access. */
  private registry(): CommandJobRegistry {
    if (!this.registryInstance) {
      const registry = new CommandJobRegistry(this.options.env(), {
        ownerSessionId: this.options.ownerSessionId,
      });
      registry.setChangeListener(this.options.onJobsChange);
      this.registryInstance = registry;
    }
    return this.registryInstance;
  }

  /** Start a background command and attach its lifecycle to the owned registry. */
  async startBackground(input: StartBackgroundInput): Promise<StartBackgroundResult> {
    await this.ready();
    // Capture the registry for the whole command lifetime. A late stdout/stderr/exit
    // callback must not recreate a destroyed registry after the agent is torn down.
    const registry = this.registry();
    const { command, toolCallId, cwd, env, coreEnv } = input;
    if (!coreEnv.startCommand) {
      throw new Error(
        "Background commands are not supported in this environment. " +
          "Omit run_in_background or use a local/node or playground CoreEnv that implements startCommand."
      );
    }
    const job = registry.create(command, toolCallId);
    try {
      const handle = await coreEnv.startCommand(command, {
        cwd,
        env,
        onStdout: (chunk) => registry.appendStdout(job.id, chunk),
        onStderr: (chunk) => registry.appendStderr(job.id, chunk),
        onExit: (exitCode) => registry.markExited(job.id, exitCode),
      });
      registry.setKill(job.id, handle.kill, handle.pid);
    } catch (err) {
      registry.markFailed(job.id, errorMessage(err));
      throw err;
    }
    return { jobId: job.id, ...(job.logPath ? { cachedOutputPath: job.logPath } : {}) };
  }

  /** Poll one job, throwing the same unknown-id error the registry's callers relied on. */
  async poll(jobId: string): Promise<CommandJobPollResult> {
    await this.ready();
    const registry = this.registry();
    const result = registry.poll(jobId);
    if (!result) throw new Error(`Unknown background jobId: ${jobId}`);
    return result;
  }

  /** Stop a job and return the terminal state the tools render. */
  async kill(jobId: string): Promise<KillCommandResult> {
    await this.ready();
    const registry = this.registry();
    const existing = registry.get(jobId);
    if (!existing) throw new Error(`Unknown background jobId: ${jobId}`);
    const killed = await registry.kill(jobId);
    const after = registry.get(jobId);
    return {
      killed,
      status: after?.status ?? "killed",
      ...(after?.logPath ? { logPath: after.logPath } : {}),
    };
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

  /** Session switch: drop this session's jobs and completion queue. */
  async reset(_reason: string): Promise<void> {
    await this.destroy();
  }

  /** Kill/destroy the registry (agent destroy); terminal un-notified records are preserved. */
  async destroy(): Promise<void> {
    const registry = this.registryInstance;
    this.registryInstance = undefined;
    registry?.setChangeListener(null);
    await registry?.destroyAll();
  }
}
