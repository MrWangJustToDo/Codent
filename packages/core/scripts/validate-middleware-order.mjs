/**
 * Validates the middleware phase pipeline (change: middleware-phase-pipeline):
 *
 * 1. Every middleware factory declares a phase, and the phases agree with the
 *    canonical pipeline order (`CANONICAL_MIDDLEWARE_ORDER`).
 * 2. `sortMiddlewaresByPhase` is stable and resolves the declared phases to
 *    exactly the historical array order (zero-behavior-change guarantee).
 * 3. Undeclared-phase middlewares fall through the sort and surface a warning.
 *
 * Run: pnpm --filter @codent/core run validate:middleware-order
 */

"use strict";

import assert from "node:assert/strict";

import {
  AgentStreamHub,
  CANONICAL_MIDDLEWARE_ORDER,
  buildAgentRunner,
  createApprovalResumeMiddleware,
  createBackgroundMiddleware,
  createCompactionMiddleware,
  createEarlyToolResultUiMiddleware,
  createExtensionsMiddleware,
  createLifecycleMiddleware,
  createMessageTransformMiddleware,
  createPlanModeMiddleware,
  createPromptCacheMiddleware,
  createRepeatReminderMiddleware,
  createStatusMiddleware,
  createTaskPreforkMiddleware,
  createTodoReminderMiddleware,
  createToolCompactMiddleware,
  createTurnContextMiddleware,
  createWireRecoveryMiddleware,
  MIDDLEWARE_PHASE_RANK,
  sortMiddlewaresByPhase,
  registerCoreEnv,
} from "../dist/dev.mjs";

registerCoreEnv({
  rootPath: "/tmp",
  fs: {},
  path: {},
  runCommand: async () => ({}),
  exec: async () => ({}),
  fetch: async () => new Response(""),
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => "/tmp",
});

/**
 * Universal self-returning stub: satisfies any deps object without calling
 * into real behavior (factories only store deps at creation time).
 */
function makeStub() {
  const stub = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "then") return undefined;
      return stub;
    },
    apply() {
      return stub;
    },
  });
  return stub;
}

const FACTORIES = [
  createStatusMiddleware,
  createApprovalResumeMiddleware,
  createLifecycleMiddleware,
  createCompactionMiddleware,
  createToolCompactMiddleware,
  createMessageTransformMiddleware,
  createWireRecoveryMiddleware,
  createTurnContextMiddleware,
  createExtensionsMiddleware,
  createEarlyToolResultUiMiddleware,
  createTaskPreforkMiddleware,
  createPlanModeMiddleware,
  createTodoReminderMiddleware,
  createRepeatReminderMiddleware,
  createBackgroundMiddleware,
  createPromptCacheMiddleware,
];

// --- 1. The pipeline the engine ACTUALLY assembles ---
//
// This reads the order out of `buildAgentRunner` rather than a duplicated factory
// list. A list copied here in canonical order would only re-assert itself: it never
// observes the real assembly, so moving a factory inside `buildAgentRunner` would
// leave this file green while the engine ran a different order.

const noop = () => {};

/** Stub ManagedAgent: factories only capture deps, and the `managed` getters are lazy. */
function makeManagedStub() {
  return {
    id: "validation-agent",
    parentId: undefined,
    config: {},
    run: {},
    getUI: () => undefined,
    getStreamHub: () => new AgentStreamHub(),
    tools: {},
    statusController: {},
    getApprovals: () => ({ toArray: () => [], upsert: noop }),
    usageHistory: { record: noop },
    usage: {},
    memory: { runExtraction: noop },
    session: { getSessionData: () => ({ id: "validation-session" }) },
    log: {
      warn: noop,
      info: noop,
      error: noop,
      debug: noop,
      child: () => ({ warn: noop, info: noop, error: noop, debug: noop }),
    },
    getTodoManager: () => ({}),
    getExtensionRunner: () => ({}),
    getLog: () => ({
      warn: noop,
      info: noop,
      error: noop,
      debug: noop,
      child: () => ({ warn: noop, info: noop, error: noop, debug: noop }),
    }),
    getWireProjectionCache: () => ({}),
    planMode: { isRestrictingTools: () => false, getPhase: () => "off" },
    getSystemPrompt: () => "",
    getFrozenSystemPrompt: () => "",
    getCompactionConfig: () => ({}),
    getModelInfo: () => undefined,
    getConfig: () => ({}),
    getToolCompactCache: () => undefined,
    getDynamicTurnContextSections: () => [],
    maybeSaveSessionUIMessages: noop,
    setIterationProgress: noop,
    getAgentDocContent: () => "",
  };
}

const liveRunner = buildAgentRunner(makeManagedStub(), { adapter: {}, model: "validation-model" }, {});
const liveNames = liveRunner.config.middleware.map((mw) => mw.name);

