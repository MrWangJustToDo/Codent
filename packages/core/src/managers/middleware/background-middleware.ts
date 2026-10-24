/**
 * Background middleware — everything the background-job class injects.
 *
 * Two shapes live here because both are about background work, and neither is a per-turn
 * context section:
 *
 * 1. **`<background_jobs>` pointer** — hash-admitted like a turn-context section (inject when
 *    the list differs from the newest block in the wire, or when a compaction cut dropped it),
 *    listing only jobs whose `run_command` call is still model-visible. Built from the wire it
 *    is handed, never from remembered state.
 * 2. **Completion notification** — a one-shot push per finished job. A push is not admitted by
 *    content: each completion is delivered exactly once (the registry marks it), and the
 *    synthetic message is persisted so it survives across turns.
 *
 * Background *tasks* land in the same class when they exist.
 */

import { truncateString } from "../../agent/tools/shared/output-limits.js";
import {
  TURN_CONTEXT_KINDS,
  contextSectionIdentity,
  findLatestContextSectionsFromWire,
  formatContextSectionUserContent,
  formatSectionTag,
  hashTurnContextSection,
} from "../../agent/turn-context";
import { injectSyntheticMessages, nextSyntheticNonce } from "../../agent/turn-context/synthetic-injection.js";

import { defineMiddleware } from "./phase.js";

import type { CompletedCommandJob } from "../../agent/tools/builtin/shell/jobs/registry.js";
import type { TurnContextSection } from "../../agent/turn-context";
import type { AgentUIChannel } from "../../agent/ui/ui-channel.js";
import type { AgentCommandService } from "../services/agent-command-service.js";
import type { ChatMiddleware, ModelMessage, UIMessage } from "@tanstack/ai";

export interface BackgroundMiddlewareDeps {
  /** Cap per-notification output length to avoid inflating the prompt. */
  maxOutputChars?: number;
  /** Live access to the UI channel (to persist the synthetic messages). */
  getUIChannel: () => AgentUIChannel | undefined;
  /** Persist the updated UI messages (dehydrate session to disk). */
  persistMessages: (next: UIMessage[]) => void;
  /** The owning agent's background-job registry (pointer + completions). */
  getCommandService: () => AgentCommandService;
  /** Parent id of the owning agent — subagents get neither the pointer nor jobs. */
  getParentId: () => string | undefined;
}

const NOTIFICATION_KIND = TURN_CONTEXT_KINDS.backgroundNotification;
const JOBS_KIND = TURN_CONTEXT_KINDS.backgroundJobs;

export function createBackgroundMiddleware(deps: BackgroundMiddlewareDeps): ChatMiddleware {
  const maxOutputChars = deps.maxOutputChars ?? 2000;

  return defineMiddleware("tools", {
    name: "background",
    onConfig: async (_ctx, config) => {
      let messages = config.messages as ModelMessage[];

      // --- 1. The pointer section (hash-admitted, root agents only) ---
      if (!deps.getParentId()) {
        const section = await buildJobsSection(deps, messages);
        const ui = deps.getUIChannel();
        if (section && ui) {
          const identity = contextSectionIdentity(section);
          const prior = findLatestContextSectionsFromWire(messages, new Set([identity])).get(identity);
          if (!prior || hashTurnContextSection(prior) !== hashTurnContextSection(section)) {
            const content = formatContextSectionUserContent(section, { isUpdate: prior !== undefined });
            const injected = injectSyntheticMessages(
              messages,
              [{ kind: JOBS_KIND, content, nonce: nextSyntheticNonce(ui.getMessages(), JOBS_KIND) }],
              { ui, persist: deps.persistMessages }
            );
            messages = injected.messages;
          }
        }
      }

      // --- 2. Completions (one-shot push) ---
      const commandService = deps.getCommandService();
      // Do not mark yet: the notification must be persisted first, or a crash between collect
      // and inject loses the completion while the record says it was delivered.
      const completed = await commandService.collectCompleted();
      if (completed.length === 0) return messages === config.messages ? {} : { messages };

      const ui = deps.getUIChannel();
      if (!ui) {
        // No channel: transient wire-only injection, with no durable copy behind it (and no
        // `<background_jobs>` section either). Marking here is the deliberate best-effort for a
        // channel-less caller; callers that can lose a turn should provide a channel.
        await commandService.markNotified(completed.map((job) => job.id));
        return {
          messages: [...messages, { role: "user", content: formatNotifications(completed, maxOutputChars) }],
        };
      }

      // Shared injection path: content-hash dedupe + channel persistence + wire positioning.
      // The channel write is the delivery point; the content-hash id dedupes a re-delivery if
      // the row landed, and the pointer section re-admits the job id/log path if it did not.
      const injected = injectSyntheticMessages(
        messages,
        [{ kind: NOTIFICATION_KIND, content: formatNotifications(completed, maxOutputChars) }],
        { ui, persist: deps.persistMessages }
      );
      await commandService.markNotified(completed.map((job) => job.id));

      return { messages: injected.messages };
    },
  });
}

/**
 * Build the pointer for the current wire, or `undefined` when there is nothing to point at.
 *
 * A host without a job store (tests / standalone) and a subagent have none; the section is
 * optional, so a failure degrades to "no pointer" instead of failing the run.
 */
async function buildJobsSection(
  deps: BackgroundMiddlewareDeps,
  messages: readonly ModelMessage[]
): Promise<TurnContextSection | undefined> {
  try {
    return await deps.getCommandService().sectionFor(messages);
  } catch {
    return undefined;
  }
}

function formatNotifications(jobs: CompletedCommandJob[], maxOutputChars: number): string {
  const sections = jobs.map((job) => {
    const status = job.status === "exited" ? "completed" : job.status;
    const exit = job.exitCode == null ? "n/a" : String(job.exitCode);
    const body = [`Job ${job.id} finished with status ${status} (exit code ${exit}).`, `Command: ${job.command}`];
    // Keep the tail (most recent output) within the per-job cap.
    const out = truncateString(job.stdout, maxOutputChars, true).text;
    const err = truncateString(job.stderr, maxOutputChars, true).text;
    if (out) body.push(`stdout:\n${out}`);
    if (err) body.push(`stderr:\n${err}`);
    if (job.logPath) body.push(`log: ${job.logPath} (full output)`);
    return body.join("\n");
  });

  return formatContextSectionUserContent({
    key: NOTIFICATION_KIND,
    content: formatSectionTag(NOTIFICATION_KIND, sections.join("\n\n")),
  });
}
