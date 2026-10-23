import { useSurfaceInput } from "./use-surface-input.js";

import type { InputHandler } from "./use-surface-input.js";

/**
 * The task panel's keyboard: subagent list navigation, and the detail view's `Esc` / `x`.
 *
 * The list and the detail view are one sub-surface each (`view === "list"` / `"detail"`), so a key
 * cannot move the list cursor while the detail is on screen.
 */
export function useTaskPanelInput(handler: InputHandler, options?: { when?: boolean }): void {
  useSurfaceInput("task", handler, options);
}
