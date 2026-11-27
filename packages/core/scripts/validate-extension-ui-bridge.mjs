/**
 * The extension UI bridge subscribes to `agent:state` / `session:usage` / `session:mode` on a SCOPED
 * bus. Delivery is `self → ancestors`, so those three arrive from a delegated child as well; the
 * snapshot the bridge pushes is read from the OWNER's retained values, which means an unfiltered
 * subscription emits a byte-identical `extension:ui` context frame every throttle window (250 ms) for
 * the whole life of a `task` — invisible except as traffic, and trivially reintroduced by deleting one
 * `if`.
 *
 * The up-flow premise is asserted first: without it, "the child pushed nothing" would also hold when
 * delivery itself is broken, i.e. the filter assertions would pass vacuously.
 *
 * The filter must not be over-tightened either: the owner's own frames must still push, and frames
 * inside one throttle window must still coalesce. `bus.scopeId` is the owner identity (a scope's own
 * events carry it), so this also covers a standalone runner whose bus is its own scope.
 *
 * Run: pnpm --filter @codent/core run validate:extension-ui-bridge
 */

import assert from "node:assert/strict";

import { createAgentEventBus, createExtensionUiBridge } from "../dist/dev.mjs";

import { sleep, waitFor } from "./helpers/log-capture.mjs";

/** Longer than CONTEXT_THROTTLE_MS (250), for the NEGATIVE assertions only (absence needs a window). */
const SETTLE_MS = 320;

const root = createAgentEventBus();
const parent = root.scope("agent-parent");
const child = parent.scope("agent-child");

let pushes = 0;
let arrived = 0;
parent.on("agent:state", () => {
  arrived += 1;
});
parent.on("extension:ui", (event) => {
  if (event.payload?.type === "context") pushes += 1;
});

const bridge = createExtensionUiBridge({ bus: parent, reportFailure: () => {} });

// Premise: a child's event really reaches the parent scope. If delivery breaks, the assertions below
// would otherwise pass for the wrong reason.
child.emit("agent:state", { status: "running" });
await waitFor(
  () => arrived,
  (count) => count >= 1
);
assert.ok(arrived >= 1, "the child's agent:state reached the parent scope (up-flow premise)");

// …and it must NOT push the parent's extension context.
await sleep(SETTLE_MS);
assert.equal(pushes, 0, "a child agent's state must not push the parent's extension context");

child.emit("session:usage", {});
child.emit("session:mode", { mode: "normal" });
await sleep(SETTLE_MS);
assert.equal(pushes, 0, "usage/mode from a child are filtered the same way");

// The owner's own state still pushes — the filter must not over-tighten.
parent.emit("agent:state", { status: "running" });
await waitFor(
  () => pushes,
  (count) => count >= 1
);
assert.equal(pushes, 1, "the owner's own state pushes the extension context");

// Throttled, not per frame: two owner frames inside one window coalesce into one push.
parent.emit("agent:state", { status: "idle" });
parent.emit("agent:state", { status: "running" });
await waitFor(
  () => pushes,
  (count) => count >= 2
);
assert.equal(pushes, 2, "owner frames coalesce per throttle window instead of emitting per event");

// Disposed: a late owner frame must not resurrect the push loop.
bridge.dispose();
parent.emit("agent:state", { status: "idle" });
await sleep(SETTLE_MS);
assert.equal(pushes, 2, "a disposed bridge stops pushing");

console.log("extension-ui-bridge validation passed");
