/**
 * Middleware pipeline assembly: canonical order + phase sort.
 *
 * The phase primitives a middleware declares about *itself* live in
 * `runtime-types/middleware-phase.ts`, so domain modules (e.g.
 * `agent/plan/plan-mode-middleware.ts`) can declare their phase without
 * importing `managers/**`. What remains here is the manager-side concern: how
 * the assembled pipeline is ordered and guarded.
 *
 * The phase primitives are re-exported so existing manager-side importers keep
 * working through this module.
 */

import { MIDDLEWARE_PHASE_RANK, type MiddlewarePhase } from "../../runtime-types/middleware-phase.js";

export { MIDDLEWARE_PHASE_RANK, defineMiddleware } from "../../runtime-types/middleware-phase.js";
export type { MiddlewarePhase, PhasedChatMiddleware } from "../../runtime-types/middleware-phase.js";

/** Re-exported so existing importers keep working. */
export type { ChatMiddleware } from "@tanstack/ai";

/**
 * Canonical name sequence of the managed middleware pipeline. The phase sort
 * must resolve to exactly this order; `assertCanonicalMiddlewareOrder` warns
 * on divergence and `validate:middleware-order` fails the build on drift.
 */
export const CANONICAL_MIDDLEWARE_ORDER = [
  "status",
  "approval-resume",
  "lifecycle",
  "compaction",
  // MUST stay adjacent to `compaction`: it transforms the channel-projected wire
  // that `compaction` produces, and that projection discards any earlier edit.
  "message-transform",
  "tool-compact",
  // MUST stay after `tool-compact`: a capability strip replaces media parts with a
  // placeholder, and for a TOOL result the media part does not exist until
  // `tool-compact` projects the result through the tool's `toModelOutput`. Sitting
  // before it left tool media unreachable (the strip saw JSON text and passed it
  // through), so a model without vision was still sent the image — and the widened
  // retry could not help, because the projection re-materializes it on every call.
  // MUST stay after `message-transform` (a strip running first would hide the real
  // attachment from an extension transformer) and after `compaction` (the channel
  // projection discards anything applied before it).
  "wire-recovery",
  "turn-context",
  "extensions",
  "early-tool-result-ui",
  "task-prefork",
  "plan-mode",
  "repeat-reminder",
  "background-notification",
  "prompt-cache",
] as const;

/** Dev-time guard: warn when the assembled pipeline diverges from the canonical snapshot. */
export function assertCanonicalMiddlewareOrder<T extends { name?: string }>(
  middlewares: T[],
  warn: (message: string) => void
): void {
  const names = middlewares.map((m) => m.name ?? "?");
  for (let i = 0; i < Math.max(names.length, CANONICAL_MIDDLEWARE_ORDER.length); i++) {
    const actual = names[i];
    const expected = CANONICAL_MIDDLEWARE_ORDER[i];
    if (actual !== expected) {
      warn(
        `middleware order drift at position ${i}: expected "${expected ?? "(none)"}", got "${actual ?? "(none)"}". ` +
          "Update the phase declarations or CANONICAL_MIDDLEWARE_ORDER, and refresh validate:middleware-order."
      );
      return;
    }
  }
}

/**
 * Stable sort by phase rank. Middlewares without a declared phase keep their
 * relative position (rank fallback) and surface a dev warning — an undeclared
 * phase is an assembly-contract violation caught by the order snapshot too.
 */
export function sortMiddlewaresByPhase<T extends { name?: string; phase?: MiddlewarePhase }>(
  middlewares: T[],
  warn: (message: string) => void = () => {}
): T[] {
  return [...middlewares].sort((a, b) => {
    const rankA = a.phase ? MIDDLEWARE_PHASE_RANK[a.phase] : Number.NaN;
    const rankB = b.phase ? MIDDLEWARE_PHASE_RANK[b.phase] : Number.NaN;
    if (Number.isNaN(rankA)) {
      warn(`middleware "${a.name ?? "?"}" has no phase declaration — it will not be phase-sorted`);
    }
    if (Number.isNaN(rankB)) {
      warn(`middleware "${b.name ?? "?"}" has no phase declaration — it will not be phase-sorted`);
    }
    const left = Number.isNaN(rankA) ? Number.MAX_SAFE_INTEGER : rankA;
    const right = Number.isNaN(rankB) ? Number.MAX_SAFE_INTEGER : rankB;
    return left - right;
  });
}
