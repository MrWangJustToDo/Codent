/**
 * The one "background work" contract both sources implement.
 *
 * Two things in this repo run past the turn that started them — a `run_in_background` command and a
 * `run_in_background` task — and they are *not* the same machine: a command is a process with a
 * durable record, a log file and incremental poll cursors, while a task is an in-memory subagent run
 * with a concurrency window and an abort surface. Trying to share the state would be a leaky
 * abstraction, so this module shares what is genuinely common and nothing more:
 *
 * | shared | why it is safe to share |
 * |---|---|
 * | the row view (`SessionJobSummary`) and its status vocabulary | one footer line, one channel, one snapshot — see `agent/jobs/extension.ts` |
 * | the owner predicate (`isVisibleToSession`) | both sides must disappear from the *other* session's surfaces, for the same reason |
 * | the completion queue shape (`BackgroundWorkCompletion`) | one notification block, one formatter, one "delivered" transition |
 * | the trigger points (`publish` / `reset` / `destroy`) | the owning agent has exactly one of each |
 *
 * Everything else stays with the source. A source never emits events, never wakes the agent and never
 * writes to the channel: it reports a change through {@link BackgroundWorkSource.setChangeSink}, and
 * `managers/services/background-work-service.ts` decides what that means. That split is what keeps
 * the "only one implementation of collect/mark/publish" invariant checkable.
 *
 * Where the pieces live — one row per role, so "which file owns this?" has one answer:
 *
 * | role | file |
 * |---|---|
 * | the contract (this file) | `agent/jobs/background-work.ts` |
 * | the footer line for both kinds | `agent/jobs/extension.ts` |
 * | the facade (merge, closing window, delivery framing) | `managers/services/background-work-service.ts` |
 * | the command source (a SERVICE: tools need start/poll/kill + the durable record) | `managers/services/agent-command-service.ts` |
 * | the task source (a PROJECTION: the ledger already exists) | `agent/subagent/task-work-source.ts` |
 * | a background task's run lifecycle (settle, repair, restore) | `agent/subagent/task-background.ts` |
 */

import type { BackgroundJobKind, SessionJobStatus, SessionJobSummary } from "../../runtime-types/session-payloads.js";

// ============================================================================
// Row view
// ============================================================================

/**
 * The two kinds, written once.
 *
 * `"task"` is also a built-in TOOL name, and `validate:builtin-tool-names` refuses a bare literal in
 * an identity position — correctly, because a tool rename must not leave a stale copy behind. These
 * constants keep the collision honest: they name the *job kind* (what a row of background work is),
 * not the tool, and every comparison imports them instead of re-spelling the word.
 */
export const COMMAND_JOB_KIND = "command";
export const TASK_JOB_KIND = "task";

/**
 * Why a promptless turn exists (`run:wake`), as one union with one definition.
 *
 * The wrinkle is the vocabulary, not the plumbing: a *command* job is reported as `job` here (the
 * older word the log already used), while a task is `task`. Mixed completions report `job` — the
 * cause is diagnostic attribution, and "both kinds finished" has no better single word.
 */
export type BackgroundWakeCause = "job" | "task";

/** One row of the merged `session:jobs` snapshot (same shape for every kind). */
export type BackgroundWorkRow = SessionJobSummary;

/** Terminal statuses only — what a completion can actually be. */
export type BackgroundWorkTerminalStatus = Exclude<SessionJobStatus, "running">;

/**
 * Why a background unit ended when it did not finish on its own: the session that owned it was
 * closed (unload, `/new`, `/resume`, process exit).
 *
 * ONE wording for both kinds and for both surfaces that report it — the restored command job's
 * status/body and the interrupted task handle. The distinction that matters to the model is
 * "nobody cancelled this, the session ended", which is why neither side may fall back to the shared
 * `TOOL_CANCELLED_MESSAGE` ("Cancelled by user.").
 */
export const SESSION_END_CANCELLED_MESSAGE = "Cancelled because the session ended.";

/**
 * One finished, not-yet-delivered unit.
 *
 * `body` is source-rendered because only the source knows what its result looks like (a command's
 * output tail and log path; a task's summary and status flags) — including how much of it to keep
 * inline and which durable path replaces the cut (see {@link BackgroundWorkCompletion.body}). The
 * shared half is everything around it: the headline (`<noun> <id> finished with status …`), the label
 * line, the tool-call binding and the delivered flag. Rendering the whole block per source would give
 * two notification formats that drift; rendering none would leak one kind's vocabulary into the other.
 */
