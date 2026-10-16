import { isAbortError, isCancelledOutputMarker } from "../../../runtime-types/abort.js";

import type { ImagePart, ToolCallPart, ToolCallState } from "@tanstack/ai";

// Re-exported for this module's public-API consumers (`index.ts`). The definition stays in
// `agent/stream/message-parts.ts` — the shared UIMessage-predicate layer — so the two copies that
// had drifted apart (`null`-safe there, non-null-only here) are now one.
export { isToolCallPart } from "../../stream/message-parts.js";

/** UI-facing tool state labels (terminal rendering). */
export type UiToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | "output-denied"
  | "approval-requested"
  | "approval-responded";

export function isImagePart(part: { type?: string } | null | undefined): part is ImagePart {
  return part != null && part.type === "image";
}

/**
 * Whether this settled part represents a run the USER cut short, not a tool failure.
 *
 * Two shapes exist because two layers settle aborts:
 *
 *  - `output.cancelled === true` — a tool that caught its own abort and returned a normal
 *    result (`run_command`); deeper still, the framework fallback
 *    (`cancelInFlightToolCalls` / `cancelIncompleteToolCalls`) writes the same marker for a
 *    call that never settled at all.
 *  - `output.aborted === true` — the `task` tool, which catches its subagent's cancellation
 *    and appends a notice naming *why* it stopped (`[Task cancelled by user.]`,
 *    `[Task stopped with its parent run.]`, `[Task stopped with its parent agent.]`), so the
 *    parent model learns of the stop and its cause.
 *
 * The distinction matters to every consumer that renders a settled row: the two shapes settle
 * on opposite states (one `output-error`, one `output-available`), so a row the user cancelled
 * would otherwise wear the failure cross or the success check. This delegates to
 * {@link isCancelledOutputMarker} so the marker shapes live in one place.
 *
 * The second shape is the one a marker alone misses. On abort the eager pass writes the
 * synthetic marker, and then the tool's own `execute` may REJECT with the abort error — TanStack
 * catches that and settles the same part as `{ error: message }`, which carries no marker and
 * OVERWRITES the synthetic one. Reading only the marker then showed a red ✗ for a run the user
 * stopped. So an `output-error` body that is itself an abort also reads as cancelled: the abort
 * reach the tool as an error is exactly what `isAbortError` recognizes, whatever shape it took
 * (a rejected fetch, an `ExecutionError(\"aborted\")`, an extension rethrowing the signal's
 * reason). No signal is passed — this only ever sees the error's shape.
 */
export function isCancelledToolCall(part: ToolCallPart | { output?: unknown }): boolean {
  if (isCancelledOutputMarker(part?.output)) return true;
  const output = part?.output as { error?: unknown } | undefined;
  return typeof output?.error === "string" && isAbortError(new Error(output.error));
}

export function parseToolInput(part: { arguments?: string }): unknown {
  if (!part.arguments) return undefined;
  try {
    return JSON.parse(part.arguments) as unknown;
  } catch {
    return part.arguments;
  }
}

export function getUiToolState(part: ToolCallPart): UiToolState {
  if (part.approval?.needsApproval && part.approval.approved === undefined) {
    return "approval-requested";
  }
  if (part.approval?.approved === false) {
    return "output-denied";
  }

  // Output means the tool finished — don't keep showing the executing spinner.
  if (part.output !== undefined) {
    if (part.state === "error") return "output-error";
    const failed =
      typeof part.output === "object" &&
      part.output !== null &&
      (part.output as { success?: boolean }).success === false;
    return failed ? "output-error" : "output-available";
  }

  if (part.approval?.approved === true && part.state !== "complete" && part.state !== "error") {
    return "approval-responded";
  }

  return mapTanStackState(part.state, part.output);
}

export function isPendingToolApproval(part: ToolCallPart): boolean {
  return getUiToolState(part) === "approval-requested";
}

function mapTanStackState(state: ToolCallState, output: unknown): UiToolState {
  switch (state) {
    case "awaiting-input":
      return "input-available";
    case "input-streaming":
      return "input-streaming";
    case "input-complete":
      return output !== undefined ? "output-available" : "input-available";
    case "approval-requested":
      return "approval-requested";
    case "approval-responded":
      return "approval-responded";
    case "complete":
      return "output-available";
    case "error":
      return "output-error";
    default:
      return "input-available";
  }
}

export function isToolExecuting(part: ToolCallPart): boolean {
  const state = getUiToolState(part);
  return state === "input-available" || state === "input-streaming" || state === "approval-responded";
}
