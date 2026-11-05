/**
 * SessionLease state matrix.
 *
 * The lease is the single owner of "who holds this session, which generation it is, and whether a
 * claim is committed or abandoned". This pins every transition the switch will rely on, including
 * the failure paths that are hard to reach in an end-to-end test:
 *
 * - initial claim → restore → commit (generation 1, target bound)
 * - resume (active A → claim B → commit; A released exactly once)
 * - failed resume (B released, A kept, generation unchanged, reservation released)
 * - same-id claim/commit is a no-op
 * - a conflicting claim changes nothing
 * - a failed initial reserved claim releases the reservation
 * - drain → release is idempotent
 *
 * Run: node scripts/validate-session-lease-matrix.mjs
 */

import assert from "node:assert/strict";

import { SessionLease } from "../dist/dev.mjs";

function makeHarness({ allow = () => true } = {}) {
  const calls = { acquire: [], release: [], reservation: [], commit: [], adopt: [] };
  const lease = new SessionLease("agent-1", {
    acquire: (sessionId, ownerId) => {
      calls.acquire.push({ sessionId, ownerId });
      return allow(sessionId);
    },
    release: (sessionId, ownerId) => calls.release.push({ sessionId, ownerId }),
    releaseReservation: (sessionId) => calls.reservation.push(sessionId),
    onCommit: (sessionId, generation) => calls.commit.push({ sessionId, generation }),
    onAdopt: (sessionId, messages) => calls.adopt.push({ sessionId, messages }),
  });
  return { lease, calls };
}

function activeLease(sessionId, options = {}) {
  const harness = makeHarness(options);
  harness.lease.claim(sessionId, options.claim);
  harness.lease.commit();
  return harness;
}

// ---------------------------------------------------------------------------
// 1. Initial claim → restore → commit
// ---------------------------------------------------------------------------
{
  const { lease, calls } = makeHarness();
  assert.equal(lease.getState(), "unclaimed");
  assert.equal(lease.claim("ses_a"), true);
  assert.equal(lease.getState(), "claimed", "a claim is not active before restore");
  lease.beginRestore();
  assert.equal(lease.getState(), "restoring");
  lease.commit({ uiMessages: [] });
  assert.equal(lease.getState(), "active");
  assert.equal(lease.getSessionId(), "ses_a");
  assert.equal(lease.getGeneration(), 1);
  assert.deepEqual(calls.release, [], "nothing to release on the first claim");
  assert.deepEqual(calls.commit, [{ sessionId: "ses_a", generation: 1 }]);

  lease.adopt({ uiMessages: [{ id: "m1" }] });
  assert.deepEqual(calls.adopt, [{ sessionId: "ses_a", messages: [{ id: "m1" }] }], "adopt resets the baseline");
  assert.equal(lease.getGeneration(), 1, "adopt does not advance the generation");

  // A second commit of the already-active session does not advance the generation again.
  lease.commit();
  assert.equal(lease.getGeneration(), 1, "commit is idempotent for the active session");
  assert.equal(calls.commit.length, 1);
}

// ---------------------------------------------------------------------------
// 2. Resume: active A → claim B → commit
// ---------------------------------------------------------------------------
{
  const { lease, calls } = activeLease("ses_a");
  calls.release.length = 0;
  calls.commit.length = 0;

  assert.equal(lease.claim("ses_b"), true);
  assert.equal(lease.isTransitioning(), true, "the departure is remembered until the commit");
  lease.beginRestore();
  assert.equal(lease.getState(), "restoring");
  lease.commit({ uiMessages: [] });

  assert.equal(lease.getSessionId(), "ses_b");
  assert.equal(lease.getGeneration(), 2, "one commit advances the generation once");
  assert.deepEqual(calls.release, [{ sessionId: "ses_a", ownerId: "agent-1" }], "the departure is released once");
  assert.equal(calls.commit.at(-1).generation, 2);
}

// ---------------------------------------------------------------------------
// 3. Failed resume: B released, A kept, generation unchanged
// ---------------------------------------------------------------------------
{
  const { lease, calls } = activeLease("ses_a");
  calls.release.length = 0;
  calls.reservation.length = 0;
  calls.commit.length = 0;

  lease.claim("ses_b", { reserved: true });
  lease.beginRestore();
  lease.abortClaim();

  assert.equal(lease.getState(), "active");
  assert.equal(lease.getSessionId(), "ses_a", "a failed switch keeps the departure");
  assert.equal(lease.getGeneration(), 1, "an aborted claim does not advance the generation");
  assert.deepEqual(calls.release, [{ sessionId: "ses_b", ownerId: "agent-1" }], "only the target is released");
  assert.deepEqual(calls.reservation, ["ses_b"], "the target reservation is released");
  assert.deepEqual(calls.commit, []);
}

// ---------------------------------------------------------------------------
// 4. Same-id claim/commit is a no-op
// ---------------------------------------------------------------------------
{
  const { lease, calls } = activeLease("ses_a");
  calls.acquire.length = 0;
  calls.release.length = 0;
  calls.commit.length = 0;

  assert.equal(lease.claim("ses_a"), true);
  lease.beginRestore();
  lease.commit();
  assert.deepEqual(calls.acquire, [], "claiming the held id does not re-acquire");
  assert.deepEqual(calls.release, [], "…and does not release it");
  assert.equal(lease.getGeneration(), 1);
  assert.equal(calls.commit.length, 0);
}

// ---------------------------------------------------------------------------
// 5. A conflicting claim changes nothing
// ---------------------------------------------------------------------------
{
  const { lease, calls } = activeLease("ses_a");
  const conflicting = new SessionLease("agent-2", {
    acquire: () => false,
    release: () => {},
  });
  conflicting.claim("ses_a");
  assert.equal(conflicting.getState(), "unclaimed", "a refused claim does not claim");
  assert.equal(lease.getSessionId(), "ses_a");
  assert.equal(lease.getState(), "active");
  assert.equal(calls.release.length, 0);
}

// ---------------------------------------------------------------------------
// 6. Failed initial reserved claim releases the reservation
// ---------------------------------------------------------------------------
{
  const { lease, calls } = makeHarness();
  assert.equal(lease.claim("ses_new", { reserved: true }), true);
  lease.abortClaim();
  assert.equal(lease.getState(), "unclaimed");
  assert.equal(lease.getSessionId(), undefined);
  assert.deepEqual(calls.release, [{ sessionId: "ses_new", ownerId: "agent-1" }]);
  assert.deepEqual(calls.reservation, ["ses_new"]);
}

// ---------------------------------------------------------------------------
// 7. Drain → release is idempotent
// ---------------------------------------------------------------------------
{
  const { lease, calls } = activeLease("ses_a", { claim: { reserved: true } });
  lease.beginDrain();
  assert.equal(lease.getState(), "draining");
  lease.release();
  assert.equal(lease.getState(), "released");
  assert.deepEqual(calls.release, [{ sessionId: "ses_a", ownerId: "agent-1" }]);
  assert.deepEqual(calls.reservation, ["ses_a"], "a reserved claim releases its reservation");
  lease.release();
  assert.equal(calls.release.length, 1, "releasing twice is a no-op");
}

// ---------------------------------------------------------------------------
// 8. Commit without a claim is a programming error
// ---------------------------------------------------------------------------
{
  const { lease } = makeHarness();
  assert.throws(() => lease.commit(), /without a claimed session/);
}

console.log("session lease matrix validation passed");
