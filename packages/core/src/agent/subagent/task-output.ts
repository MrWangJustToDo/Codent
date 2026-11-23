/**
 * What a `task` result looks like once a run has settled — built in ONE place.
 *
 * Both delivery paths need the same shape: the blocking `execute` (which returns it as the tool
 * result) and the background settle handler (which writes it into the tool part after the fact). The
 * disk-cache preview (`maybeCacheOutput`) must run exactly once per call, and the two paths must not
 * disagree about `truncated` / `cachedOutputPath` / the status flags — that divergence is what this
 * module exists to prevent.
 *
 * `taskOutputSchema` stays in `task-tool.ts`: several validators read that file's source, and the
 * schema is the tool's own contract. This module borrows only the type.
 */

import { errorMessage } from "../../utils/errors.js";
import { sliceAtCodePoint } from "../../utils/text-truncation.js";
import { maybeCacheOutput } from "../tools/shared/cache/tool-output-cache.js";

import type { TaskOutput } from "./task-tool.js";
import type { SubagentResult } from "./types.js";
import type { ResolvedCoreEnv } from "../../env";

/** A zeroed usage record, so a `running` handle still satisfies the output schema. */
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0, billedInputTokens: 0 };

/**
 * The handle `execute` returns immediately for a background task.
 *
 * Every scored field is zero/empty on purpose: the shape is `TaskOutput`, so a host that renders a
 * restored row or a stale part keeps working, and `status: "running"` is the one field that says
 * "this is not the result yet". Mirrors `run_command`'s background branch, which returns
 * `exitCode: -1` + `status: "running"` for the same reason.
 *
 * `subagentId` is empty while the run is still queued: the child does not exist until a concurrency
 * slot admits it, and inventing an id would make the row point at nothing.
 */
export function runningTaskOutput(): TaskOutput {
  return {
    subagentId: "",
    summary: "",
    truncated: false,
    iterations: 0,
    maxIterations: 0,
    durationMs: 0,
    usage: { ...ZERO_USAGE },
    reachedLimit: false,
    incomplete: false,
    aborted: false,
    cachedOutputPath: null,
    status: "running",
    runInBackground: true,
  } as TaskOutput;
}

/** Whether this output is a background start handle rather than a finished result. */
export function isRunningTaskOutput(output: unknown): output is TaskOutput {
  return typeof output === "object" && output !== null && (output as { status?: unknown }).status === "running";
}

/** The exact keys {@link interruptedTaskOutput} produces — the marker, not any settled task result. */
const RESTORE_INTERRUPTED_TASK_KEYS = new Set([
  "subagentId",
  "summary",
  "truncated",
  "iterations",
  "maxIterations",
  "durationMs",
  "usage",
  "reachedLimit",
  "incomplete",
  "aborted",
  "cachedOutputPath",
  "status",
  "runInBackground",
]);

/**
 * Whether this output is the cancel marker a RESTORE wrote for a task whose session ended.
 *
 * A settled ledger row is authoritative over it: the marker says "we never learned the result",
 * which stops being true when the row is still in memory (a same-session resume). The key set is
 * exclusive, the same guard `isSyntheticCancelOutput` / `isInterruptedToolOutput` use, so an
 * extension or tool output that happens to carry `aborted: true` is not mistaken for the marker.
 */
export function isRestoreInterruptedTaskOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const record = output as Record<string, unknown>;
  if (record.status !== "completed" || record.aborted !== true || record.incomplete !== true) return false;
  return Object.keys(record).every((key) => RESTORE_INTERRUPTED_TASK_KEYS.has(key));
}

/**
 * The output for a background task that never produced a summary (spawn or run error).
 *
 * Still a finished result shape (`status: "completed"`, `incomplete: true`), because the alternative —
 * leaving the part on the running handle — would render as live forever: the row's liveness reads
 * `status: "running"` (see the app's `isTaskRowLive`), and nothing else would ever rewrite it.
 */
export function failedTaskOutput(message: string): TaskOutput {
  return {
    ...runningTaskOutput(),
    summary: message,
    incomplete: true,
    status: "completed",
  } as TaskOutput;
}

/**
 * The output for a background task whose session ended before it could finish.
 *
 * Shaped like a real result (`status: "completed"`) rather than the framework's shared cancel marker,
 * because this output is read by the task's OWN `toModelOutput` — the marker has none of these fields
 * and would put `undefined` on the wire. `aborted` is the cancel, `incomplete` says the run did not
 * produce its own report, and the summary carries the one reason both the row and the model see.
 */
export function interruptedTaskOutput(reason: string): TaskOutput {
  return {
    ...runningTaskOutput(),
    summary: reason,
    status: "completed",
    aborted: true,
    incomplete: true,
  } as TaskOutput;
}

