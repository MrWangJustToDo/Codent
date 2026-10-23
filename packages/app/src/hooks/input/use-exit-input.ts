import { useUnscopedInput } from "./use-surface-input.js";

import type { InputHandler } from "./use-surface-input.js";

/**
 * The process exit chord (Ctrl+C), registered on every screen.
 *
 * Screens own plain keys; quitting the process is not a screen's business, so this one handler is
 * not scoped. It matches `ctrl+c` only — no surface handler claims that chord, which is what keeps
 * "one owner per keystroke" true even though this handler is always subscribed.
 */
export function useExitInput(handler: InputHandler): void {
  useUnscopedInput(handler);
}
