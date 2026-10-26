/**
 * Extension dispatch order — the one definition of "which extension runs first".
 *
 * Four extension surfaces are observable as a **sequence** and were all ordered by the same
 * uncontrolled variable (the order extensions happen to load): interceptor dispatch,
 * message-transformer chaining, same-named tool resolution, and turn-context section order.
 * `ExtensionAPI.order` makes the sequence declarable; this module is the single place that
 * turns `(order, load sequence)` into a decision, so the surfaces cannot drift in direction
 * or tie-break.
 *
 * Two readings of one rule (see the `extension-ordering` spec):
 *  - **chain surfaces** (interceptors, transformers, context sections) read the sorted sequence
 *    front-to-back — lower order runs earlier;
 *  - **resolution surfaces** (same-named tools) read it back-to-front — the highest order wins,
 *    because a later-running extension is the one that supersedes.
 *
 * Both follow from sorting by {@link compareDispatchRank} and reading the result; neither is a
 * separate ad-hoc comparison.
 */

/** An extension that declares no order runs in the middle, at declaration time ruled by load sequence. */
export const DEFAULT_EXTENSION_ORDER = 0;

/**
 * The order every built-in extension declares.
 *
 * Built-ins are the baseline, and they load *last* (bootstrap runs the disk/config extensions first,
 * then the built-ins). Without a declared order that load position silently made them the opposite:
 * they ran last in interceptor/transformer chains and **won** same-named tools, so a user extension
 * that replaced `load_skill` was buried. A below-default order fixes both readings at once — chain
 * surfaces see built-ins first (the user gets the last word), resolution surfaces see them last.
 */
export const BUILTIN_EXTENSION_ORDER = -100;

/**
 * A resolved position: the declared `order` (normalized) plus the extension's recorded load
 * sequence as the tie-break. The sequence is assigned by the extension runner at load time and
 * is deliberately **not** derived from the loader's discovery order — dispatch position is a
 * different concern from which file wins a duplicated extension id.
 */
export interface DispatchRank {
  /** Declared `order`, or {@link DEFAULT_EXTENSION_ORDER}. Always finite. */
  order: number;
  /** Load sequence: lower means loaded earlier. The tie-break within an equal `order`. */
  seq: number;
}

/**
 * Normalize a declared `order` to a usable number.
 *
 * A non-finite or non-numeric value falls back to the default rather than producing an
 * implementation-defined sequence — a bad number must not silently reorder an extension.
 */
export function resolveExtensionOrder(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_EXTENSION_ORDER;
}

/** Order the sequence by declared order, then by load sequence. Lower runs earlier. */
export function compareDispatchRank(a: DispatchRank, b: DispatchRank): number {
  return a.order - b.order || a.seq - b.seq;
}

/**
 * The live entry for one name: the highest rank. This is the resolution reading of dispatch order,
 * used by every stack (tools, commands) so they cannot disagree on which entry wins.
 */
export function pickTopByRank<T extends { rank: DispatchRank }>(items: readonly T[]): T {
  if (items.length === 0) throw new Error("pickTopByRank: empty stack");
  return items.reduce((top, entry) => (compareDispatchRank(entry.rank, top.rank) > 0 ? entry : top));
}

/** Sort a copy of `items` by rank (never mutates the input). */
export function sortByDispatchRank<T extends { rank: DispatchRank }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => compareDispatchRank(a.rank, b.rank));
}

/**
 * The rank of the incumbent (a base tool registered before any extension, held only by the host
 * tool stack). It must lose to every extension, so it sorts lowest — an extension with an
 * extreme negative `order` still overrides the base tool rather than being buried by it.
 */
export const INCUMBENT_RANK: DispatchRank = { order: Number.NEGATIVE_INFINITY, seq: Number.NEGATIVE_INFINITY };
