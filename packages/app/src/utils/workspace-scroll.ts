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
