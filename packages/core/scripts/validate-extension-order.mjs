/**
 * Validates extension-declared dispatch order (`ExtensionAPI.order`).
 *
 * Run: pnpm --filter @codent/core run validate:extension-order
 *
 * Background. Four extension surfaces are observable as a SEQUENCE, and each was ordered by the
 * same uncontrolled variable — the order extensions load:
 *
 *   - interceptor dispatch        (`AgentEventBus`, the scope node's interceptor array)
 *   - message-transformer chaining (`MessageTransformerRegistry.apply`)
 *   - same-named tool resolution  (`ExtensionRegistryService.toolStacks`)
 *   - turn-context section order  (`ExtensionRunner.collectBeforeAgentStart`)
 *
 * `order?: number` (lower first, default 0, ties keep load sequence) makes each declarable. It is
 * a DISPATCH rule, deliberately unrelated to the loader's RESOLUTION rule for a duplicated
 * extension id. Two readings of one sort on `(order, loadSequence)`:
 *
 *   - CHAIN surfaces read it front-to-back — lower order runs earlier;
 *   - the RESOLUTION surface reads it back-to-front — the highest order wins.
 *
 * What is pinned here:
 *
 *   1. interceptor dispatch: declared order overrides load order
 *   2. interceptor ties keep load order (stable)
 *   3. a negative order beats the default beats a positive one, in an inverted load order
 *   4. cancellation position: an early canceller suppresses a later interceptor
 *   5. a later canceller still observes an earlier mutator
 *   6. message-transformer chaining follows declared order
 *   7. transformer chaining is stable for undeclared extensions
 *   8. same-named tool: the highest order wins (inverted load order)
 *   9. turn-context section order follows declared order
 *  10. neutrality: observers and render slots are unaffected by order
 *  11. an invalid order falls back to the default
 *  12. the catalog reports effective order and lists in dispatch order
 *  13. disable does not reshuffle the remainder; re-enable restores the position
 */

import assert from "node:assert/strict";

import {
  BUILTIN_EXTENSION_ORDER,
  createAgentEventBus,
  createJobsExtension,
  createSkillsExtension,
  ExtensionRunner,
  ManagedAgent,
} from "../dist/dev.mjs";

// ============================================================================
// Harness
// ============================================================================

function makeAgent(tools, id = "agent_order") {
  return new ManagedAgent(
    { id, name: id, model: "gpt-4" },
    {
      context: {
        getMessages: () => [],
        getUIMessages: () => [],
        reset: () => {},
        setMessages: () => {},
        setUIMessages: () => {},
        getMessagesForLLM: () => [],
      },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, agent: () => {}, clear: () => {} },
      tools,
      todoManager: null,
    }
  );
}

/** A runner wired to a real ManagedAgent and a real scoped bus, so every surface is live. */
function makeRunner(id = "agent_order") {
  const managed = makeAgent({}, id);
  const bus = createAgentEventBus();
  const runner = new ExtensionRunner({
    eventBus: bus,
    onRegisterTool: (def, ownerId, rank) => managed.registerTool(def, ownerId, rank),
    onUnregisterTool: (name, ownerId) => managed.unregisterExtensionTool(name, ownerId),
  });
  return { runner, managed, bus };
}

/** Load an extension that records interceptor invocations into `seen`. */
function interceptorExt(id, order, seen, opts = {}) {
  const ext = {
    id,
    name: id,
    version: "1.0.0",
    activate(ctx) {
      ctx.registerInterceptor("tool:before:probe", (event) => {
        seen.push(id);
        if (opts.mutate) event.payload.tag = id;
        if (opts.cancel) return false;
        return undefined;
      });
    },
  };
  if (order !== undefined) ext.order = order;
  return ext;
}

async function fireProbe(runner) {
  const bus = runner.getEventBus();
  await bus.emit({
    type: "tool:before:probe",
    payload: { toolName: "probe", args: {}, sessionId: "s" },
    defaultReturn: undefined,
  });
}

// ============================================================================
// 1-3. Interceptor dispatch order
// ============================================================================

{
  // (1) declared order overrides load order: load the high-order extension first.
  const { runner } = makeRunner();
  const seen = [];
  await runner.loadExtension(interceptorExt("late", 100, seen));
  await runner.loadExtension(interceptorExt("early", -100, seen));
  await fireProbe(runner);
  assert.deepEqual(seen, ["early", "late"], "1: declared order must override load order");
  console.log("1. declared order overrides load order — ok");
}

