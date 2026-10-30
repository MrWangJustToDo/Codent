/** Keep `index` visible inside a `[scrollTop, scrollTop + visibleCount)` window. */
export function ensureIndexVisible(index: number, scrollTop: number, visibleCount: number, totalCount: number): number {
  if (totalCount <= visibleCount) return 0;
  const maxScroll = Math.max(0, totalCount - visibleCount);
  if (index < scrollTop) return index;
  if (index >= scrollTop + visibleCount) {
    return Math.min(index - visibleCount + 1, maxScroll);
  }
  return scrollTop;
}

export function clampScrollTop(scrollTop: number, totalLines: number, visibleLines: number): number {
  const maxScroll = Math.max(0, totalLines - visibleLines);
  return Math.max(0, Math.min(scrollTop, maxScroll));
}

// ============================================================================
// Wheel input policy
// ============================================================================

/**
 * Rows one **discrete** scroll step moves the preview / diff pane.
 *
 * The two panes measure different things: the tree moves a *cursor* (one row = one item), while the
 * preview moves *content* (one row = one line). One line per notch reads as sluggish next to the
 * tree, so a fresh notch moves a line group — 3 is also what a text viewer conventionally advances
 * per wheel detent.
 *
 * Momentum is not this knob's job: {@link createScrollStepper} keeps a *stream* of events at
 * {@link PREVIEW_SCROLL_CONTINUOUS_STEP}, so a trackpad tail still moves one row per admitted
 * event no matter what this is set to.
 */
export const PREVIEW_SCROLL_STEP = 3;

/** Rows one step of a *continuous* stream moves (trackpad momentum, or a held arrow key). */
export const PREVIEW_SCROLL_CONTINUOUS_STEP = 1;

/**
 * Quiet time that turns a step into a discrete notch.
 *
 * A wheel detent, a deliberate arrow tap and a trackpad's momentum tail arrive as the SAME bytes;
 * only their timing differs. A pause this long means the user asked for one step and is waiting to
 * see it, so it earns the full {@link PREVIEW_SCROLL_STEP}; anything arriving sooner than
 * {@link SCROLL_BURST_INTERVAL_MS} is momentum and is dropped.
 */
export const SCROLL_DISCRETE_GAP_MS = 96;

/**
 * Shortest gap between two admitted scroll steps.
 *
 * The wheel and a pressed arrow arrive as the SAME event, so the panel cannot tell a flick from a
 * held key — the one lever left on this input plane is time. A trackpad's momentum keeps emitting
 * notches after the fingers stop (every 8–16ms on macOS), which is what reads as scroll *inertia*;
 * dropping events that arrive faster than this caps a burst at ~30 steps/s instead of ~120.
 *
 * The number is just under the fastest repeat every platform delivers by default (Windows and X11
 * repeat at 31–40ms), so a held arrow key still moves one row per repeat — the cap only bites the
 * bursts no keyboard produces.
 */
export const SCROLL_BURST_INTERVAL_MS = 32;

/**
 * Admit at most one scroll step per {@link SCROLL_BURST_INTERVAL_MS}, and say how far it moves.
 *
 * The one definition of "is this event a fresh notch, part of a stream, or momentum":
 *
 * - sooner than `burstMs` after the last admitted step → momentum, move nothing;
 * - at least `discreteGapMs` of quiet before it → a discrete notch, move `discreteStep`;
 * - in between → a stream (trackpad fingers moving, or a held key), move one row.
 *
 * Kept pure and clock-injected: the policy is "how far does this event move the view", and a
 * component holding a timer is not something a test can ask.
 *
 * @example
 * const stepper = createScrollStepper();
 * stepper.rows(0); // 3 — nothing before it, so the first notch is a discrete one
 * stepper.rows(10); // 0 — momentum, not intent
 * stepper.rows(42); // 1 — a stream, not a notch
 * stepper.rows(200); // 3 — the user paused, then asked again
 */
export function createScrollStepper(
  options: { burstMs?: number; discreteGapMs?: number; discreteStep?: number } = {}
): { rows: (now: number) => number; reset: () => void } {
  const burstMs = options.burstMs ?? SCROLL_BURST_INTERVAL_MS;
  const discreteGapMs = options.discreteGapMs ?? SCROLL_DISCRETE_GAP_MS;
  const discreteStep = options.discreteStep ?? PREVIEW_SCROLL_STEP;
  let lastAdmittedAt = Number.NEGATIVE_INFINITY;
  return {
    rows(now: number): number {
      const gap = now - lastAdmittedAt;
      if (gap < burstMs) return 0;
      lastAdmittedAt = now;
      return gap >= discreteGapMs ? discreteStep : PREVIEW_SCROLL_CONTINUOUS_STEP;
    },
    /** Forget the previous step — a pane that just took focus scrolls on its first key. */
    reset(): void {
      lastAdmittedAt = Number.NEGATIVE_INFINITY;
    },
  };
}

