/**
 * Epoch equivalence: the predicates that replace the ad-hoc guards must agree with them.
 *
 * The migration deletes `sessionIdAtStart` / `stillOn*` / the chat controller's manual staleness
 * check. This validator pins the three `Epoch` predicates against the contracts they replace on a
 * matrix of session/run transitions, so "we removed a guard" cannot silently change which writes
 * land:
 *
 * - `isCurrent()` ⇔ the old captured-session-id guard (title / memory usage).
 * - `isStable()` ⇔ `captureSessionStaleness(ui, isSwitching)` (switch admitted counts as stale).
 * - `isRunCurrent()` adds the run token and lifecycle generation (no old single guard; asserted
 *   directly).
 */

import assert from "node:assert/strict";

import { captureSessionStaleness, createEpoch } from "../dist/dev.mjs";

import { assertEquivalent } from "./helpers/equivalence.mjs";

function makeSource(initial = {}) {
  // The real token is a live view over coordinator state; a captured epoch keeps the VIEW, so
  // invalidating the run must be observable through it.
  const tokenState = { valid: initial.tokenValid ?? true };
  const state = {
    session: initial.session ?? 1,
    lifecycle: initial.lifecycle ?? 1,
    switching: initial.switching ?? false,
    token: initial.noToken
      ? null
      : {
          id: initial.tokenId ?? 1,
          get isCurrent() {
            return tokenState.valid;
          },
        },
  };
  const source = {
    getSessionGeneration: () => state.session,
    getLifecycleGeneration: () => state.lifecycle,
    getRunToken: () => state.token,
    isSessionSwitching: () => state.switching,
  };
  return { state, tokenState, source };
}

// ---------------------------------------------------------------------------
// 1. Predicate semantics on a captured epoch
// ---------------------------------------------------------------------------
{
  const { state, source } = makeSource();
  const epoch = createEpoch(source);
  assert.equal(epoch.isCurrent(), true, "baseline is current");
  assert.equal(epoch.isStable(), true, "baseline is stable");
  assert.equal(epoch.isRunCurrent(), true, "baseline is run-current");

  state.switching = true;
  assert.equal(epoch.isCurrent(), true, "admitted switch does not make the session generation stale");
  assert.equal(epoch.isStable(), false, "admitted switch is not stable");
  state.switching = false;

  state.session = 2;
  assert.equal(epoch.isCurrent(), false, "commit makes the session generation stale");
  assert.equal(epoch.isRunCurrent(), false, "…and the run predicate too");
}

// ---------------------------------------------------------------------------
// 2. Lifecycle and run token
// ---------------------------------------------------------------------------
{
  const { state, source } = makeSource();
  const epoch = createEpoch(source);
  state.lifecycle = 2;
  assert.equal(epoch.isCurrent(), true, "a lifecycle bump is not a session change");
  assert.equal(epoch.isRunCurrent(), false, "…but it invalidates the run predicate");

  const run = makeSource();
  const runEpoch = createEpoch(run.source);
  run.tokenState.valid = false;
  assert.equal(runEpoch.isCurrent(), true, "superseded run keeps the session current");
  assert.equal(runEpoch.isRunCurrent(), false, "superseded run is not run-current");
}

// ---------------------------------------------------------------------------
// 3. Captured outside a run, then a run starts
// ---------------------------------------------------------------------------
{
  const { state, source } = makeSource({ noToken: true });
  const epoch = createEpoch(source);
  state.token = { id: 2, isCurrent: true };
  assert.equal(epoch.isCurrent(), true, "a new run does not invalidate a session-scoped capture");
  assert.equal(epoch.isRunCurrent(), true, "there was no captured run to supersede");
}

// ---------------------------------------------------------------------------
// 4. Equivalence with the retired guards
// ---------------------------------------------------------------------------
const transitions = [
  ["no change", { session: 1, lifecycle: 1, switching: false }],
  ["switch admitted", { session: 1, lifecycle: 1, switching: true }],
  ["switch committed", { session: 2, lifecycle: 1, switching: false }],
  ["lifecycle bumped", { session: 1, lifecycle: 2, switching: false }],
  ["run superseded", { session: 1, lifecycle: 1, switching: false, tokenValid: false }],
];

for (const [name, next] of transitions) {
  const { state, tokenState, source } = makeSource();
  const startSessionId = "ses_start";
  const epoch = createEpoch(source);
  // The old guard captured its generation BEFORE the transition, exactly like the epoch.
  const ui = { getSessionGeneration: () => state.session };
  const oldStaleness = captureSessionStaleness(ui, () => state.switching);
  const { tokenValid, ...rest } = next;
  Object.assign(state, rest);
  if (tokenValid !== undefined) tokenState.valid = tokenValid;

  // The old title/memory guard compared the live session id with the captured one.
  const currentSessionId = state.session === 1 ? startSessionId : "ses_other";
  await assertEquivalent(`session guard: ${name}`, {
    oldRun: () => currentSessionId === startSessionId,
    newRun: () => epoch.isCurrent(),
  });

  // The old stream/middleware guard compared the generation and (optionally) the switch flag.
  await assertEquivalent(`staleness guard: ${name}`, {
    oldRun: () => !oldStaleness(),
    newRun: () => epoch.isStable(),
  });
}

console.log("epoch equivalence validation passed");
