import { exitWithSummary } from "../utils/exit-with-summary.js";
import { getActiveHost, getActiveSession } from "../utils/session-resolve.js";

import { useExitInput } from "./input";

import type { AgentAdapter } from "../adapter/types.js";

/**
 * Ctrl+C — quit from any screen.
 *
 * Called by `Agent` before its early returns, so it is registered on the chat, the three panels,
 * the config wizard and the resume picker alike. The chat's own handler (`keybindings/global.ts`)
 * deliberately no longer answers Ctrl+C: the renderer broadcasts to every subscribed handler, so
 * two owners would print the exit summary twice.
 */
export function useExitKeybinding(adapter: AgentAdapter): void {
  useExitInput((inputChar, inputKey) => {
    if (!inputKey.ctrl || inputChar !== "c") return;
    exitWithSummary({
      adapter,
      session: getActiveSession(),
      destroySession: (sessionId) => void getActiveHost()?.destroy(sessionId),
    });
  });
}