/**
 * Admit at most one step per `minIntervalMs`, as a boolean.
 *
 * The magnitude-free half of {@link createScrollStepper}: a cursor move is one *item* per admitted
 * event and has no "how far" to answer, so this is the same time gate with the step ignored and
 * the discrete tier switched off.
 *
 * @example
 * const pacer = createScrollPacer(32);
 * pacer.admit(0); // true — a fresh press always moves
 * pacer.admit(10); // false — momentum, not intent
 * pacer.admit(32); // true
 */
export function createScrollPacer(minIntervalMs: number): { admit: (now: number) => boolean; reset: () => void } {
  const stepper = createScrollStepper({ burstMs: minIntervalMs, discreteGapMs: Number.POSITIVE_INFINITY });
  return { admit: (now: number) => stepper.rows(now) > 0, reset: () => stepper.reset() };
}

// ============================================================================
// Horizontal wheel policy (the same 1007 plane, translated to ←/→)
// ============================================================================

/**
 * Fastest gap between two ←/→ presses that still counts as two decisions.
 *
 * A trackpad's horizontal swipe reaches the app as a stream of LEFT/RIGHT keys, and the panel has
 * no way to tell one byte from a key press — but it can tell how fast they arrive. A swipe emits a
 * notch every 8–16ms; no keyboard repeats faster than ~31ms (Windows/X11 defaults sit at 31–40ms),
 * so anything closer than 25ms is the wheel.
 */
export const WHEEL_GESTURE_BURST_MS = 25;

/** Quiet time after the last burst event that ends the gesture. */
export const WHEEL_GESTURE_QUIET_MS = 140;

/**
 * How long a lone press waits before it is allowed to act.
 *
 * The price of telling a swipe from a key: the panel must see whether a second press follows. The
 * wait is one to three frames because it happens *before* a discrete action (expand a directory,
 * move focus) whose state does not expire; it is not a delay on scrolling, which runs unpaced.
 */
export const WHEEL_GESTURE_COMMIT_MS = WHEEL_GESTURE_BURST_MS;

/**
 * Tell a horizontal swipe from a ←/→ key press.
 *
 * Every press is reported as `defer` — the caller runs the action once `commit()` agrees, a
 * {@link WHEEL_GESTURE_COMMIT_MS} later. If a second press arrives inside that window the pair is
 * a swipe, so the pending action is dropped and the rest of the gesture is swallowed until
 * {@link WHEEL_GESTURE_QUIET_MS} of quiet passes. A held key is unaffected: auto-repeat starts after
 * a several-hundred-millisecond delay and then repeats slower than the burst window.
 *
 * Kept pure and clock-injected (the caller owns the timer) for the same reason as the scroll gate:
 * the policy is "was this gesture a person or a trackpad", which a test can ask.
 *
 * @example
 * const guard = createWheelGestureGuard();
 * guard.press(0);    // "defer" — schedule commit() in 25ms
 * guard.press(10);   // "swallow" — a swipe; the pending commit is cancelled
 * guard.press(20);   // "swallow" — still the same gesture
 * guard.press(400);  // "defer" — quiet long enough for a fresh press
 */
export function createWheelGestureGuard(options: { burstMs?: number; quietMs?: number } = {}): {
  press: (now: number) => "defer" | "swallow";
  commit: () => boolean;
  cancel: () => void;
} {
  const burstMs = options.burstMs ?? WHEEL_GESTURE_BURST_MS;
  const quietMs = options.quietMs ?? WHEEL_GESTURE_QUIET_MS;
  let lastPressAt = Number.NEGATIVE_INFINITY;
  let swallowingUntil = Number.NEGATIVE_INFINITY;
  let pending = false;
  return {
    press(now: number): "defer" | "swallow" {
      if (now < swallowingUntil) {
        swallowingUntil = now + quietMs;
        pending = false;
        return "swallow";
      }
      if (pending && now - lastPressAt < burstMs) {
        // The second press inside the commit window is what identifies the wheel: drop the action
        // that is already waiting and keep swallowing while the gesture lasts.
        pending = false;
        swallowingUntil = now + quietMs;
        return "swallow";
      }
      lastPressAt = now;
      pending = true;
      return "defer";
    },
    /** The deferring timer fired: `true` means run the action. */
    commit(): boolean {
      if (!pending) return false;
      pending = false;
      return true;
    },
    /** Drop a waiting action (pane teardown). */
    cancel(): void {
      pending = false;
    },
  };
}

/**
 * The visible slice of a scrolling list, clamped so the window always sits inside the rows.
 *
 * Every scrolling list in the workspace (the file tree, quick-open's results, `ScrollableList`)
 * needs the same three things, and computing them apart is how one of them drifts: the start
 * offset, the end, and the rows in between. `start` is returned because row indices and "N more"
 * labels are derived from it — from the *clamped* value, not the stored offset, or a stale offset
 * shifts every row number.
 */
export function visibleWindow<T>(
  items: readonly T[],
  scrollTop: number,
  visibleCount: number
): { start: number; end: number; slice: T[] } {
  const start = clampScrollTop(scrollTop, items.length, visibleCount);
  const end = Math.min(start + visibleCount, items.length);
  return { start, end, slice: items.slice(start, end) as T[] };
}
