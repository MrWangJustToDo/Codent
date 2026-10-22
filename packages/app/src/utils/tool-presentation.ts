/**
 * Session-scoped tool presentation.
 *
 * A remote session's descriptors arrive with its snapshot/SSE payload and live on that
 * `AgentSession`; they are not process-global knowledge. The built-in table remains the
 * last-resort fallback for names the owning session never described.
 */

import { getBuiltinToolPresentation, keepsCompactRow as coreKeepsCompactRow } from "@codent/core";

import { getActiveSession } from "./session-resolve.js";

import type { ToolPresentation } from "@codent/core";

export function resolveToolPresentation(name: string): ToolPresentation | undefined {
  return getActiveSession()?.getToolPresentation?.(name) ?? getBuiltinToolPresentation(name);
}

export function keepsCompactRow(name: string): boolean {
  return coreKeepsCompactRow(name, resolveToolPresentation);
}
