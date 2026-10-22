/**
 * The curated built-in subset that code mode exposes inside the sandbox.
 *
 * `agent-bootstrap` used to write these as two string literals. That made renaming a built-in a
 * two-place edit — the registry (`BUILTIN_TOOL_NAMES`) and the literal list — with nothing failing
 * if only one moved: the names are looked up in `managed.tools`, so a stale entry silently drops
 * the tool from the sandbox (`.filter(Boolean)` swallows it), and a name that no longer exists
 * anywhere is indistinguishable from a host that does not build it.
 *
 * Deriving both lists from the registry makes the rename a core-only edit, which is the same
 * invariant hosts get from `BUILTIN_TOOL_NAMES`.
 *
 * Two lists, because "exposed" and "documented in full" are separate decisions: every name below
 * is callable as `external_<name>`, while the lazy ones stay out of the system prompt's type stubs
 * and appear in the `discover_tools` catalog instead (their signatures are verbose and rarely
 * previewed).
 */

import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";

/**
 * Built-ins available as `external_*` bindings inside the sandbox.
 *
 * Filesystem/read tools are eager: a script that inspects the workspace is the common case, so
 * their stubs pay for themselves. Order is prompt-facing (stub order follows it).
 */
export const CODE_MODE_TOOL_NAMES = [
  BUILTIN_TOOL_NAMES.readFile,
  BUILTIN_TOOL_NAMES.grep,
  BUILTIN_TOOL_NAMES.glob,
  BUILTIN_TOOL_NAMES.listFile,
  BUILTIN_TOOL_NAMES.tree,
  BUILTIN_TOOL_NAMES.runCommand,
  BUILTIN_TOOL_NAMES.websearch,
] as const;

/** A built-in code mode may expose. */
export type CodeModeToolName = (typeof CODE_MODE_TOOL_NAMES)[number];

/**
 * The subset kept out of the full type-stub documentation (discoverable on demand).
 *
 * `satisfies` is the invariant, not decoration: a name that is not in
 * {@link CODE_MODE_TOOL_NAMES} would be marked lazy on a tool the sandbox never receives, so the
 * prompt would advertise a catalog entry nothing can call.
 */
export const CODE_MODE_LAZY_TOOL_NAMES = [
  BUILTIN_TOOL_NAMES.runCommand,
  BUILTIN_TOOL_NAMES.websearch,
] as const satisfies readonly CodeModeToolName[];
