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

import { beginWheelSettle } from "./wheel-settle.js";

let active = false;
let wheelArrowsEnabled = false;

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
 *
 * The switch is paired: {@link disableWheelAsArrows} gives the mode back, and {@link claimWheelAsArrows}
 * returns both as one release so a screen cannot acquire half of it. `MY_AGENT_DISABLE_MOUSE=1`
 * turns the whole capability off (a kill switch is not optional: a terminal that mishandles 1007
 * leaves the user with no way out otherwise).
 */
export function enableWheelAsArrows(): void {
  if (wheelArrowsEnabled) return;
  if (isMouseDisabledByEnv()) return;
  // Terminal-only by nature, and guarded like every other platform read in this package
  // (`use-size`, `file-icons`, `colorEnabled`): 1007 is an escape sequence for a real TTY, and a
  // browser host has no `process` at all — the playground defines none, so reading
  // `process.stdout.isTTY` threw a ReferenceError straight out of the workspace panel's mount
  // effect and the web app never rendered. A host without a TTY keeps its native wheel handling.
  const stdout = tty();
  if (!stdout) return;
  stdout.write("\x1b[?1007h");
  wheelArrowsEnabled = true;
}

/**
 * Give mode 1007 back. A no-op unless {@link enableWheelAsArrows} switched it on in this process:
 * xterm ships 1007 enabled by default, so writing `?1007l` unconditionally would change the
 * terminal for everything else running in it (a `less` or `vim` that relies on wheel→arrow), which
 * is a side effect on somebody else's state rather than a restore.
 */
export function disableWheelAsArrows(): void {
  if (!wheelArrowsEnabled) return;
  wheelArrowsEnabled = false;
  tty()?.write("\x1b[?1007l");
}

/** Whether this process switched mode 1007 on and has not given it back yet. */
export function isWheelAsArrowsEnabled(): boolean {
  return wheelArrowsEnabled;
}

/**
 * Switch the wheel→arrow translation on and return its release.
 *
 * The pair exists so a screen cannot do one half: the leak this fixes was an `enable` with no
 * matching `disable` anywhere in the repository, which only surfaced once the app stayed in the
 * alternate screen. The release also starts the {@link beginWheelSettle} window, because the
 * terminal may already have translated a tick that has not reached the app yet.
 */
export function claimWheelAsArrows(): () => void {
  enableWheelAsArrows();
  return () => {
    disableWheelAsArrows();
    beginWheelSettle();
  };
}

/**
 * The bytes a last-resort exit has to write to hand this module's modes back.
 *
 * Empty when nothing was claimed, so a host that never opened the panel leaves the terminal's own
 * 1007 default alone. Used by the `process.once("exit")` restore, which runs on paths that exit
 * without unmounting (a fatal bootstrap error, a signal) — the normal path gives the mode back
 * through the panel's own cleanup.
 */
export function wheelModeReleaseSequence(): string {
  return wheelArrowsEnabled ? "\x1b[?1007l" : "";
}

/** Drop the ownership mark without writing (host teardown after the release sequence, tests). */
export function resetWheelAsArrows(): void {
  wheelArrowsEnabled = false;
}

/** The stdout of a real TTY, or null in a browser host / piped output. */
function tty(): { write(chunk: string): void } | null {
  if (typeof process === "undefined") return null;
  const stdout = process.stdout;
  if (!stdout?.isTTY) return null;
  return stdout;
}

/**
 * `MY_AGENT_DISABLE_MOUSE=1` (or `true`) opts out of every terminal mode that claims the wheel.
 * Read here rather than by each caller so there is one answer per process, like `NO_COLOR`.
 */
function isMouseDisabledByEnv(): boolean {
  if (typeof process === "undefined") return false;
  const raw = process.env?.MY_AGENT_DISABLE_MOUSE?.trim().toLowerCase();
  if (!raw) return false;
  return raw !== "0" && raw !== "false";
}
