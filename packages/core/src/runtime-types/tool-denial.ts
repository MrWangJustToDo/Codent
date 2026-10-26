/**
 * The output a tool call carries when an extension refused it (`tool:before:*` → `event.skip`).
 *
 * It is not any tool's output schema, so a per-tool formatter must never read it — the same rule
 * that governs the framework's synthetic cancel payload. `denied` is the marker; `cancelled` is
 * explicitly false so a cancelled row and a denied row stay distinguishable.
 */
export const DENIED_TOOL_MESSAGE = "Denied by an extension.";

export function isExtensionDeniedOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  return (output as { denied?: unknown }).denied === true;
}

/** One line for a denied row: the extension's reason when it gave one. */
export function formatExtensionDeniedOutput(output: unknown): string {
  const reason = (output as { error?: unknown } | null)?.error;
  return typeof reason === "string" && reason.trim() ? `Denied: ${reason.trim()}` : DENIED_TOOL_MESSAGE;
}
