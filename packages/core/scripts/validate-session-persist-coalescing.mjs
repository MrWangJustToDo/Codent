/**
 * Validates UI-snapshot write coalescing in `SessionService`.
 *
 * One model call can inject several synthetic messages (turn-context sections, a todo nag, a
 * repeat nudge, a background notification, the jobs pointer). Each injection used to enqueue
 * its own full-snapshot write: a full fingerprint, a full dehydrate pass and a store append.
 * The coalesced path writes only the newest admitted snapshot (the channel is append-only
 * within a session, so it is a superset of the ones it replaced) and every caller of the burst
 * joins one drain.
 *
 * `persistSessionInner` is stubbed (it is the only seam that touches disk) so this exercises
 * the queue/coalescing logic without a filesystem.
 *
 * Run: pnpm --filter @codent/core run validate:session-persist-coalescing
 */

import assert from "node:assert/strict";

import { SessionService } from "../dist/dev.mjs";

const msg = (id) => ({ id, role: "user", parts: [{ type: "text", content: id }] });
const ui = (...ids) => ({ uiMessages: ids.map(msg) });

/** A service whose disk seam records payloads and lets a test hold a write open. */
function makeService() {
  const service = new SessionService();
  const written = [];
  let hold = null;
  service.persistSessionInner = async (input) => {
    written.push((input.uiMessages ?? []).map((m) => m.id).join(","));
    if (hold) {
      const gate = hold;
      hold = null;
      await gate.promise;
    }
    return true;
  };
  return {
    service,
    written,
    /** Hold the NEXT write open; returns the release function. */
    holdNext() {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      hold = { promise };
      return release;
    },
  };
}

const coalesce = (service, payload) => service.persistSession(() => payload, { coalesceUiMessages: true });

// ---------------------------------------------------------------------------
// 1. A synchronous burst writes the newest snapshot ONCE
// ---------------------------------------------------------------------------
{
  const { service, written } = makeService();
  // Admitted in the same tick, before the drain's first iteration can take one.
  const a = coalesce(service, ui("a"));
  const b = coalesce(service, ui("a", "b"));
  const c = coalesce(service, ui("a", "b", "c"));
  assert.deepEqual(await Promise.all([a, b, c]), [true, true, true], "every caller learns the write landed");
  assert.deepEqual(written, ["a,b,c"], "one write, with the newest snapshot");
}

// ---------------------------------------------------------------------------
// 2. A snapshot admitted DURING a write costs one more write (never lost)
// ---------------------------------------------------------------------------
{
  const { service, written, holdNext } = makeService();
  const release = holdNext();
  const first = coalesce(service, ui("a"));
  await Promise.resolve(); // let the drain take the first payload and start writing
  const second = coalesce(service, ui("a", "b"));
  const third = coalesce(service, ui("a", "b", "c"));
  release();
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.deepEqual(written, ["a", "a,b,c"], "the in-flight write plus one trailing write");
}

// ---------------------------------------------------------------------------
// 3. Sequential writes (awaited one at a time) are unchanged
// ---------------------------------------------------------------------------
{
  const { service, written } = makeService();
  await coalesce(service, ui("a"));
  await coalesce(service, ui("a", "b"));
  assert.deepEqual(written, ["a", "a,b"], "no coalescing when the caller waited");
}

// ---------------------------------------------------------------------------
// 4. A state-only write is never folded into a UI snapshot
// ---------------------------------------------------------------------------
{
  const { service, written, holdNext } = makeService();
  const release = holdNext();
  const uiWrite = coalesce(service, ui("a"));
  await Promise.resolve();
  // State-only (no uiMessages): must keep its own turn rather than be replaced/coalesced.
  const state = service.persistSession(() => ({ uiMessages: undefined }));
  release();
  assert.deepEqual(await Promise.all([uiWrite, state]), [true, true]);
  assert.deepEqual(written, ["a", ""], "the state write still runs, with no transcript payload");
}

// ---------------------------------------------------------------------------
// 5a. A failing write with nothing newer rejects (nothing landed)
// ---------------------------------------------------------------------------
{
  const { service, written } = makeService();
  service.persistSessionInner = async (input) => {
    written.push("failed:" + (input.uiMessages ?? []).map((m) => m.id).join(","));
    throw new Error("disk full");
  };
  await assert.rejects(coalesce(service, ui("a")), /disk full/);
  assert.deepEqual(written, ["failed:a"]);
}

// ---------------------------------------------------------------------------
// 5b. A failed write does not drop a snapshot admitted during it (and the burst converges)
// ---------------------------------------------------------------------------
{
  const { service, written } = makeService();
  const original = service.persistSessionInner;
  let failFirst = true;
  service.persistSessionInner = async (input) => {
    if (failFirst) {
      failFirst = false;
      written.push("failed:" + (input.uiMessages ?? []).map((m) => m.id).join(","));
      throw new Error("disk full");
    }
    return original(input);
  };
  const first = coalesce(service, ui("a"));
  await Promise.resolve();
  const second = coalesce(service, ui("a", "b"));
  assert.deepEqual(await Promise.all([first, second]), [true, true], "the newer snapshot converged");
  assert.deepEqual(written, ["failed:a", "a,b"], "the pending payload was not dropped by the failure");
}

// ---------------------------------------------------------------------------
// 6. Teardown waits for the coalesced drain
// ---------------------------------------------------------------------------
{
  const { service, written, holdNext } = makeService();
  const release = holdNext();
  const pending = coalesce(service, ui("a"));
  await Promise.resolve();
  const closing = service.close();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closed, false, "close waits for the in-flight write");
  release();
  await closing;
  assert.deepEqual(written, ["a"], "the admitted snapshot landed before close returned");
  assert.equal(await coalesce(service, ui("b")), false, "a closed service refuses new writes");
  void pending;
}

// ---------------------------------------------------------------------------
// 7. `awaitPersistIdle` covers the coalesced drain
// ---------------------------------------------------------------------------
{
  const { service, written, holdNext } = makeService();
  const release = holdNext();
  const first = coalesce(service, ui("a"));
  const second = coalesce(service, ui("a", "b"));
  await Promise.resolve(); // the drain took the newest payload and is held inside the write
  let idleResolved = false;
  const idle = service.awaitPersistIdle().then(() => {
    idleResolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(idleResolved, false, "idle waits for the coalesced drain");
  release();
  await idle;
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(written, ["a,b"], "the newest snapshot is the one that landed");
}

console.log("session persist coalescing validation passed");
