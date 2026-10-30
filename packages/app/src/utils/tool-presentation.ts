/**
 * Session-scoped tool presentation.
 *
 * A remote session's descriptors arrive with its snapshot/SSE payload and live on that
 * `AgentSession`; they are not process-global knowledge. The built-in table remains the
 * last-resort fallback for names the owning session never described.
 */

import { getBuiltinToolPresentation, isBuiltinToolName, keepsCompactRow as coreKeepsCompactRow } from "@codent/core";

import { getActiveSession } from "./session-resolve.js";

import type { ToolPresentation } from "@codent/core";

export function resolveToolPresentation(name: string): ToolPresentation | undefined {
  const session = getActiveSession();
  // A bound session is authoritative: its resolver already falls back to the built-in table for the
  // tools it was seeded with, and answers `undefined` for a tool that merely SHADOWS a built-in name
  // without declaring a presentation. A second fallback here handed that descriptor back — the
  // display/policy decision core had just refused to make.
  if (session?.getToolPresentation) return session.getToolPresentation(name);
  // No session yet (the first frame before bootstrap): the static table is the only source.
  return getBuiltinToolPresentation(name);
}

/**
 * Whether the live tool under `name` is the built-in implementation.
 *
 * `true` when we cannot tell — no session yet, or a remote publisher that predates
 * `ToolPresentationInfo.origin`. The built-in renderers are the right default then; a shadowing
 * extension tool simply keeps the pre-existing rendering.
 */
export function isBuiltinTool(name: string): boolean {
  return getActiveSession()?.isBuiltinTool?.(name) ?? true;
}

/**
 * Identity for ROW RETENTION (compact fold), where "unknown" means "the static name table".
 *
 * Different default from {@link isBuiltinTool} on purpose: that one answers "may a built-in-only
 * renderer run?", where an unknown name keeps the built-in rendering. Here the question is "is this
 * an extension whose `text` is its whole result?", and an unregistered name that is not in the
 * static table is exactly such an extension — collapsing it to `true` folded the very rows this
 * policy exists to keep.
 */
export function isBuiltinToolForRow(name: string): boolean {
  const session = getActiveSession();
  // A live extension registration (including a shadow of a built-in name) is the answer, whatever
  // the name looks like.
  if (session?.isBuiltinTool && !session.isBuiltinTool(name)) return false;
  // A live built-in is described by the session (the table covers incumbents).
  if (session?.getToolPresentation?.(name)) return true;
  // Unknown (no session, no descriptor, not registered): the static table is the pre-`origin` rule.
  return isBuiltinToolName(name);
}

export function keepsCompactRow(name: string): boolean {
  return coreKeepsCompactRow(name, resolveToolPresentation, isBuiltinToolForRow);
}
