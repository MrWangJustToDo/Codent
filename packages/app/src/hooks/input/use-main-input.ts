import { useSurfaceInput } from "./use-surface-input.js";

import type { InputHandler } from "./use-surface-input.js";

/**
 * The chat screen's keyboard: panel toggles, the input itself, approvals, `ask_user` answers.
 *
 * The config wizard and the resume picker use this too — while they are up they *are* the main
 * screen (the chat is not mounted), so they cannot collide with its mode handlers.
 */
export function useMainInput(handler: InputHandler, options?: { when?: boolean }): void {
  useSurfaceInput("main", handler, options);
}
