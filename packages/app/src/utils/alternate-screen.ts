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
 * xterm "alternate scroll" (mode 1007): while the alternate screen is active, a wheel tick is
 * delivered as an Up/Down key press.
 *
 * That is exactly what the browser wants. It has no pointer model — its two panes are driven by
 * the arrow keys (the tree moves its cursor, the preview scrolls) — so this one mode makes the
 * wheel work with no mouse parsing at all. It also leaves the mouse unclaimed, so click-drag text
 * selection over a preview keeps working.
 *
 * Only the alternate screen translates the wheel, which is why this is safe to switch on here and
 * nowhere else: the chat runs on the normal buffer, so a wheel tick there stays a terminal
 * scrollback scroll and never reaches the app. (The `/` command menu only ever scrolled on the
 * wheel back when the *whole* app wore the alternate screen.)
 *
 * Writing this mode is content-neutral — unlike a screen clear, it does not desync the renderer's
 * row model.
 */
export function enableWheelAsArrows(): void {
  // Terminal-only by nature, and guarded like every other platform read in this package
  // (`use-size`, `file-icons`, `colorEnabled`): 1007 is an escape sequence for a real TTY, and a
  // browser host has no `process` at all — the playground defines none, so reading
  // `process.stdout.isTTY` threw a ReferenceError straight out of the workspace panel's mount
  // effect and the web app never rendered. A host without a TTY keeps its native wheel handling.
  if (typeof process === "undefined" || !process.stdout?.isTTY) return;
  process.stdout.write("\x1b[?1007h");
}
