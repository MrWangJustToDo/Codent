/**
 * Memory expiry — the one definition.
 *
 * The memory manager and the extraction/eviction path each decided whether a memory had expired,
 * and the two disagreed on the unparseable-date case: the manager treats an `expiresAt` that does
 * not parse as expired, while the extractor treated it as live. That is the divergence this file
 * removes — an unparseable expiry is not trustworthy, so it counts as expired.
 */

import type { Memory } from "./types.js";

/**
 * True when a memory carries an `expiresAt` in the past, or one that does not parse.
 *
 * `now` is injectable so the decision is testable without touching the clock.
 */
export function isExpiredMemory(mem: Memory, now: number = Date.now()): boolean {
  if (!mem.expiresAt) return false;
  const expiresAt = Date.parse(mem.expiresAt);
  return Number.isNaN(expiresAt) || expiresAt <= now;
}
