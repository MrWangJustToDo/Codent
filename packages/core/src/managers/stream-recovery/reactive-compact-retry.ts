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
 * Finalize a successful reactive-compact retry: clear the surfaced stream error.
 *
 * The compaction itself (summary + tail) already ran inside
 * {@link ManagedAgent.handleReactiveCompact}, whose own `finally` ends its lease (and whose
 * `finish` already restored the status as part of the terminal outcome). This only unwinds the
 * retry-scoped error so the restarted stream starts clean.
 *
 * The status closure deliberately lives in the producer (`handleManagedReactiveCompact`), not
 * here: a lease-blind `compacting → running` reset at this point could overwrite a compaction
 * that legitimately claimed ownership during the retry shell.
 */
async function finalizeReactiveCompactRetry(managed: ManagedAgent): Promise<boolean> {
  if (!managed.getUI()) return false;
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