// Placement is asserted FIRST and on its own message: when the seam is misordered, the
// generic snapshot comparison below would fire too, and its "order drift" text would
// hide the fact that the transform seam is now ineffective. Report the specific
// contract first so a regression reads as what it actually is.
const compactionIdx = liveNames.indexOf("compaction");
const transformIdx = liveNames.indexOf("message-transform");
const toolCompactIdx = liveNames.indexOf("tool-compact");
const wireRecoveryIdx = liveNames.indexOf("wire-recovery");
assert.notEqual(compactionIdx, -1, "compaction middleware must be present in the assembled pipeline");
assert.notEqual(transformIdx, -1, "message-transform middleware must be present in the assembled pipeline");
assert.notEqual(toolCompactIdx, -1, "tool-compact middleware must be present in the assembled pipeline");
assert.notEqual(wireRecoveryIdx, -1, "wire-recovery middleware must be present in the assembled pipeline");
// The capability strip replaces media parts with a placeholder, so it has to run after
// the extension transform or an extension could never see a real attachment on a model
// that lacks vision. Both of those orderings have been broken by relocation before.
assert.equal(
  toolCompactIdx,
  compactionIdx + 1,
  `tool-compact must RUN immediately after compaction — it projects each tool result through ` +
    `its own toModelOutput, and running before the channel projection means it is wiped. ` +
    `Assembled order: ${liveNames.join(", ")}`
);
// The transform must see the FINAL wire: `tool-compact` re-projects tool results from the
// channel, so a transform running before it had its rewrite of a tool message silently
// replaced on the same call (a media-to-text transform was even re-materialized back to an
// image, which is a leak on a text-only model).
assert.equal(
  transformIdx,
  toolCompactIdx + 1,
  `message-transform must RUN immediately after tool-compact, so a transform's edit of a tool ` +
    `result is not overwritten by the tool's own projection. Assembled order: ${liveNames.join(", ")}`
);
// ...and after `tool-compact`, because that is what materializes TOOL media: the channel
// stores the result object, so the wire carries JSON text until the tool's `toModelOutput`
// projects it. Before this stage the strip could only ever see an attachment's part, so a
// tool's image went out untouched and the widened retry re-materialized it every call.
assert.equal(
  wireRecoveryIdx,
  transformIdx + 1,
  `wire-recovery must RUN immediately after message-transform: before it, a capability strip would ` +
    `hide the real media part from an extension transformer; before tool-compact, the strip cannot ` +
    `reach media that only exists once the tool result has been projected; before compaction, the ` +
    `channel projection would discard the strip. Assembled order: ${liveNames.join(", ")}`
);

assert.deepEqual(
  liveNames,
  [...CANONICAL_MIDDLEWARE_ORDER],
  "the pipeline buildAgentRunner assembles must match the canonical order snapshot"
);
assert.ok(
  liveNames.every((name) => typeof name === "string" && name.length > 0),
  "every assembled middleware declares a name"
);

// --- 2. Every factory declares a phase; phases resolve to the canonical order ---

const assembled = FACTORIES.map((factory) => factory(makeStub()));
const names = assembled.map((mw) => mw.name);
assert.deepEqual(names, [...CANONICAL_MIDDLEWARE_ORDER], "factory names must match the canonical order snapshot");
assert.ok(
  assembled.every((mw) => typeof mw.phase === "string"),
  "every middleware declares a phase"
);

// --- 3. Phase-sorted order === historical order (zero behavior change) ---

const warnings = [];
const sorted = sortMiddlewaresByPhase(assembled, (message) => warnings.push(message));
assert.equal(warnings.length, 0, "no undeclared-phase warnings expected");
assert.deepEqual(
  sorted.map((mw) => mw.name),
  [...CANONICAL_MIDDLEWARE_ORDER],
  "phase sort must resolve to the canonical order"
);

// Phase ranks are non-decreasing along the sorted pipeline.
for (let i = 1; i < sorted.length; i++) {
  const prev = MIDDLEWARE_PHASE_RANK[sorted[i - 1].phase];
  const curr = MIDDLEWARE_PHASE_RANK[sorted[i].phase];
  assert.ok(prev <= curr, `phase ranks must be non-decreasing at ${sorted[i].name}`);
}

// --- 4. Placement contract is asserted on the live pipeline (see section 1) ---
//
// `compaction` is channel-anchored: it rebuilds the wire from the UI channel and
// ignores the incoming `config.messages`. A transform running before it is therefore
// silently discarded — it would apply to the first call only. The assertion lives
// against `liveNames` in section 1, because the failure mode is a relocation inside
// `buildAgentRunner`, which the factory list below cannot observe.

// --- 5. Phase declarations resolve to the canonical order ---

const unphased = { name: "unphased-experiment" };
const warnings2 = [];
const mixed = sortMiddlewaresByPhase([{ name: "status", phase: "observe" }, unphased], (m) => warnings2.push(m));
assert.equal(warnings2.length, 1, "undeclared phase warns once");
assert.equal(mixed.at(-1).name, "unphased-experiment", "unphased middleware sorts last");

console.log("middleware-order validation passed");
