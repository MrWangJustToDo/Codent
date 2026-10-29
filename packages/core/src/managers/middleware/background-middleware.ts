/**
 * Background middleware — everything the background-job class injects.
 *
 * Two layers, in this order:
 *
 * 1. **Completion notification (core)** — a one-shot push per finished job, carrying the status
 *    and the output tail. Delivered exactly once (the registry marks it) and persisted, so it
 *    survives across turns.
 * 2. **`<background_jobs>` pointer (safety net)** — compaction summarizes a prefix away, so a
 *    delivery is usually still the model's only record of a job *until* a later cut drops it.
 *    The pointer lists the jobs this wire does **not** already announce (running jobs included:
 *    they have no notification yet), so after such a cut the model can rediscover the id and
 *    read the log — and it never duplicates a result it can already see. Only jobs whose
 *    `run_command` call is still in the wire are listed; once the call is gone, re-listing is
 *    noise. Admission is the shared hash rule (`selectChangedSections`), not remembered state.
 *
 * The model can also poll any job through `get_command_output`, so the pointer is deliberately
 * cheap and metadata-only.
 *
 * Background *tasks* land in the same class when they exist.
 */

import { truncateString } from "../../agent/tools/shared/output-limits.js";
import { TURN_CONTEXT_KINDS, formatContextSectionUserContent, formatSectionTag } from "../../agent/turn-context";
import { collectAnnouncedJobIds } from "../../agent/turn-context/background-jobs.js";
import {
  injectSyntheticMessages,
  nextSyntheticNonce,
  selectChangedSections,
} from "../../agent/turn-context/synthetic-injection.js";
import { errorMessage } from "../../utils/errors.js";

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
  /** Record a degraded step as `session:diagnostic` (the policy owns the row). */
  emitDiagnostic?: (
    area: "jobs",
    message: string,
    options?: { level?: "debug" | "info" | "warn" | "error"; error?: string }
  ) => void;
}

const NOTIFICATION_KIND = TURN_CONTEXT_KINDS.backgroundNotification;
const JOBS_KIND = TURN_CONTEXT_KINDS.backgroundJobs;

export function createBackgroundMiddleware(deps: BackgroundMiddlewareDeps): ChatMiddleware {
  const maxOutputChars = deps.maxOutputChars ?? 2000;

  return defineMiddleware("tools", {
    name: "background",
    onConfig: async (_ctx, config) => {
      let messages = config.messages as ModelMessage[];
      const commandService = deps.getCommandService();

      // --- 1. Completions (core): one-shot push per finished job ---
      // Do not mark yet: the channel row must exist first. The session write behind it is
      // fire-and-forget, so the persistence guarantee here is "the row is in the channel and
      // queued", not "on disk" — a crash in between is recovered by the pointer below.
      const completed = await commandService.collectCompleted();
      if (completed.length > 0) {
        const ui = deps.getUIChannel();
        if (!ui) {
          // No channel: transient wire-only injection, with no durable copy behind it (and no
          // pointer either). Marking here is the deliberate best-effort for a channel-less
          // caller; callers that can lose a turn should provide a channel.
          await commandService.markNotified(completed.map((job) => job.id));
          messages = [...messages, { role: "user", content: formatNotifications(completed, maxOutputChars) }];
        } else {
          const injected = injectSyntheticMessages(
            messages,
            [{ kind: NOTIFICATION_KIND, content: formatNotifications(completed, maxOutputChars) }],
            { ui, persist: deps.persistMessages }
          );
          messages = injected.messages;
          await commandService.markNotified(completed.map((job) => job.id));
        }
      }

      // --- 2. Pointer (safety net): visible jobs this wire does not announce yet ---
      if (!deps.getParentId()) {
        const announced = collectAnnouncedJobIds(messages);
        const section = await buildJobsSection(deps, messages, announced);
        const ui = deps.getUIChannel();
        const admission = section ? selectChangedSections(messages, [section])[0] : undefined;
        if (admission && ui) {
          const content = formatContextSectionUserContent(admission.section, { isUpdate: admission.isUpdate });
          const injected = injectSyntheticMessages(
            messages,
            [{ kind: JOBS_KIND, content, nonce: nextSyntheticNonce(ui.getMessages(), JOBS_KIND) }],
            { ui, persist: deps.persistMessages }
          );
          messages = injected.messages;
        }
      }

      return messages === config.messages ? {} : { messages };
    },
  });
}

/**
 * Build the pointer for the current wire, or `undefined` when there is nothing to point at.
 *
 * A host without a job store (tests / standalone) and a subagent have none; the section is
 * optional, so a failure degrades to "no pointer" instead of failing the run — but it is
 * logged, because a silent failure here loses the model's only route back to a job whose
 * notification a compaction dropped.
 */
async function buildJobsSection(
  deps: BackgroundMiddlewareDeps,
  messages: readonly ModelMessage[],
  excludeJobIds: ReadonlySet<string>
): Promise<TurnContextSection | undefined> {
  try {
    return await deps.getCommandService().sectionFor(messages, { excludeJobIds });
  } catch (error) {
    deps.emitDiagnostic?.("jobs", "background_jobs pointer unavailable", {
      level: "warn",
      error: errorMessage(error),
    });
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
    // Machine-readable job ids: the pointer uses them to tell "already announced" from
    // "announcement compacted away" without parsing the prose above.
    attrs: { jobs: jobs.map((job) => job.id).join(",") },
  });
}
