/**
 * Validation: the per-file mutation queue serializes, and drains.
 *
 * Run: pnpm --filter @codent/core run validate:file-mutation-queue
 *
 * The queue is a module-global map from file → the promise the NEXT operation waits on. Serializing
 * is its contract; the other half is that the map must empty itself, because nothing else removes an
 * entry — an agent session that edits thousands of files would otherwise keep one promise (and its
 * closure) per file for the life of the process.
 *
 * Both halves are asserted, including the case the tail delete has to get right: an entry may only
 * be dropped when nobody queued behind it, or a third operation would start concurrently with the
 * second one it should have waited for.
 */

import assert from "node:assert/strict";

import { createDeleteFileTool, fileMutationQueueSize, withFileMutationQueue } from "../dist/dev.mjs";

/**
 * The queue reads `rootPath` + `path.resolve`; `delete_file` also needs `fs.remove`, and both are
 * recorded so a test can see the ORDER operations actually ran in.
 */
const makeHost = (rootPath = "/ws") => {
  const ops = [];
  return {
    ops,
    env: {
      rootPath,
      path: { resolve: (p) => p },
      fs: {
        remove: async (p) => {
          ops.push(`remove:${p}`);
        },
      },
    },
  };
};
const env = (rootPath = "/ws") => makeHost(rootPath).env;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// 1. Same file: serialized, one entry at a time
// ============================================================================

{
  const timeline = [];
  const run = (label, ms) =>
    withFileMutationQueue(env(), "src/a.ts", async () => {
      timeline.push(`start-${label}`);
      await sleep(ms);
      timeline.push(`end-${label}`);
    });

  const first = run("1", 300);
  await sleep(20);
  const second = run("2", 20);
  assert.equal(fileMutationQueueSize(), 1, "one entry per file, not per queued operation");

  await Promise.all([first, second]);
  assert.deepEqual(
    timeline,
    ["start-1", "end-1", "start-2", "end-2"],
    `operations on one file must not overlap (${timeline.join(",")})`
  );
  assert.equal(fileMutationQueueSize(), 0, "the map drains once the chain is empty");
}

// ============================================================================
// 2. Different files: concurrent, and still drained afterwards
// ============================================================================

{
  const order = [];
  const slow = withFileMutationQueue(env(), "a.ts", async () => {
    order.push("a-start");
    await sleep(300);
    order.push("a-end");
  });
  const fast = withFileMutationQueue(env(), "b.ts", async () => {
    order.push("b-start");
    await sleep(20);
    order.push("b-end");
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(
    order,
    ["a-start", "b-start", "b-end", "a-end"],
    `different files run concurrently (${order.join(",")})`
  );
}

// ============================================================================
// 3. The tail check: a queued chain is not dropped by the operation ahead of it
// ============================================================================
//
// The delete is guarded by identity (`map.get(key) === our promise`). Without that guard, operation 1
// would remove the entry operation 2 is waiting on, so operation 3 — arriving while 2 runs — would
// read "no chain here" and start alongside it.

{
  const order = [];
  const op = (label, ms) =>
    withFileMutationQueue(env(), "c.ts", async () => {
      order.push(`start-${label}`);
      await sleep(ms);
      order.push(`end-${label}`);
    });

  const one = op("1", 40);
  await sleep(5);
  const two = op("2", 40); // queued behind 1, and still queued when 1 finishes
  await one;
  const three = op("3", 5); // arrives while 2 is running
  await Promise.all([two, three]);
  assert.deepEqual(
    order,
    ["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"],
    `a third operation must wait for the second, not for the map entry the first removed (${order.join(",")})`
  );
}

// ============================================================================
// 4. A long session: the map is proportional to concurrency, not to files touched
// ============================================================================

{
  const files = Array.from({ length: 60 }, (_, i) => `pkg-${i}/f.ts`);
  await Promise.all(files.map((file, i) => withFileMutationQueue(env(), file, async () => sleep(i % 3))));
  assert.equal(fileMutationQueueSize(), 0, "60 files touched, 0 entries left");

  // Margins here are for a loaded CI runner, not for this machine: the operations must still be in
  // flight when the size is read, so their duration is an order of magnitude above the read.
  const overlapping = Promise.all(
    Array.from({ length: 10 }, (_, i) => withFileMutationQueue(env(), `x-${i}.ts`, async () => sleep(400)))
  );
  await sleep(5);
  assert.equal(fileMutationQueueSize(), 10, "…while 10 files in flight hold exactly 10 entries");
  await overlapping;
  assert.equal(fileMutationQueueSize(), 0, "and drain again");
}

// ============================================================================
// 5. A throwing operation releases the queue it held
// ============================================================================

{
  await assert.rejects(
    () =>
      withFileMutationQueue(env(), "boom.ts", async () => {
        throw new Error("boom");
      }),
    /boom/
  );
  assert.equal(fileMutationQueueSize(), 0, "a failed operation leaves no entry behind");

  // …and the file is usable afterwards.
  const after = await withFileMutationQueue(env(), "boom.ts", async () => "ok");
  assert.equal(after, "ok", "the queue for that file still works");
  assert.equal(fileMutationQueueSize(), 0);
}

// ============================================================================
// 6. The key is per workspace: two runtimes do not serialize against each other
// ============================================================================

{
  const order = [];
  const a = withFileMutationQueue(env("/ws-a"), "same/rel.ts", async () => {
    order.push("a-start");
    await sleep(30);
    order.push("a-end");
  });
  const b = withFileMutationQueue(env("/ws-b"), "same/rel.ts", async () => {
    order.push("b-start");
    await sleep(5);
    order.push("b-end");
  });
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-start", "b-start", "b-end", "a-end"], `roots do not share a queue (${order.join(",")})`);
  assert.equal(fileMutationQueueSize(), 0);
}

// ============================================================================
// 7. `delete_file` waits on the same per-path queue as an edit or a write
// ============================================================================
//
// It used to run outside the queue, so a delete racing an edit of the same path could remove the file
// the edit had just re-created (or the edit could resurrect the one just deleted) — whichever promise
// happened to resolve last won.

{
  const { env: host, ops } = makeHost();
  const hold = withFileMutationQueue(host, "src/a.ts", async () => {
    await sleep(150);
    ops.push("mutator-done");
  });
  await sleep(20);

  const removed = createDeleteFileTool().execute(
    { path: "src/a.ts" },
    { toolCallId: "call-del", context: { coreEnv: host } }
  );
  await Promise.all([hold, removed]);

  const mutatorDone = ops.indexOf("mutator-done");
  const removeAt = ops.findIndex((op) => op.startsWith("remove:"));
  assert.ok(mutatorDone !== -1, `the mutator ran (${JSON.stringify(ops)})`);
  assert.ok(removeAt !== -1, `the delete ran (${JSON.stringify(ops)})`);
  assert.ok(
    removeAt > mutatorDone,
    `the delete must wait for the in-flight mutation of the same path (${JSON.stringify(ops)})`
  );
  assert.equal(fileMutationQueueSize(), 0, "…and the queue drains afterwards");
}

console.log("file-mutation-queue validation passed");
