import { isBuiltinToolName } from "../catalog/tool-names.js";

import { getBuiltinToolPresentation } from "./builtin.js";

import type { ToolPresentation } from "./types.js";

/**
 * Row-visibility rules — owned by core so every host folds a completed tool run the
 * same way.
 *
 * A completed call keeps its own row when the tool declares `keepRow` (structured or interactive
 * results) or when the host supplies the result (`clientSide`).
 *
 * A result renderer (`text`) is NOT a row policy by itself. For a tool the host does not own — an
 * extension tool — that string is its whole result, so folding it would hide the output; those keep
 * their row. A **built-in** declares `text` for the body full display shows (session pages, trees,
 * LSP results, memory entries); compact display is the density mode, so it folds that body like any
 * other. Conflating the two made every built-in with a nice one-liner permanently unfoldable —
 * `session_search`, `session_read`, `tree`, the whole LSP family and memory tools never folded.
 */
export function keepsCompactRow(
  name: string,
  resolve: (name: string) => ToolPresentation | undefined = getBuiltinToolPresentation,
  /**
   * Whether the LIVE registration is the seeded built-in.
   *
   * Defaults to the static name table for callers without a registry. A host passes the session's
   * `isBuiltinTool` so a tool that merely SHADOWS a built-in name is treated as the extension it
   * is — otherwise its `text` (its whole result) is folded away in compact mode.
   */
  isBuiltin: (name: string) => boolean = isBuiltinToolName
): boolean {
  const present = resolve(name);
  if (present?.keepRow || present?.clientSide) return true;
  // An extension tool's `text` is its only output; a built-in's body is a full-display nicety.
  return Boolean(present?.text) && !isBuiltin(name);
}
