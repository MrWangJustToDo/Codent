import { createContext, useContext } from "react";

// ============================================================================
// Types
// ============================================================================

/**
 * The screen class that owns a keyboard handler.
 *
 * One surface is on screen at a time — `Agent` swaps whole screens (workspace / task / extension /
 * chat) and the config wizard and resume picker replace the chat screen entirely. The surface a
 * handler belongs to is therefore a property of *where it is rendered*, which is why it travels in
 * a context instead of being derived from a table of "which panel is open" flags.
 */
export type InputSurface = "main" | "workspace" | "task" | "extension";

// ============================================================================
// Context
// ============================================================================

/**
 * `null` outside any scope — a handler there subscribes nowhere and stays inert, which is the
 * point: forgetting the wrapper stops working instead of leaking into whatever screen is up.
 */
const InputScopeContext = createContext<InputSurface | null>(null);

export const InputScopeProvider = InputScopeContext.Provider;

export function useInputScope(): InputSurface | null {
  return useContext(InputScopeContext);
}
