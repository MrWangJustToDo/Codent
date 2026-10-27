/**
 * Framework-produced tool-result shapes that are NOT any tool's schema.
 *
 * TanStack settles a server tool that throws as `{ error: string }`, and marks an
 * approved-but-not-yet-executed call with `{ pendingExecution: true }`. Both are shared across
 * every tool, so a per-tool formatter or projection that reads its own schema from them reports
 * the wrong thing (`write_file` printed "Overwrote file: undefined", `todo` threw on
 * `stats.total`). The predicates live here — in the low-level `runtime-types` layer — so the
 * model-facing path (`compaction/tool-compact`) and the UI-facing path (`tools/presentation`)
 * answer the question the same way instead of each growing its own copy.
 */

/** TanStack approval continuation marker — tool is approved but not executed yet. */
export function isPendingToolExecutionResult(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  return (output as Record<string, unknown>).pendingExecution === true;
}

/** TanStack `output-error` tool results — `{ error: string }` from server execution. */
export function isToolErrorResult(output: unknown): boolean {
  if (isPendingToolExecutionResult(output)) return false;

  if (output && typeof output === "object" && "error" in output) {
    const error = (output as Record<string, unknown>).error;
    return typeof error === "string" && error.length > 0;
  }

  if (typeof output === "string") {
    return output.startsWith("Error executing tool:");
  }

  return false;
}

/**
 * A framework `{ error }` result with no other fields — the shape the UI path may treat as
 * "nothing to render".
 *
 * `isToolErrorResult` is shape-only because the model path needs it for any error-looking value.
 * The UI must be stricter: an MCP or extension tool may legitimately return structured data that
 * contains an `error` field alongside the real payload, and blanking it would hide the result.
 */
export function isBareToolErrorResult(output: unknown): boolean {
  if (!isToolErrorResult(output)) return false;
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  return Object.keys(output).length === 1;
}

/** Extract a human-readable error message from a tool error payload. */
export function extractToolErrorMessage(output: unknown): string {
  if (output && typeof output === "object" && "error" in output) {
    const error = (output as Record<string, unknown>).error;
    if (typeof error === "string" && error.length > 0) return error;
  }

  if (typeof output === "string") {
    if (output.startsWith("Error executing tool:")) {
      return output.slice("Error executing tool:".length).trim();
    }
    return output;
  }

  return "Tool execution failed";
}