export interface BackgroundWorkCompletion {
  /** Id of the unit that finished (command job id / task run id). */
  id: string;
  kind: BackgroundJobKind;
  /**
   * The tool call that started it, when that is a different identifier.
   *
   * A task's id IS its tool call id, so it needs no extra line. A command's id is the `jobId` its
   * tool result returned — naming the call as well is what lets the model map a notification back to
   * the exact tool result when several background units finish in one block.
   */
  toolCallId?: string;
  /** Human label: the command line, or the task's description / prompt first line. */
  label: string;
  status: BackgroundWorkTerminalStatus;
  /** `null` when the kind has no exit code (a task) or the code is unknown (signalled). */
  exitCode: number | null;
  /**
   * Source-rendered detail block, already bounded BY THE SOURCE.
   *
   * Same contract as a tool result: keep the inline copy small and always name the durable one — the
   * task uses `maybeCacheOutput` (spill past the threshold, head+tail preview, `Full output saved to:
   * <path>`), the command keeps a tail per stream plus its durable `log:` line. The shared renderer
   * deliberately applies NO further cap: a second cut cannot know where the pointer is, and it was
   * silently dropping 2k–10k task summaries that had no path to read them back from.
   */
  body: string;
}

/** Change notification a source pushes: which ids reached a terminal state in THIS transition. */
export type BackgroundWorkChangeSink = (finished: readonly string[]) => void;

/**
 * One source of background work.
 *
 * Deliberately thin: six methods, no shared state, no event bus. A source that needs more than this
 * is telling you the two kinds have diverged — which is a design decision to make in the open, not
 * something to hide behind a wider port.
 */
export interface BackgroundWorkSource {
  readonly kind: BackgroundJobKind;
  /** Rows visible to the current session, in source order. */
  list(): BackgroundWorkRow[];
  /** Finished-but-undelivered units for the current session (peek — never marks). */
  pending(): Promise<BackgroundWorkCompletion[]>;
  /** Record completions as delivered (after the notification is persisted). */
  markDelivered(completions: readonly BackgroundWorkCompletion[]): void | Promise<void>;
  /** Session switch / new: drop this session's rows and pending queue. */
  reset(reason: string): void | Promise<void>;
  /** Agent destroy: release everything held for this source. */
  destroy(): void | Promise<void>;
  /** Register the change sink (the facade owns what a change means). */
  setChangeSink(sink: BackgroundWorkChangeSink | null): void;
}

// ============================================================================
// Shared rules
// ============================================================================

/**
 * Whether a row owned by `ownerSessionId` belongs on the surfaces of `currentSessionId`.
 *
 * Both sources must answer this the same way, and both must let an unowned row through: the ambient
 * / standalone path has no session id, and dropping every row there would make the footer empty in
 * exactly the environments that cannot restore anything anyway.
 *
 * A row owned by *another* session is not "hidden for tidiness" — this session's model can never be
 * handed its completion (`pending()` filters the same way), so showing it would be a row whose
 * `pendingPickup` could never clear.
 */
export function isVisibleToSession(ownerSessionId: string | undefined, currentSessionId: string | undefined): boolean {
  return !ownerSessionId || !currentSessionId || ownerSessionId === currentSessionId;
}

/**
 * The kind an event payload or a stored row names, defaulting to `command`.
 *
 * Event payloads reach a log/projection as `unknown` (they cross a process boundary as JSON), so the
 * read needs one place to answer "which kind is this?" — a second inline ternary per consumer is how
 * "Job" once got printed for a task row.
 */
export function backgroundWorkKind(value: unknown): BackgroundJobKind {
  return value === TASK_JOB_KIND ? TASK_JOB_KIND : COMMAND_JOB_KIND;
}

/** The wake cause a set of just-finished ids names, from the rows that carry their kind. */
export function backgroundWakeCause(
  rows: readonly BackgroundWorkRow[],
  finished: readonly string[]
): BackgroundWakeCause {
  if (finished.length === 0) return "job";
  const finishedIds = new Set(finished);
  const ended = rows.filter((row) => finishedIds.has(row.jobId));
  return ended.length > 0 && ended.every((row) => row.kind === TASK_JOB_KIND) ? "task" : "job";
}

/**
 * Narrow a settled row's status to the terminal vocabulary a completion uses.
 *
 * `running` must never reach a completion. Both sources can still produce one — a snapshot taken
 * mid-flight, or a run that ended without reporting a state — and calling that `exited` would claim
 * work the same result's own status flags deny. One rule, both kinds, so the two notifications cannot
 * word the same non-finish differently.
 */
export function settledTerminalStatus(status: SessionJobStatus): BackgroundWorkTerminalStatus {
  return status === "running" ? "failed" : status;
}

/**
 * The label-line prefix for a kind, in one place so the two notifications read as one format.
 */
export function backgroundWorkLabelPrefix(kind: BackgroundJobKind): string {
  return kind === TASK_JOB_KIND ? "Task:" : "Command:";
}

/** The noun a notification and a log row use for a kind. */
export function backgroundWorkNoun(kind: BackgroundJobKind): "Job" | "Task" {
  return kind === TASK_JOB_KIND ? "Task" : "Job";
}
