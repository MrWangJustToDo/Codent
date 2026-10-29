/**
 * Status-transition log policy — which transitions are worth an `info` line.
 *
 * A run's status flips many times per turn, and most of those flips are mechanical:
 * the stream pump's `waiting ⇄ running` bracket around a tool approval, and `reconcile`
 * re-deriving a state that is already held. Logging every transition at `info` made
 * status the single largest block in a session log — 29.6k of 92.6k lines (31.9%)
 * across the recorded sessions, dominated by 6,262 `approvals-pending` ↔ 6,266
 * `reconcile` pairs that only ever restated each other.
 *
 * The level therefore follows what the transition *means*, not that it happened:
 *
 * | Transition | Level | Why |
 * |---|---|---|
 * | into `error` / `aborted` | `info` | terminal, and the outcome a reader looks for |
 * | a user-driven change (cancel) | `info` | an actor did something |
 * | everything else, with a real trigger | `debug` | the pump's internal bookkeeping |
 * | no trigger (restore, direct set) | `info` | uncommon; likely a state nothing else explains |
 *
 * "User-driven" is judged by whether another event already records it. The abort has
 * `agent:abort`; a **manual** compact has its own `compaction:manual-*` rows (info on start /
 * complete, error on failure) written by the specialized handler. The status line is therefore
 * `debug` — demoting it removes a duplicate, not the fact (the earlier note here claimed the
 * rule table suppressed those events, which stopped being true when they became specialized).
 *
 * The trigger is the discriminator because it is already the vocabulary the status
 * controller uses for *why* it is setting a status (`chunk:tool`, `reconcile`, …), so
 * the policy reads as a list of reasons rather than a list of endpoints.
 *
 * The level reaches the log through `ManagedAgent.setStatus`, which is the single
 * funnel every transition goes through — the UI state, the emitted event and the log
 * line all stay on the same path, so nothing here can make the log disagree with the
 * status the host sees.
 */

import type { LogLevel } from "../agent-log/types.js";

/**
 * Triggers that fire as part of the run pump's normal bookkeeping.
 *
 * `reconcile` is listed because it *derives* a status from pending approvals and is
 * usually a no-op in effect — the call sites already guard with `getStatus() !== x`
 * before invoking it, so what it logs is the guard having let it through, not a change
 * the user would notice.
 */
const MECHANICAL_TRIGGERS: ReadonlySet<string> = new Set([
  // Approval bracket: the user drives this from the UI, and it is logged twice per
  // approval (pending → waiting, resolved → running) on top of the approval events.
  "approvals-pending",
  "approvals-cleared",
  // Mid-stream status derivation from the AG-UI chunk type.
  "chunk:text",
  "chunk:tool",
  "chunk:reasoning",
  // Run lifecycle — the run's own `prompt:submit` / `agent:stop` / `agent:abort`
  // events already bracket these, at a level that carries the outcome.
  "run-prepare",
  "run-start",
  "run-finish",
  "run-abort",
  "run-error",
  // Status re-derivation (resume, pump end, detached workers).
  "reconcile",
  "reconcile-after-run",
  "apply-outcome",
  "detached-terminal",
  "reset",
  // Recovery and compaction bookkeeping — each has a dedicated telemetry event.
  // `compaction:<kind>` is demoted by the prefix rule below; the controller's trigger is
  // `compaction:manual`, not a `manual-compact` literal.
  "recovery-retry",
  "external-error",
  "compaction-end",
  // Client-side tool handoff.
  "before-tool-call",
  "client-tool-wait",
  "client-tool-resume",
]);

/** Terminal outcomes a reader scans for, whatever moved the status there. */
const NOTABLE_STATUSES: ReadonlySet<string> = new Set(["error", "aborted"]);

/**
 * Log level for a status transition.
 *
 * @param to the status being entered.
 * @param trigger why the caller is setting it (the status controller's vocabulary).
 *   Omit for a direct set with no stated reason — those stay at `info`, because they
 *   are rare and nothing else in the log explains them.
 */
export function statusTransitionLogLevel(to: string, trigger?: string): LogLevel {
  if (NOTABLE_STATUSES.has(to)) return "info";
  if (!trigger) return "info";
  // Dynamic spellings (`compaction:auto`, `compaction:reactive`) share a prefix.
  if (trigger.startsWith("compaction:")) return "debug";
  return MECHANICAL_TRIGGERS.has(trigger) ? "debug" : "info";
}
