/**
 * A staleness check for work computed for a session that may be switched away before it is written.
 *
 * Session switching is two clean steps — unload, then load — and anything computed for the session
 * being unloaded is garbage: it is DISCARDED, never written into the target. Two facts are needed
 * because they cover different windows:
 *
 * - `isSwitching()` drops work that resolves **during** the transaction (the transcript is being
 *   replaced but the adoption has not run yet, so the generation has not moved);
 * - the UI channel's session generation drops work that resolves **after** the load committed —
 *   `isSwitching()` is false again by then, but the transcript the work was computed for is gone.
 *
 * A boolean sampled at write time alone is not enough for the second case, and the generation alone
 * is not enough for the first.
 */

import type { AgentUIChannel } from "../ui/ui-channel.js";

export function captureSessionStaleness(ui: AgentUIChannel | undefined, isSwitching?: () => boolean): () => boolean {
  const generation = ui?.getSessionGeneration();
  return () => {
    if (isSwitching?.() === true) return true;
    return generation !== undefined && ui !== undefined && ui.getSessionGeneration() !== generation;
  };
}