/**
 * How much of a report is shown inline when the spill file could not be written.
 *
 * The report is NOT discarded (that was the bug), but it also must not be dropped into the model
 * context whole: this path only runs because the text exceeded the cache threshold (10 KB), and
 * without a file there is no way to read the rest back. Head + tail + an explicit marker is the same
 * shape the cached preview has, minus the path it cannot offer.
 */
const UNCACHED_FALLBACK_CHARS = 4_000;

function boundedInlineFallback(text: string): string {
  if (text.length <= UNCACHED_FALLBACK_CHARS) return text;
  const half = Math.floor(UNCACHED_FALLBACK_CHARS / 2);
  const head = sliceAtCodePoint(text, half);
  // The tail can start ON a low surrogate just as easily as the head can end on a high one: starting
  // one unit later keeps the pair whole instead of emitting its second half alone.
  let tailStart = text.length - half;
  if (tailStart > 0 && text.charCodeAt(tailStart) >= 0xdc00 && text.charCodeAt(tailStart) <= 0xdfff) tailStart += 1;
  const tail = text.slice(tailStart);
  return `${head}\n\n[... ${text.length - head.length - tail.length} chars omitted — the full report was not stored ...]\n\n${tail}`;
}

/**
 * Build the settled output for one task call.
 *
 * Large summaries are previewed for the parent context while the full text stays on disk. `truncated`
 * is NOT flipped here — that flag means `maxOutputLength` cut the summary, which is a different fact
 * from "the disk cache holds a preview".
 *
 * `runInBackground` is a property of the CALL (the phase that produced this result), which is why the
 * background settle has to pass it: dropping it left the settled row claiming to be a blocking call,
 * contradicting the handle it replaced.
 */
export async function buildTaskOutput(
  coreEnv: ResolvedCoreEnv,
  toolCallId: string,
  result: SubagentResult,
  options: { runInBackground?: boolean } = {}
): Promise<TaskOutput> {
  // `failClosed` is right for the ADVERTISING contract (a preview promises "full output at <path>"),
  // but letting it throw dropped a report the child had already produced: the blocking `task` call
  // had no catch, so a read-only workspace / sandboxed `.agents/cache` / remote fs error turned a
  // SUCCESSFUL delegation into a bare tool error. Every other tool degrades to the uncached content;
  // here that means "no path to advertise" and the full text in the result.
  let cached: { content: string; cachedOutputPath: string | null };
  try {
    cached = await maybeCacheOutput(coreEnv, result.output, `${toolCallId}-task`, { failClosed: true });
  } catch (error) {
    cached = {
      content: `${boundedInlineFallback(result.output)}\n\n[output cache unavailable — ${errorMessage(error)}]`,
      cachedOutputPath: null,
    };
  }
  return {
    subagentId: result.subagentId,
    ...(result.profile ? { profile: result.profile } : {}),
    summary: cached.content,
    truncated: result.truncated,
    iterations: result.iterations,
    maxIterations: result.maxIterations,
    durationMs: result.durationMs,
    usage: result.usage,
    reachedLimit: result.reachedLimit,
    incomplete: result.incomplete,
    aborted: result.aborted,
    ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    cachedOutputPath: cached.cachedOutputPath,
    status: "completed",
    ...(options.runInBackground ? { runInBackground: true } : {}),
  } as TaskOutput;
}

/**
 * The model-facing text of a settled task: the summary plus the status flags.
 *
 * One definition for two callers — `toModelOutput` (the tool-result position) and the background
 * completion notification (`body`). They carry the same content deliberately: the notification is the
 * copy that survives a compaction that dropped the tool call, and the tool result is the copy a later
 * turn reads in its natural position.
 */
export function formatTaskModelText(output: TaskOutput): string {
  // `truncated` is NOT here: the task tool runs with `SUBAGENT_NO_TRUNCATE`, so it is always false,
  // while the summary the model actually receives may still be a cached PREVIEW. Listing a dead flag
  // beside the live ones invited a model to read `truncated=false` as "complete".
  const status = [
    `reachedLimit=${output.reachedLimit}`,
    `incomplete=${output.incomplete}`,
    `aborted=${output.aborted}`,
    ...(output.stopReason ? [`stopReason=${output.stopReason}`] : []),
  ].join(" ");
  return `${output.summary}\n\n[task status: ${status}]`;
}

/**
 * The model-facing text of a background start handle: what happened, and that nothing must poll.
 *
 * No child id: the run may still be queued behind the concurrency window (a child exists only once a
 * slot admits it), so an id here would either be empty or name a run the model cannot act on — there
 * is no get/kill tool for a task, and its completion is pushed rather than polled.
 */
export function formatRunningTaskText(): string {
  return [
    "Started background task; it is running while this turn continues.",
    "Do not poll or wait for it: when it finishes the result is pushed back to you as a completion",
    "notification (an idle session is woken for it), and the task row in the transcript is updated with",
    "the summary at the same time.",
    "There is no get/kill tool for a task — a background task ends with its session.",
  ].join(" ");
}
