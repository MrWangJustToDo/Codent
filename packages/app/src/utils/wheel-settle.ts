/**
 * Quarantine for the tail of a wheel gesture whose translation was just switched off.
 *
 * Inside the alternate screen the terminal turns a wheel tick into an Up/Down byte (xterm mode
 * 1007). When the panel closes it switches that mode off — but the terminal may already have
 * translated a notch or two into bytes that are sitting in the pty, and those arrive *after* the
 * panel is gone. They are ordinary arrow presses by the time the app sees them, so they reach the
 * chat input and recall history: the trackpad's momentum "keeps scrolling the message list".
 *
 * The app cannot tell those bytes from a real key — mode 1007 carries no gesture marker — so the
 * only honest defence is time: arrows are ignored for the few frames it takes the pipe to drain.
 * {@link endWheelSettle} shortens the window the moment any other key arrives, because a person
 * typing is proof the tail is over.
 *
 * Clock-injected and kept in one place so the policy ("was this the wheel or a person") can be
 * asked by a test, like the gesture gates in `workspace-scroll.ts`.
 */

/**
 * How long after the mode is switched off a translated tick can still reach us.
 *
 * Bounded by what the terminal managed to produce between the keypress that closed the panel and
 * the disable write landing — one to three frames, not the whole momentum: once the terminal
 * processes `?1007l` it stops translating, so a longer tail would mean the write never arrived.
 * Kept this short on purpose: `Esc` then `↑` (recall the last prompt) is a normal flow, and a
 * generous window would eat it.
 */
export const WHEEL_TAIL_MS = 40;

let settleUntil = Number.NEGATIVE_INFINITY;

/** Start the window. Called when the panel hands the terminal back. */
export function beginWheelSettle(now: number = Date.now()): void {
  settleUntil = now + WHEEL_TAIL_MS;
}

/** Whether an arrow press at `now` is still the wheel's tail rather than a key. */
export function isWheelSettling(now: number = Date.now()): boolean {
  return now < settleUntil;
}

/** End the window early — a non-arrow key proves a person is at the keyboard. */
export function endWheelSettle(): void {
  settleUntil = Number.NEGATIVE_INFINITY;
}

/** The subset of an input key this policy reads. */
export interface WheelTailKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
}

/**
 * Whether an input event is the wheel's tail rather than a key press — the whole policy, one owner.
 *
 * Three answers, and the difference matters:
 *
 * - `true` — inside the window and it is an arrow: swallow it. These are the bytes the terminal
 *   produced before the disable write landed, and acting on them is the reported bug (a momentum
 *   tail recalling five prompts, or sliding the cursor).
 * - `false`, window closed by this call — anything else: a person is typing, so the tail is over and
 *   the arrows that follow it are genuinely theirs (`Esc` then `↑`).
 * - `false`, nothing to do — the window was never open, or it already expired.
 *
 * @example
 * // the workspace panel just closed
 * claimWheelAsArrows()();
 * consumeWheelTail({ upArrow: true });  // true — the trackpad's last notch
 * consumeWheelTail({});                // false — and the window ends here
 * consumeWheelTail({ upArrow: true }); // false — a real ↑ is a real ↑
 */
export function consumeWheelTail(key: WheelTailKey, now: number = Date.now()): boolean {
  if (!isWheelSettling(now)) return false;
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return true;
  endWheelSettle();
  return false;
}