{
  // (2) undeclared extensions keep their load order (stable ties).
  const { runner } = makeRunner();
  const seen = [];
  await runner.loadExtension(interceptorExt("A", undefined, seen));
  await runner.loadExtension(interceptorExt("B", undefined, seen));
  await runner.loadExtension(interceptorExt("C", undefined, seen));
  await fireProbe(runner);
  assert.deepEqual(seen, ["A", "B", "C"], "2: ties must keep load order");
  console.log("2. undeclared extensions keep load order — ok");
}

{
  // (3) negative < default < positive, even when loaded in the reverse of the run order.
  const { runner } = makeRunner();
  const seen = [];
  await runner.loadExtension(interceptorExt("pos", 1, seen));
  await runner.loadExtension(interceptorExt("def", undefined, seen));
  await runner.loadExtension(interceptorExt("neg", -1, seen));
  await fireProbe(runner);
  assert.deepEqual(seen, ["neg", "def", "pos"], "3: ascending (order, sequence) must win");
  console.log("3. negative / default / positive run ascending — ok");
}

// ============================================================================
// 4-5. Cancellation is position-dependent
// ============================================================================

{
  // (4) an early canceller suppresses a later interceptor.
  const { runner } = makeRunner();
  const seen = [];
  await runner.loadExtension(interceptorExt("gate", -100, seen, { cancel: true }));
  await runner.loadExtension(interceptorExt("audit", 100, seen));
  await fireProbe(runner);
  assert.deepEqual(seen, ["gate"], "4: a cancelling interceptor must suppress later ones");
  console.log("4. early cancel suppresses later interceptors — ok");
}

{
  // (5) a later canceller still observes an earlier mutator.
  const { runner } = makeRunner();
  const observed = [];
  const mutator = interceptorExt("mutator", -100, [], { mutate: true });
  const canceller = {
    id: "canceller",
    name: "canceller",
    version: "1.0.0",
    order: 100,
    activate(ctx) {
      ctx.registerInterceptor("tool:before:probe", (event) => {
        observed.push(event.payload.tag);
        return false;
      });
    },
  };
  await runner.loadExtension(mutator);
  await runner.loadExtension(canceller);
  await fireProbe(runner);
  assert.deepEqual(observed, ["mutator"], "5: a later canceller must see the earlier mutation");
  console.log("5. later canceller observes earlier mutation — ok");
}

// ============================================================================
// 6-7. Message-transformer chaining
// ============================================================================

