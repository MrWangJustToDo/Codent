import { createContext, useContext } from "react";

import type { AgentAdapter } from "../adapter/types.js";

const AdapterContext = createContext<AgentAdapter | null>(null);

export const AdapterProvider = AdapterContext.Provider;

export function useAdapter(): AgentAdapter {
  const adapter = useContext(AdapterContext);
  if (!adapter) {
    throw new Error("useAdapter must be used within an <AdapterProvider>");
  }
  return adapter;
}

/**
 * The adapter when a host is mounted, `null` otherwise.
 *
 * For a screen that touches only an OPTIONAL host capability and must still render without a host —
 * the workspace panel's editor handoff is the case: its validator and the render smoke mount the
 * panel bare. Throwing there (`useAdapter`) turns a missing *optional* capability into a blank
 * screen, which is the opposite of the graceful degradation the optional method is for.
 */
export function useOptionalAdapter(): AgentAdapter | null {
  return useContext(AdapterContext);
}
