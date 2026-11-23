/**
 * The output a tool call carries when an extension refused it (`tool:before:*` → `event.skip`).
 *
 * It is not any tool's output schema, so a per-tool formatter must never read it — the same rule
 * that governs the framework's synthetic cancel payload. `denied` is the marker; `cancelled` is
 * explicitly false so a cancelled row and a denied row stay distinguishable.
 */
export const DENIED_TOOL_MESSAGE = "Denied by an extension.";

/**
 * The exact keys a denial marker may carry.
 *
 * Same guard as {@link isSyntheticCancelOutput} / `isInterruptedToolOutput`: the marker is a
 * framework-synthesized payload, not a tool's output schema, so a tool that happens to return a
 * business field named `denied` must not be swallowed by the marker. Without this, a shape like
 * `{ denied: true, path: "a.txt", bytes: 12 }` was replaced wholesale with `Denied: …` on the
 * model wire, and the real result disappeared with no diagnostic.
 */
const DENIED_TOOL_KEYS = new Set(["success", "cancelled", "denied", "error"]);

export function isExtensionDeniedOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const record = output as Record<string, unknown>;
  if (record.denied !== true) return false;
  return Object.keys(record).every((key) => DENIED_TOOL_KEYS.has(key));
}

/** One line for a denied row: the extension's reason when it gave one. */
export function formatExtensionDeniedOutput(output: unknown): string {
  const reason = (output as { error?: unknown } | null)?.error;
  return typeof reason === "string" && reason.trim() ? `Denied: ${reason.trim()}` : DENIED_TOOL_MESSAGE;
}