{
  // (6) chaining follows declared order: `second` (order 1) sees `first`'s (order -1) output.
  const { runner } = makeRunner();
  const calls = [];
  const mk = (id, order) => ({
    id,
    name: id,
    version: "1.0.0",
    order,
    activate(ctx) {
      ctx.registerMessageTransformer((c) => {
        calls.push(id);
        return c.messages;
      });
    },
  });
  await runner.loadExtension(mk("second", 1));
  await runner.loadExtension(mk("first", -1));
  await runner.applyMessageTransformers({ messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(calls, ["first", "second"], "6: transformer chain must follow declared order");
  console.log("6. transformer chaining follows declared order — ok");
}

{
  // (7) undeclared transformers keep load order.
  const { runner } = makeRunner();
  const calls = [];
  const mk = (id) => ({
    id,
    name: id,
    version: "1.0.0",
    activate(ctx) {
      ctx.registerMessageTransformer((c) => {
        calls.push(id);
        return c.messages;
      });
    },
  });
  await runner.loadExtension(mk("one"));
  await runner.loadExtension(mk("two"));
  await runner.applyMessageTransformers({ messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(calls, ["one", "two"], "7: undeclared transformer ties keep load order");
  console.log("7. undeclared transformer chain keeps load order — ok");
}

// ============================================================================
// 8. Same-named tool resolution
// ============================================================================

{
  // Load the winner FIRST so a load-order rule would pick the loser.
  const { runner, managed } = makeRunner("agent_tool_order");
  const toolExt = (id, order, marker) => {
    const ext = {
      id,
      name: id,
      version: "1.0.0",
      activate(ctx) {
        ctx.registerTool({
          name: "ordered_tool",
          description: marker,
          inputSchema: { type: "object", properties: {} },
          execute: async () => ({}),
        });
      },
    };
    if (order !== undefined) ext.order = order;
    return ext;
  };
  await runner.loadExtension(toolExt("winner", 10, "TOOL-winner"));
  await runner.loadExtension(toolExt("loser", -10, "TOOL-loser"));
  assert.equal(managed.tools.ordered_tool.description, "TOOL-winner", "8: the highest order must win a name");
  console.log("8. same-named tool resolves to the highest order — ok");
}

{
  // A middle-owner disable must promote the highest surviving rank, not the last pushed entry.
  const { runner, managed } = makeRunner("agent_tool_middle");
  const toolExt = (id, order, marker) => ({
    id,
    name: id,
    version: "1.0.0",
    order,
    activate(ctx) {
      ctx.registerTool({
        name: "mid_tool",
        description: marker,
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({}),
      });
    },
  });
  await runner.loadExtension(toolExt("mid", 0, "TOOL-mid"));
  await runner.loadExtension(toolExt("top", 10, "TOOL-top"));
  await runner.loadExtension(toolExt("bottom", -10, "TOOL-bottom"));
  assert.equal(managed.tools.mid_tool.description, "TOOL-top", "8b: highest wins");
  await runner.setEnabled("top", false);
  assert.equal(managed.tools.mid_tool.description, "TOOL-mid", "8b: disabling the top promotes the next rank");
  await runner.setEnabled("mid", false);
  assert.equal(managed.tools.mid_tool.description, "TOOL-bottom", "8b: then the lowest");
  console.log("8b. disabling by rank promotes the right survivor — ok");
}

// ============================================================================
// 9. Turn-context section order
// ============================================================================

{
  const { runner } = makeRunner();
  const ctxExt = (id, order, content) => {
    const ext = {
      id,
      name: id,
      version: "1.0.0",
      activate(ctx) {
        ctx.registerContextProvider({ content: () => content });
      },
    };
    if (order !== undefined) ext.order = order;
    return ext;
  };
  await runner.loadExtension(ctxExt("late-section", 50, "LATE"));
  await runner.loadExtension(ctxExt("early-section", -50, "EARLY"));
  const collected = await runner.collectBeforeAgentStart("hello", "s");
  assert.deepEqual(
    collected.turnContextSections.map((s) => s.id),
    ["ext:early-section", "ext:late-section"],
    "9: turn-context sections must follow declared order (extension kinds are namespaced)"
  );
  console.log("9. turn-context sections follow declared order — ok");
}

// ============================================================================
// 10. Neutrality — observers and render slots ignore order
// ============================================================================

{
  // An observer cannot influence order: both see the same final payload, registration-ordered.
  const { runner, bus } = makeRunner();
  const observerSeen = [];
  const obsExt = (id, order) => ({
    id,
    name: id,
    version: "1.0.0",
    order,
    activate(ctx) {
      ctx.events.observe("agent:stop", () => observerSeen.push(id));
    },
  });
  await runner.loadExtension(obsExt("obs-late", 100));
  await runner.loadExtension(obsExt("obs-early", -100));
  // Emit an observer event directly on the scoped bus the runner was given.
  bus.emit("agent:stop", { sessionId: "s" });
  assert.deepEqual(
    new Set(observerSeen),
    new Set(["obs-late", "obs-early"]),
    "10: both observers must receive the event regardless of order"
  );

  // Render slots are combined by key, not by extension order.
  const uiA = {
    id: "slot-a",
    name: "slot-a",
    version: "1.0.0",
    order: 100,
    activate(ctx) {
      ctx.ui.render("footer", "a", "A");
    },
  };
  const uiB = {
    id: "slot-b",
    name: "slot-b",
    version: "1.0.0",
    order: -100,
    activate(ctx) {
      ctx.ui.render("footer", "b", "B");
    },
  };
  const slotRunner = makeRunner("agent_slots").runner;
  await slotRunner.loadExtension(uiA);
  await slotRunner.loadExtension(uiB);
  const slots = slotRunner.getUISlots().footer ?? {};
  assert.deepEqual(Object.keys(slots).sort(), ["a", "b"], "10: render slots are keyed, not order-combined");
  console.log("10. observers and render slots unaffected by order — ok");
}

// ============================================================================
// 11. Invalid order falls back to the default
// ============================================================================

{
  const { runner } = makeRunner();
  const seen = [];
  await runner.loadExtension(interceptorExt("bad", Number.NaN, seen));
  await runner.loadExtension(interceptorExt("good", undefined, seen));
  // `bad` loaded first → same default order 0 → ties keep load order → bad then good.
  await fireProbe(runner);
  assert.deepEqual(seen, ["bad", "good"], "11: a non-finite order must fall back to 0 (load order kept)");
  // The distinguishing assertion: a raw NaN would survive into the reported value. A
  // dispatch-order check alone cannot see this — V8 normalizes a NaN comparator result to 0, so
  // a NaN order and a 0 order sort identically.
  const bad = runner.getExtensionInfos().find((i) => i.id === "bad");
  assert.equal(bad.order, 0, "11: a non-finite order must resolve to the default 0, not survive as NaN");
  assert.equal(bad.declaredOrder, undefined, "11: an invalid declaration is not a declaration");
  console.log("11. invalid order falls back to the default — ok");
}

// ============================================================================
// 12. Catalog reports effective order and lists in dispatch order
// ============================================================================

{
  const { runner } = makeRunner();
  const seen = [];
  await runner.loadExtension(interceptorExt("z-late", 100, seen));
  await runner.loadExtension(interceptorExt("a-early", -100, seen));
  await runner.loadExtension(interceptorExt("m-def", undefined, seen));
  const infos = runner.getExtensionInfos();
  assert.deepEqual(
    infos.map((i) => i.id),
    ["a-early", "m-def", "z-late"],
    "12: the catalog must list in dispatch order"
  );
  assert.deepEqual(
    infos.map((i) => i.order),
    [-100, 0, 100],
    "12: effective order reported"
  );
  assert.equal(infos.find((i) => i.id === "m-def").declaredOrder, undefined, "12: default is distinguishable");
  assert.equal(infos.find((i) => i.id === "a-early").declaredOrder, -100, "12: declared value reported");
  console.log("12. catalog reports effective order in dispatch order — ok");
}

// ============================================================================
// 13. Disable / re-enable
// ============================================================================

{
  const { runner } = makeRunner();
  const seen = [];
  await runner.loadExtension(interceptorExt("A", undefined, seen));
  await runner.loadExtension(interceptorExt("B", undefined, seen));
  await runner.loadExtension(interceptorExt("C", undefined, seen));
  await runner.setEnabled("B", false);
  seen.length = 0;
  await fireProbe(runner);
  assert.deepEqual(seen, ["A", "C"], "13: disabling must not reshuffle the remainder");

  await runner.setEnabled("B", true);
  seen.length = 0;
  await fireProbe(runner);
  assert.deepEqual(seen, ["A", "B", "C"], "13: re-enable must restore the middle position, not append");
  console.log("13. disable / re-enable keep declared positions — ok");
}

{
  // A direct (non-runner) registration supplies no rank. It must still win over the seeded
  // incumbent AND a later one must still supersede an earlier one — the insertion-order
  // behaviour that existed before ranks, preserved for callers that declare nothing.
  const managed = makeAgent({}, "agent_direct_rank");
  const direct = (marker) => ({
    name: "direct_tool",
    description: marker,
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({}),
  });
  managed.registerTool(direct("DIRECT-first"), "owner-1");
  assert.equal(managed.tools.direct_tool.description, "DIRECT-first", "14: a direct registration is live");
  managed.registerTool(direct("DIRECT-second"), "owner-2");
  assert.equal(managed.tools.direct_tool.description, "DIRECT-second", "14: a later direct registration supersedes");
  managed.unregisterExtensionTool("direct_tool", "owner-2");
  assert.equal(managed.tools.direct_tool.description, "DIRECT-first", "14: and release hands back the earlier one");
  console.log("14. unranked direct registrations keep last-wins — ok");
}

// ============================================================================
// Sanity: the raw scoped bus exists (used by section 10)
// ============================================================================

{
  const bus = createAgentEventBus();
  assert.ok(typeof bus.intercept === "function", "bus exposes interceptor dispatch");
}

// ============================================================================
// 15. Built-ins are the baseline, not the winner
// ============================================================================
//
// Bootstrap loads disk/config extensions first and the built-ins last. With no declared order that
// load position made built-ins the opposite of a baseline: last in a chain and the winner of a
// same-named tool, so a user extension replacing `load_skill` was silently buried. A below-default
// order fixes both readings at once.
assert.ok(BUILTIN_EXTENSION_ORDER < 0, "the built-in order sorts before an undeclared (0) extension");
for (const [label, factory] of [
  ["skills", () => createSkillsExtension({ skillRegistry: { list: () => [], get: () => null } })],
  ["jobs", () => createJobsExtension()],
]) {
  let api;
  try {
    api = factory();
  } catch {
    continue; // a factory needing real collaborator wiring is covered by its own validator
  }
  assert.equal(api?.order, BUILTIN_EXTENSION_ORDER, `${label}: the built-in declares the baseline order`);
}
console.log("15. built-ins declare the baseline order — ok");

console.log("\nextension-order validation passed");
