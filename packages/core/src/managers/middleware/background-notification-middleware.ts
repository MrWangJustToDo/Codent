import { truncateString } from "../../agent/tools/shared/output-limits.js";
import { formatContextSectionUserContent } from "../../agent/turn-context";
import { injectSyntheticMessages } from "../../agent/turn-context/synthetic-injection.js";

import { defineMiddleware } from "./phase.js";

import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { CommandJobRegistry, CompletedCommandJob } from "../../agent/tools/builtin/shell/jobs/registry.js";
import type { AgentUIChannel } from "../../agent/ui/ui-channel.js";
import type { ChatMiddleware, ModelMessage, UIMessage } from "@tanstack/ai";

export interface BackgroundNotificationMiddlewareDeps {
  /** Cap per-notification output length to avoid inflating the prompt. */
  maxOutputChars?: number;
  /** Live access to the UI channel (to persist the synthetic notification). */
  getUIChannel: () => AgentUIChannel | undefined;
  /** Persist the updated UI messages (dehydrate session to disk). */
  persistMessages: (next: UIMessage[]) => void;
  /** The owning agent's background-job registry (drained for completions). */
  getCommandJobRegistry: () => CommandJobRegistry;
}

const BACKGROUND_NOTIFICATION_KIND = "background_notification";

/**
 * Lightweight completion notification for background jobs.
 *
 * Before each LLM call (including mid-loop iterations), drain the completed-job
 * queue from the owning agent's command-job registry and append a single synthetic user
 * message listing every newly-finished job. Each job is notified exactly once
 * (registry marks it notified). Kept out of turn-context so a background job
 * finishing does not re-emit the large per-turn context snapshot.
 *
 * The notification is BOTH injected transiently into the current run's messages
 * (so the model sees it mid-loop) AND persisted into the UI channel + session as
 * a small, independent synthetic message (so it survives across turns and keeps
 * the prompt-cache prefix byte-stable). Each notification message carries its own
 * stable id derived from its content hash, so restores never duplicate it.
 *
 * Output is capped per job to avoid inflating the prompt.
 */
export function createBackgroundNotificationMiddleware(
  deps: BackgroundNotificationMiddlewareDeps
): ChatMiddleware<ToolRunContext> {
  const maxOutputChars = deps.maxOutputChars ?? 2000;

  return defineMiddleware("tools", {
    name: "background-notification",
    onConfig: async (_ctx, config) => {
      const registry = deps.getCommandJobRegistry();
      // Do not mark yet: the notification must be persisted first, or a crash between collect and
      // inject loses the completion while the record says it was delivered.
      const completed = await registry.collectCompleted({ markNotified: false });
      if (completed.length === 0) return {};

      const messages = config.messages as ModelMessage[];
      const ui = deps.getUIChannel();
      if (!ui) {
        // No channel: transient wire-only injection, with no durable copy behind it (and no
        // `<background_jobs>` section either — that also needs a channel). Marking here is the
        // deliberate best-effort for a channel-less caller; callers that can lose a turn should
        // provide a channel. Still returns a new array — the input may be the projection cache.
        await registry.markNotified(completed.map((job) => job.id));
        return {
          messages: [...messages, { role: "user", content: formatNotifications(completed, maxOutputChars) }],
        };
      }

      // Shared injection path: content-hash dedupe + channel persistence + wire
      // positioning. Jobs are marked notified by the registry, so each completion
      // reaches this point exactly once. Appended at the end (one-shot semantics).
      const { messages: next } = injectSyntheticMessages(
        messages,
        [{ kind: BACKGROUND_NOTIFICATION_KIND, content: formatNotifications(completed, maxOutputChars) }],
        { ui, persist: deps.persistMessages }
      );
      // The channel write is the delivery point. The session persist behind it is fire-and-forget
      // in this host, so a crash in this window is covered two ways: the content-hash id dedupes a
      // re-delivery if the row landed, and the `<background_jobs>` turn-context section re-admits
      // the job id/log path if it did not.
      await registry.markNotified(completed.map((job) => job.id));

      return { messages: next };
    },
  });
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

  return formatContextSectionUserContent({ key: BACKGROUND_NOTIFICATION_KIND, content: sections.join("\n\n") });
}
