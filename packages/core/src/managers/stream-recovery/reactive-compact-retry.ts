/**
 * Reactive compact retry orchestration — the emergency-compaction retry shell
 * that delegates to the core implementation in `agent/compaction/reactive-compact.ts`.
 *
 * Kept as a separate file (distinct name from the core implementation) so
 * "reactive-compact" unambiguously refers to the compaction layer.
 */
import { isPromptTooLongError } from "../../agent/compaction/reactive-compact.js";

import type { AgentManager } from "../agent-manager.js";
import type { ManagedAgent } from "../managed-agent.js";

/**
 * Finalize a successful reactive-compact retry: clear the compacting status
 * and the surfaced stream error. The compaction itself (summary + tail + archive)
 * already ran inside {@link ManagedAgent.handleReactiveCompact} — this only
 * unwinds the retry-scoped state so the restarted stream starts clean.
 */
async function finalizeReactiveCompactRetry(managed: ManagedAgent): Promise<boolean> {
  if (!managed.getUI()) return false;
  managed.compactions.settle();
  managed.setError("");
  return true;
}

/**
 * Attempt emergency compaction when the model rejects the request as too long.
 * Subagents (parentId set) never retry via this path.
 */
export async function tryReactiveCompactRetry(
  managed: ManagedAgent,
  manager: AgentManager,
  error: unknown
): Promise<boolean> {
  if (managed.parentId) return false;
  if (!isPromptTooLongError(error)) return false;

  const compacted = await managed.handleReactiveCompact(error, manager);
  if (!compacted) return false;

  return finalizeReactiveCompactRetry(managed);
}
