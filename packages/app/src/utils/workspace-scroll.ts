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
 * Rows one scroll key moves the preview pane.
 *
 * One, not three: on the alternate screen the terminal delivers a wheel notch as an Up/Down key
 * (xterm "alternate scroll", mode 1007), so a step of 3 tripled the wheel's speed — a single notch
 * jumped three rows and a trackpad's momentum tail ran away with the file. The tree pane already
 * moved one row per key, so this also makes the two panes agree.
 */
export const PREVIEW_SCROLL_STEP = 1;

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
 * Admit at most one scroll step per {@link SCROLL_BURST_INTERVAL_MS}.
 *
 * Kept pure and clock-injected: the policy is "which of these events move the view", and a
 * component holding a timer is not something a test can ask.
 *
 * @example
 * const pacer = createScrollPacer(32);
 * pacer.admit(0); // true — a fresh press always moves
 * pacer.admit(10); // false — momentum, not intent
 * pacer.admit(32); // true
 */
export function createScrollPacer(minIntervalMs: number): { admit: (now: number) => boolean; reset: () => void } {
  let lastAdmittedAt = Number.NEGATIVE_INFINITY;
  return {
    admit(now: number): boolean {
      if (now - lastAdmittedAt < minIntervalMs) return false;
      lastAdmittedAt = now;
      return true;
    },
    /** Forget the previous step — a pane that just took focus scrolls on its first key. */
    reset(): void {
      lastAdmittedAt = Number.NEGATIVE_INFINITY;
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
