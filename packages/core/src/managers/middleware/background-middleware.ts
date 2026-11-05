/**
 * Background middleware — everything the background-work trunk injects into the wire.
 *
 * ONE delivery block, for both kinds, in this order:
 *
 * 1. **Completion notification (core)** — a one-shot push per finished unit, carrying the status and
 *    the result. Delivered exactly once (the facade marks it after the row is persisted), so it
 *    survives across turns — and across a compaction that dropped the tool call that started it.
 * 2. **`<background_jobs>` pointer (safety net, commands only)** — compaction summarizes a prefix
 *    away, so a delivery is usually still the model's only record of a job *until* a later cut drops
 *    it. The pointer lists the jobs this wire does **not** already announce (running jobs included:
 *    they have no notification yet), so after such a cut the model can rediscover the id and read the
 *    log — and it never duplicates a result it can already see. Only jobs whose `run_command` call is
 *    still in the wire are listed; once the call is gone, re-listing is noise. Admission is the shared
 *    hash rule (`selectChangedSections`), not remembered state.
 *
 * Tasks have no pointer on purpose: a task has no poll/kill tool to point at, and its completion is
 * written back into the `task` tool result at the same moment, so the call itself is the record.
 *
 * Both kinds share the block because they share the question ("what did my background work produce
 * while I was away?"). Two blocks would mean two formatters, two mark-after-persist paths and two
 * chances to lose a completion — the drift the trunk's port exists to prevent.
 */

import { backgroundWorkLabelPrefix, backgroundWorkNoun, COMMAND_JOB_KIND } from "../../agent/jobs/background-work.js";
import {
  TURN_CONTEXT_KINDS,
  captureSessionStaleness,
  formatContextSectionUserContent,
  formatSectionTag,
} from "../../agent/turn-context";
import { collectAnnouncedJobIds } from "../../agent/turn-context/background-jobs.js";
import {
  injectSyntheticMessages,
  nextSyntheticNonce,
  selectChangedSections,
} from "../../agent/turn-context/synthetic-injection.js";
import { defineMiddleware } from "../../runtime-types/middleware-phase.js";
import { errorMessage } from "../../utils/errors.js";

import type { BackgroundWorkCompletion } from "../../agent/jobs/background-work.js";
import type { TurnContextSection } from "../../agent/turn-context";
import type { AgentUIChannel } from "../../agent/ui/ui-channel.js";
import type { AgentCommandService } from "../services/agent-command-service.js";
import type { BackgroundWorkService } from "../services/background-work-service.js";
import type { ChatMiddleware, ModelMessage, UIMessage } from "@tanstack/ai";

