/**
 * Validation for the `extension-ui` session channel end-to-end (core → session).
 *
 * Covers:
 * - `ctx.ui.notify(message, level)` reaches the channel as `{ type: "notify", message, level }`
 *   (the exact shape the host bridge switches on — a mismatched shape is silently dropped)
 * - `ctx.ui.render(surface, key, payload)` reaches the channel as a `render` event
 * - a late subscriber replays retained slots
 * - disabling the extension clears its slot through the channel
 *
 * Run: pnpm --filter @codent/core run validate:extension-ui-channel
 */

import assert from "node:assert/strict";

import { ExtensionRunner, createAgentEventBus, createLocalAgentSession } from "../dist/dev.mjs";

// --- Minimal managed-agent stub: only what `subscribe` / `getEventBus` touch ---
const bus = createAgentEventBus("agent-1");
const runner = new ExtensionRunner({ eventBus: bus, cwd: "/workspace" });

const managed = {
  id: "agent-1",
  parentId: undefined,
  name: "agent-1",
  getEventBus: () => bus,
  getExtensionRunner: () => runner,
  log: null,
  getStatus: () => "idle",
  error: "",
  pendingApprovalCount: 0,
  childIds: [],
  chatController: { getMessages: () => [], getQueuedMessages: () => ({ steer: [], followUp: [] }) },
  planMode: {
    getState: () => ({
      phase: "off",
      planMarkdown: null,
      steps: [],
      enabledAt: null,
      todosSeeded: false,
      preservedExistingTodos: false,
      planFilePath: null,
    }),
  },
  isAutoModeEnabled: () => false,
  getL1State: () => ({ status: "idle", name: "agent-1", error: "", pendingApprovalCount: 0 }),
  readInteractions: () => ({ approvals: [], askUser: [] }),
  readIteration: () => ({ current: 0, max: 0 }),
  getLastStreamDurationMs: () => 0,
  getAgentMode: () => "normal",
  usage: { snapshot: () => null },
  getTodoManager: () => ({ snapshot: () => ({ items: [], title: null }) }),
  getMcpManager: () => null,
};

const session = createLocalAgentSession({ managed });

const events = [];
session.subscribe(
  (event) => {
    if (event.channel === "extension-ui") events.push(event.payload);
  },
  { channels: ["extension-ui"] }
);

await runner.loadExtension({
  id: "probe",
  name: "probe",
  version: "1.0.0",
  activate(ctx) {
    ctx.ui.notify("LSP: typescript ready", "success");
    ctx.ui.render("footer", "k", "v");
  },
});
await new Promise((resolve) => setTimeout(resolve, 60));

// 1. Live delivery: the notify payload shape must match the host bridge exactly.
assert.deepEqual(
  events.find((e) => e.type === "notify"),
  { type: "notify", message: "LSP: typescript ready", level: "success" },
  "notify reaches the extension-ui channel with { type, message, level }"
);
assert.deepEqual(
  events.find((e) => e.type === "render"),
  { type: "render", surface: "footer", key: "k", payload: "v" },
  "render reaches the extension-ui channel"
);

// 2. Late subscriber: retained slots are replayed per subscription.
const replayed = [];
session.subscribe(
  (event) => {
    if (event.channel === "extension-ui") replayed.push(event.payload);
  },
  { channels: ["extension-ui"] }
);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.ok(
  replayed.some((e) => e.type === "render" && e.key === "k" && e.payload === "v"),
  "late subscriber replays retained render slots"
);

// 3. Owner teardown travels the channel as a null payload (remove signal).
await runner.setEnabled("probe", false);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.deepEqual(
  events.at(-1),
  { type: "render", surface: "footer", key: "k", payload: null },
  "disable clears the slot"
);

// 4. A throwing subscriber is contained, and disabling stops delivery.
//
// `ctx.ui.subscribe` is the one UI surface that takes extension code, and `Emitter` swallows only
// synchronous throws: an `async` rejection used to escape to `unhandledRejection`, which the CLI's
// process guards turn into `exit(1)`. The subscription also used to survive `setEnabled(false)`.
const failures = [];
bus.on("agent:extension-error", (event) => failures.push(event.payload));

let deliveries = 0;
const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);
try {
  await runner.loadExtension({
    id: "subscriber",
    name: "subscriber",
    version: "1.0.0",
    activate(ctx) {
      ctx.ui.subscribe("notify", async () => {
        deliveries += 1;
        throw new Error("async handler boom");
      });
    },
  });
  await runner.loadExtension({
    id: "emitter",
    name: "emitter",
    version: "1.0.0",
    activate(ctx) {
      ctx.ui.notify("hello from emitter", "info");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.ok(deliveries >= 1, "the subscriber receives extension-ui notifications");
  assert.ok(
    failures.some((event) => String(event.error ?? "").includes("async handler boom")),
    "the rejection is reported as agent:extension-error instead of escaping"
  );
  assert.deepEqual(unhandled, [], "an async subscriber rejection must not escape the runtime");

  // Disabling stops delivery: the subscription is tracked with the extension's registrations.
  const before = deliveries;
  await runner.setEnabled("subscriber", false);
  await runner.loadExtension({
    id: "emitter-2",
    name: "emitter-2",
    version: "1.0.0",
    activate(ctx) {
      ctx.ui.notify("after disable", "info");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(deliveries, before, "a disabled extension's UI subscription no longer delivers");
} finally {
  process.off("unhandledRejection", onUnhandled);
}

console.log("extension-ui-channel validation passed");
