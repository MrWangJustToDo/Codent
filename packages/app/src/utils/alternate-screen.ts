/**
 * Alternate-screen ownership, and the one terminal mode that rides with it.
 *
 * The alternate screen is terminal-global, not per component, so exactly one owner may switch
 * it on. Today that is the workspace browser: its tree and preview size themselves to the full
 * screen height, and it must not share the terminal's scrollback with the chat while it is up.
 * Every other screen keeps the normal buffer (native scrollback, native selection).
 *
 * The host reads {@link isAlternateScreenActive} on exit. A report painted while the alternate
 * screen owns the terminal is discarded when the screen is left, so the host leaves it first and
 * prints the report on the normal screen instead.
 */

let active = false;

/** Whether a panel currently owns the terminal's alternate screen. */
export function isAlternateScreenActive(): boolean {
  return active;
}

/** Mark the alternate screen as entered (true) or left (false). Owned by the panel. */
export function setAlternateScreenActive(value: boolean): void {
  active = value;
}

/**
 * xterm "alternate scroll" (mode 1007): while the alternate screen is active, the wheel is
 * translated into Up/Down keys.
 *
 * The browser scrolls with its own keys, so that translation would move the tree selection
 * behind the preview instead of scrolling anything. Turn it off while the panel owns the
 * screen and restore the terminal default on the way out. Writing this mode is content-neutral
 * — unlike a screen clear, it does not desync the renderer's row model.
 */
export function setAlternateScrollTranslation(enabled: boolean): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(enabled ? "\x1b[?1007h" : "\x1b[?1007l");
}