export interface BackgroundMiddlewareDeps {
  /** Live access to the UI channel (to persist the synthetic messages). */
  getUIChannel: () => AgentUIChannel | undefined;
  /** Persist the updated UI messages (dehydrate session to disk). */
  persistMessages: (next: UIMessage[]) => void;
  /** Undelivered completions + the delivered flag, merged over both sources. */
  getBackgroundWork: () => BackgroundWorkService;
  /** The command source, for the `<background_jobs>` pointer (`sectionFor`). */
  getCommandService: () => AgentCommandService;
  /** Parent id of the owning agent — subagents get neither the pointer nor the notifications. */
  getParentId: () => string | undefined;
  /**
   * Whether a `/new` or `/resume` is in flight. The work reads below are async, and a write that
   * lands after the switch starts would be persisted into the target transcript.
   */
  isSessionSwitching?: () => boolean;
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
  return defineMiddleware("tools", {
    name: "background",
    onConfig: async (_ctx, config) => {
      let messages = config.messages as ModelMessage[];
      const work = deps.getBackgroundWork();
      // Anything collected for the session being unloaded is garbage once a switch starts: it is
      // dropped, never written into the target (see `captureSessionStaleness`).
      const isStaleSession = captureSessionStaleness(deps.getUIChannel(), deps.isSessionSwitching);

      // --- 1. Completions (core): one-shot push per finished unit, both kinds ---
      // Do not mark yet: the channel row must exist first. The session write behind it is
      // fire-and-forget, so the persistence guarantee here is "the row is in the channel and
      // queued", not "on disk" — a crash in between is recovered by the pointer below.
      const completed = await work.pending();
      // A switch during the read means these completions belong to the session being left; the
      // facade is reset by the switch, so dropping them (undelivered) is the whole cleanup.
      if (isStaleSession()) return {};
      if (completed.length > 0) {
        const ui = deps.getUIChannel();
        if (!ui) {
          // No channel: transient wire-only injection, with no durable copy behind it (and no
          // pointer either). Marking here is the deliberate best-effort for a channel-less caller;
          // callers that can lose a turn should provide a channel.
          await work.markDelivered(completed);
          messages = [...messages, { role: "user", content: formatNotifications(completed) }];
        } else {
          const injected = injectSyntheticMessages(
            messages,
            [{ kind: NOTIFICATION_KIND, content: formatNotifications(completed) }],
            { ui, persist: deps.persistMessages }
          );
          messages = injected.messages;
          await work.markDelivered(completed);
        }
      }

      // --- 2. Pointer (safety net): visible command jobs this wire does not announce yet ---
      if (!deps.getParentId()) {
        const announced = collectAnnouncedJobIds(messages);
        const section = await buildJobsSection(deps, messages, announced);
        // Same guard after the section build (it reads job state through the env).
        if (isStaleSession()) return messages === config.messages ? {} : { messages };
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

/**
 * The one notification format, for both kinds.
 *
 * The shared half is the headline (noun + id + status), the label-line prefix and the tool-call
 * binding; the source supplies `body` because only it knows what its result looks like (a command's
 * output tail and log path, a task's summary and status flags). The ids ride in the tag's `jobs`
 * attribute, machine-readable, so the pointer can tell "already announced" from "announcement
 * compacted away" without parsing the prose above.
 *
 * **No cap here, deliberately.** The body arrives already bounded by its SOURCE using the tool-output
 * contract (`maybeCacheOutput`: spill past the threshold, head+tail preview, `Full output saved to:
 * <path>`; a command keeps its durable `log:` line). Truncating again here cut a 2k–10k task summary
 * with no pointer at all — content lost, and nothing to read it back from — while the tool result of
 * the same call carried it whole. One owner for "how much text, and where the rest is".
 *
 * ONE id list for both kinds, because that attribute answers one question: "which of my background
 * work does this wire already announce?" The pointer only lists command jobs, so a task id in the set
 * is simply never looked up — but a second `tasks` attribute would be a field no reader has, i.e. a
 * promise that the notification carries something it does not.
 *
 * `Tool call:` is printed only when it differs from the headline id: a task's id IS its call id, while
 * a command's id is the `jobId` its tool result returned. Naming the call is what lets the model map
 * each unit in a multi-completion block back to the exact tool result that started it.
 */
export function formatNotifications(items: BackgroundWorkCompletion[]): string {
  const sections = items.map((item) => {
    const status = item.status === "exited" ? "completed" : item.status;
    // Only a command has an exit code; printing a task's `null` would read as a failed run.
    const exit = item.kind === COMMAND_JOB_KIND ? ` (exit code ${item.exitCode ?? "n/a"})` : "";
    const lines = [
      `${backgroundWorkNoun(item.kind)} ${item.id} finished with status ${status}${exit}.`,
      `${backgroundWorkLabelPrefix(item.kind)} ${item.label}`,
    ];
    if (item.toolCallId && item.toolCallId !== item.id) lines.push(`Tool call: ${item.toolCallId}`);
    if (item.body) lines.push(item.body);
    return lines.join("\n");
  });

  const announced = items.map((item) => item.id);
  return formatContextSectionUserContent({
    key: NOTIFICATION_KIND,
    content: formatSectionTag(NOTIFICATION_KIND, sections.join("\n\n")),
    attrs: { ...(announced.length > 0 ? { jobs: announced.join(",") } : {}) },
  });
}
