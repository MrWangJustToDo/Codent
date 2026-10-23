import { useSurfaceInput } from "./use-surface-input.js";

import type { InputHandler } from "./use-surface-input.js";

/**
 * The workspace panel's keyboard: tree navigation, preview/diff keys, image zoom and pan.
 *
 * Two sub-surfaces share it — the file/diff view and the quick-open finder — so each passes its own
 * `when`. They never see the same keystroke.
 */
export function useWorkspacePanelInput(handler: InputHandler, options?: { when?: boolean }): void {
  useSurfaceInput("workspace", handler, options);
}
