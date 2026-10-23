import { useSurfaceInput } from "./use-surface-input.js";

import type { InputHandler } from "./use-surface-input.js";

/** The extension panel's keyboard: list navigation, toggle, close. One sub-surface, no `when`. */
export function useExtensionPanelInput(handler: InputHandler, options?: { when?: boolean }): void {
  useSurfaceInput("extension", handler, options);
}
