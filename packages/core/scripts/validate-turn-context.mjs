/**
 * Validation for the unified synthetic-context injection:
 * - `<ctx kind=...>` shell format + kind parsing
 * - per-kind supersede notices + per-kind hash admission (only changed kinds inject)
 * - restore seeding from persisted messages
 * - subagent kind whitelist (context isolation)
 * - shared injection helper (channel persistence + dedupe)
 *
 * Run: pnpm --filter @codent/core run validate:turn-context
 */

import assert from "node:assert/strict";

import {
  CONTEXT_OPEN_PREFIX,
  SUBAGENT_ALLOWED_KINDS,
  TURN_CONTEXT_KINDS,
  buildAutoModePrompt,
  buildFrozenSystemPrompt,
  buildModeInactivePrompt,
  buildProjectInstructionsSection,
  buildSystemPromptWithTurnContext,
  buildTurnContextSections,
  contextKindFromText,
  extractContextSection,
  findCutPointByBudget,
  findLatestTurnContextSectionHashes,
  formatContextSectionUserContent,
  hashTurnContextPayload,
  hashTurnContextSection,
  injectSyntheticMessages,
  isContextModelMessage,
  isContextUIMessage,
  syntheticMessageId,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  TurnContextController,
} from "../dist/dev.mjs";

// ---------------------------------------------------------------------------
// 1. Frozen system prompt stays frozen — dynamic content never appended.
// ---------------------------------------------------------------------------
const frozen = buildFrozenSystemPrompt({
  config: { systemPrompt: "You are helpful." },
  agentDocContent: "",
});
assert.ok(frozen?.includes("<SYSTEM_PROMPT_DYNAMIC_BOUNDARY>"));

const withDynamic = buildSystemPromptWithTurnContext(frozen);
assert.deepEqual(withDynamic, [frozen]);
assert.ok(!withDynamic?.[0]?.includes("<ctx kind="));
assert.deepEqual(buildSystemPromptWithTurnContext(undefined), undefined);
assert.ok(SYSTEM_PROMPT_DYNAMIC_BOUNDARY.includes("DYNAMIC"));

// ---------------------------------------------------------------------------
// 2. Section building: mode category merges plan/auto (plan wins).
// ---------------------------------------------------------------------------
const autoPrompt = buildAutoModePrompt();
assert.match(autoPrompt, /<auto_mode>/);

const sections = buildTurnContextSections({
  currentDate: "September 2, 2026",
  gitBranch: "main",
  gitStatus: "M file.ts",
  relevantMemoryContent: "<relevant_memories>m</relevant_memories>",
  todoNagReminder: "<reminder>nag</reminder>",
  modeContent: '<plan_mode phase="planning">plan</plan_mode>',
  extensionTurnContextSections: [{ id: "codent-memory", content: "<memory_index>m</memory_index>" }],
});
// Built-in kinds come from the catalog so a rename cannot silently pass here.
assert.deepEqual(
  sections.map((s) => s.key),
  [
    TURN_CONTEXT_KINDS.currentDate,
    TURN_CONTEXT_KINDS.gitStatus,
    TURN_CONTEXT_KINDS.relevantMemories,
    TURN_CONTEXT_KINDS.reminder,
    TURN_CONTEXT_KINDS.mode,
    "codent-memory",
  ]
);
// Each extension gets its own kind tag (enable/disable share the same tag).
const memorySection = sections.find((s) => s.key === "codent-memory");
assert.ok(memorySection?.content.includes("<memory_index>"), "extension content kept under its own kind");
const modeSection = sections.find((s) => s.key === TURN_CONTEXT_KINDS.mode);
assert.ok(modeSection?.content.startsWith("<plan_mode"));
assert.ok(!modeSection?.content.includes("<auto_mode>"), "plan wins over auto in mode category");

const autoOnly = buildTurnContextSections({ modeContent: autoPrompt });
assert.equal(autoOnly.length, 1);
assert.ok(autoOnly[0].content.includes("<auto_mode>"));

// Inactive mode declaration: mode section is always present so exits are
// communicated and identical re-entries still re-inject (content = state).
const inactive = buildModeInactivePrompt();
assert.match(inactive, /<mode_state>/);
assert.match(inactive, /Neither plan mode nor auto mode is active/);
const inactiveSections = buildTurnContextSections({ modeContent: inactive });
assert.equal(inactiveSections.length, 1);
assert.equal(inactiveSections[0].key, "mode");

// Session-id section: emitted for the id, changes with it, never for subagents.
const sidSection = buildTurnContextSections({ sessionId: "ses_a" }).find((s) => s.key === TURN_CONTEXT_KINDS.sessionId);
assert.ok(sidSection, "session_id section is emitted when an id is present");
assert.match(sidSection.content, /<session_id>\nses_a\n<\/session_id>/);
const sidOther = buildTurnContextSections({ sessionId: "ses_b" }).find((s) => s.key === TURN_CONTEXT_KINDS.sessionId);
assert.notEqual(
  hashTurnContextSection(sidSection),
  hashTurnContextSection(sidOther),
  "a changed session id hashes differently, so it re-admits after a session switch"
);
assert.ok(!SUBAGENT_ALLOWED_KINDS.has(TURN_CONTEXT_KINDS.sessionId), "the session id is filtered from subagents");
assert.ok(
  !buildTurnContextSections({}).some((s) => s.key === TURN_CONTEXT_KINDS.sessionId),
  "no session id → no section"
);

// Nag reminder content carries the stale-round count so each nag produces a
// new hash / stable id (constant content would be deduped and never re-fire).
const { TodoManager } = await import("../dist/dev.mjs");
const tm = new TodoManager({
  log: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    agent: () => {},
    todo: () => {},
    clear: () => {},
  },
});
assert.notEqual(tm.getNagReminder(3), tm.getNagReminder(5), "nag content varies per episode");
assert.match(tm.getNagReminder(7), /unchanged for 7 rounds/);

// Nag throttling: after a nag, shouldNag() stays false until `nagCooldownRounds`
// more rounds elapse (token saving), then re-fires; an update resets the throttle.
const tm2 = new TodoManager({
  log: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    agent: () => {},
    todo: () => {},
    clear: () => {},
  },
});
tm2.update([{ content: "A", status: "in_progress", priority: "high" }], "Plan");
assert.equal(tm2.shouldNag(), false, "below threshold -> no nag");
tm2.incrementRound(); // 1
tm2.incrementRound(); // 2
tm2.incrementRound(); // 3 == threshold
assert.equal(tm2.shouldNag(), true, "threshold crossed -> nag fires");
tm2.getNagReminder(tm2.getRoundsSinceUpdate()); // record nag
assert.equal(tm2.shouldNag(), false, "cooldown active -> no immediate re-nag");
tm2.incrementRound(); // 4
tm2.incrementRound(); // 5
tm2.incrementRound(); // 6
tm2.incrementRound(); // 7
tm2.incrementRound(); // 8 == 3 + cooldown(5)
assert.equal(tm2.shouldNag(), true, "cooldown elapsed -> re-fires");
tm2.update([{ content: "B", status: "in_progress", priority: "high" }], "Plan"); // reset
assert.equal(tm2.shouldNag(), false, "update resets throttle -> below threshold");

// Subagent-only project_instructions section builder.
const projectSection = buildProjectInstructionsSection("Follow conventions.");
assert.equal(projectSection.key, TURN_CONTEXT_KINDS.projectInstructions);
assert.ok(projectSection.content.includes("<project_instructions>"));
assert.ok(projectSection.content.includes("Follow conventions."));

// ---------------------------------------------------------------------------
// 3. Shell format + kind parsing + per-kind supersede notice.
// ---------------------------------------------------------------------------
const section = { key: "current_date", content: "<current_date>\nJuly 22, 2026\n</current_date>" };
const first = formatContextSectionUserContent(section);
assert.ok(first.startsWith(`<ctx kind=current_date>\n<current_date>`));
assert.ok(first.endsWith("</current_date>\n</ctx>"));
assert.ok(!first.includes("authoritative"), "no supersede on first admit");

const update = formatContextSectionUserContent(section, { isUpdate: true });
assert.match(update, /If earlier <ctx kind=current_date> blocks appear above/);

const parsed = extractContextSection(update);
assert.deepEqual(parsed, section, "extract round-trips (notice stripped)");

const parsedFirst = extractContextSection(first);
assert.deepEqual(parsedFirst, section);
assert.equal(contextKindFromText(first), "current_date");
assert.equal(contextKindFromText("hello world"), undefined);
assert.ok(isContextUIMessage({ id: "x", role: "user", parts: [{ type: "text", content: first }] }));
assert.ok(!isContextUIMessage({ id: "x", role: "user", parts: [{ type: "text", content: "hello" }] }));
assert.ok(isContextModelMessage({ role: "user", content: first }));
assert.ok(!isContextModelMessage({ role: "user", content: "hello" }));

// ---------------------------------------------------------------------------
// 4. Per-kind hash admission (only changed kinds re-inject).
// ---------------------------------------------------------------------------
const hash = hashTurnContextSection(section);
assert.equal(hash, hashTurnContextPayload(section.content));
assert.notEqual(hash, hashTurnContextPayload(section.content + "x"));

const hashes = new Map();
hashes.set("current_date", hash);
assert.equal(hashes.get("current_date"), hash);

// Restore seeding: latest occurrence of each kind wins, newest-first walk.
const gitSection = { key: "git_status", content: "<git_status>\nBranch: dev\n</git_status>" };
const gitV2 = { key: "git_status", content: "<git_status>\nBranch: main\n</git_status>" };
const persisted = [
  { id: "u1", role: "user", parts: [{ type: "text", content: "hello" }] },
  { id: "s1", role: "user", parts: [{ type: "text", content: formatContextSectionUserContent(section) }] },
  { id: "s2", role: "user", parts: [{ type: "text", content: formatContextSectionUserContent(gitSection) }] },
  {
    id: "s3",
    role: "user",
    parts: [{ type: "text", content: formatContextSectionUserContent(gitV2, { isUpdate: true }) }],
  },
  { id: "a1", role: "assistant", parts: [{ type: "text", content: "hi" }] },
];
const seeded = findLatestTurnContextSectionHashes(persisted);
assert.equal(seeded.size, 2);
assert.equal(seeded.get("current_date"), hashTurnContextSection(section));
assert.equal(seeded.get("git_status"), hashTurnContextSection(gitV2), "newest git_status wins");

// ---------------------------------------------------------------------------
// 5. Shared injection helper: dedupe by stable id + channel persistence.
// ---------------------------------------------------------------------------
const uiMessages = [
  { id: "u1", role: "user", parts: [{ type: "text", content: "hello" }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", content: "hi" }] },
];
const channel = {
  messages: uiMessages,
  getMessages() {
    return this.messages;
  },
  setMessages(next) {
    this.messages = next;
  },
};
let persistedCount = 0;
const wire = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
  { role: "user", content: "next task" },
];
const entry = { kind: "current_date", content: first };
const entry2 = { kind: "git_status", content: formatContextSectionUserContent(gitSection) };

const injected = injectSyntheticMessages(wire, [entry, entry2], {
  ui: channel,
  persist: () => persistedCount++,
});
assert.equal(injected.injected.length, 2);
assert.equal(persistedCount, 1, "persist called once per batch");
// Channel: appended at the tail (time order preserved), after existing messages.
assert.equal(channel.messages.length, 4);
assert.equal(channel.messages[1].id, "a1");
assert.equal(channel.messages[2].id, syntheticMessageId(entry));
assert.equal(channel.messages[3].id, syntheticMessageId(entry2));
assert.equal(channel.messages[2].parts[0].content, first);
// Wire: appended at the tail too → prefix up to the append point stays byte-stable.
// The input array is NEVER edited: it may be the WireProjectionCache-retained
// projection, and pushing into it would replay the ctx on every later call.
assert.equal(wire.length, 3, "injectSyntheticMessages must not mutate the wire it is handed");
assert.equal(injected.messages.length, 5);
assert.equal(injected.messages[3].content, first);
assert.equal(injected.messages[4].content, entry2.content);

// Re-injecting the same content is a no-op (id dedupe).
const reinjected = injectSyntheticMessages(wire, [entry], { ui: channel, persist: () => persistedCount++ });
assert.equal(reinjected.injected.length, 0);
assert.equal(reinjected.messages, wire, "a no-op must return the input array unchanged");
assert.equal(channel.messages.length, 4);
assert.equal(persistedCount, 1);

// Append position (notification semantics): goes to the end of channel + wire.
const notifChannel = {
  messages: uiMessages.slice(),
  getMessages() {
    return this.messages;
  },
  setMessages(next) {
    this.messages = next;
  },
};
const notifWire = [{ role: "user", content: "run in bg" }];
const notifResult = injectSyntheticMessages(
  notifWire,
  [{ kind: "background_notification", content: `<ctx kind=background_notification>\njob done\n</ctx>` }],
  { ui: notifChannel, persist: () => {} }
);
assert.equal(notifChannel.messages.length, 3);
assert.equal(notifChannel.messages[2].parts[0].content.includes("job done"), true);
assert.equal(notifWire.length, 1, "the handed-in wire must not be mutated");
assert.equal(notifResult.messages.length, 2);
assert.equal(notifResult.messages[1].content.includes("job done"), true);

// Mid-loop mode-change re-admission: turn-context uses APPEND so a later ctx
// injection lands at the end (time order preserved) and never rewrites already-
// streamed content (prompt-cache prefix stability). after-last-user would put
// the later mode block BEFORE the earlier one (see bug: reversed mode + cache loss).
{
  const chan = {
    messages: [
      { id: "u1", role: "user", parts: [{ type: "text", content: "task" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", content: "first reply" }] },
    ],
    getMessages() {
      return this.messages;
    },
    setMessages(next) {
      this.messages = next;
    },
  };
  const wire = [
    { role: "user", content: "task" },
    { role: "assistant", content: "first reply" },
  ];

  // Mode switches mid-loop: first auto, then back to non-auto.
  const auto = { kind: "mode", content: `<ctx kind=mode>\n<auto_mode>on\n</auto_mode>\n</ctx>` };
  const nonAuto = { kind: "mode", content: `<ctx kind=mode>\n<mode_state>off\n</mode_state>\n</ctx>` };

  const afterAuto = injectSyntheticMessages(wire, [auto], { ui: chan, persist: () => {} }).messages;
  const afterNonAuto = injectSyntheticMessages(afterAuto, [nonAuto], { ui: chan, persist: () => {} }).messages;

  // Channel: auto first, nonAuto appended after it (NOT before).
  assert.equal(chan.messages.length, 4);
  assert.equal(chan.messages[2].parts[0].content.includes("<auto_mode>"), true);
  assert.equal(chan.messages[3].parts[0].content.includes("<mode_state>"), true);
  // Wire mirrors channel order (prefix up to the append point stays byte-stable).
  assert.equal(wire.length, 2, "the original wire stays untouched across both injections");
  assert.equal(afterNonAuto.length, 4);
  assert.equal(afterNonAuto[2].content.includes("<auto_mode>"), true);
  assert.equal(afterNonAuto[3].content.includes("<mode_state>"), true);
  assert.equal(afterNonAuto[0].content, "task");
  assert.equal(afterNonAuto[1].content, "first reply");
}

// ---------------------------------------------------------------------------
// 6. The budget walk never cuts on a synthetic context message.
// ---------------------------------------------------------------------------
const modelMessages = [
  { role: "user", content: "First" },
  { role: "assistant", content: "A1" },
  { role: "user", content: first },
  { role: "user", content: "Second" },
  { role: "assistant", content: "A2" },
  { role: "user", content: "Third" },
];
for (const budget of [4, 20, 100]) {
  const cut = findCutPointByBudget(modelMessages, budget);
  if (cut.cutIndex === 0) continue;
  const cutMessage = modelMessages[cut.cutIndex];
  assert.equal(isContextModelMessage(cutMessage), false, `budget ${budget}: never cut on a synthetic ctx message`);
}

// ---------------------------------------------------------------------------
// 7. Subagent kind whitelist (context isolation).
// ---------------------------------------------------------------------------
assert.deepEqual([...SUBAGENT_ALLOWED_KINDS].sort(), ["current_date", "git_status", "project_instructions"]);
assert.ok(!SUBAGENT_ALLOWED_KINDS.has("relevant_memories"), "no memory for subagents");
assert.ok(!SUBAGENT_ALLOWED_KINDS.has("mode"), "no plan/auto for subagents");
assert.ok(!SUBAGENT_ALLOWED_KINDS.has("codent-memory"), "no extension context for subagents");
assert.ok(!SUBAGENT_ALLOWED_KINDS.has("instruction_context"), "no instruction context for subagents");
assert.ok(!SUBAGENT_ALLOWED_KINDS.has("extension_system_append"), "no extension append channel for subagents");

// Shell prefix constant is the single detection anchor.
assert.equal(CONTEXT_OPEN_PREFIX, "<ctx kind=");

// ---------------------------------------------------------------------------
// 8. Middleware refresh threshold: admit baseline counter must advance after
//    each injection, otherwise aboveThreshold latches permanently.
// ---------------------------------------------------------------------------
{
  const { AgentUIChannel, createTurnContextMiddleware, DEFAULT_REFRESH_MESSAGE_THRESHOLD } =
    await import("../dist/dev.mjs");
  const channel = new AgentUIChannel();
  let hashStore = new Map();
  let admitCount = 0;
  const middleware = createTurnContextMiddleware({
    getFrozenSystemPrompt: () => undefined,
    getSections: async () => [{ key: "current_date", content: "<current_date>now</current_date>" }],
    getUIChannel: () => channel,
    persistMessages: () => {},
    getManagedAgent: () => null,
    getAdmittedHashes: () => hashStore,
    setAdmittedHashes: (next) => {
      hashStore = next;
    },
    getAdmitMessageCount: () => admitCount,
    setAdmitMessageCount: (count) => {
      admitCount = count;
    },
    refreshMessageThreshold: 3,
  });
  const seed = [];
  for (let i = 0; i < 2; i++) seed.push({ id: `u${i}`, role: "user", parts: [{ type: "text", content: `msg ${i}` }] });
  channel.setMessages(seed);

  const run = async () => {
    const wire = seed.map((m) => ({ role: "user", content: m.parts[0].content }));
    const result = await middleware.onConfig({}, { messages: wire });
    return result.messages ?? wire;
  };

  let wire = await run();
  assert.equal(wire.length, 3, "first admit injects");
  assert.equal(admitCount, channel.getMessages().length, "admit baseline advances after first injection");

  // Same content, below threshold → no injection.
  wire = await run();
  assert.equal(wire.length, 2, "unchanged + below threshold → no injection");

  // Push past the threshold → refresh fires even though the hash is unchanged.
  for (let i = 2; i < 5; i++)
    channel.setMessages([
      ...channel.getMessages(),
      { id: `u${i}`, role: "user", parts: [{ type: "text", content: `msg ${i}` }] },
    ]);
  wire = await run();
  assert.equal(wire.length, 3, "above threshold → supersede refresh injected");
  assert.equal(admitCount, channel.getMessages().length, "baseline advances after refresh");

  // After the refresh, another unchanged call below threshold must not inject again.
  wire = await run();
  assert.equal(wire.length, 2, "refresh does not latch: back to no-injection");
  assert.equal(DEFAULT_REFRESH_MESSAGE_THRESHOLD > 0, true);
}

// ---------------------------------------------------------------------------
// 9. State cycles must re-inject: mode re-entry with identical instructions and
//    repeated nag reminders must never be swallowed by stable-id dedupe.
// ---------------------------------------------------------------------------
{
  const { AgentUIChannel, createTurnContextMiddleware } = await import("../dist/dev.mjs");
  const channel = new AgentUIChannel();
  let hashStore;
  let admitCount = 0;
  const middleware = createTurnContextMiddleware({
    getFrozenSystemPrompt: () => undefined,
    getSections: async () => currentSections,
    getUIChannel: () => channel,
    persistMessages: () => {},
    getManagedAgent: () => null,
    getAdmittedHashes: () => hashStore,
    setAdmittedHashes: (next) => {
      hashStore = next;
    },
    getAdmitMessageCount: () => admitCount,
    setAdmitMessageCount: (count) => {
      admitCount = count;
    },
  });
  channel.setMessages([{ id: "u0", role: "user", parts: [{ type: "text", content: "hello" }] }]);
  const AUTO = buildAutoModePrompt();
  const INACTIVE = buildModeInactivePrompt();
  let currentSections = [{ key: "mode", content: AUTO }];
  const run = async () => {
    const wire = [{ role: "user", content: "hi" }];
    const r = await middleware.onConfig({}, { messages: wire });
    return r.messages ?? wire;
  };

  const modeIds = () =>
    channel
      .getMessages()
      .map((m) => m.id)
      .filter((id) => id?.startsWith("ctx-mode-"));
  // enter auto → exit (inactive) → re-enter auto (byte-identical instructions).
  const idsAfterEach = [];
  for (const content of [AUTO, INACTIVE, AUTO]) {
    currentSections = [{ key: "mode", content }];
    await run();
    idsAfterEach.push(modeIds().length);
  }
  assert.deepEqual(idsAfterEach, [1, 2, 3], "mode enter/exit/re-enter all inject (no id-gate swallow)");
  const injectedIds = modeIds();
  assert.equal(new Set(injectedIds).size, 3, "each admission gets a unique id (episode nonce)");
  assert.ok(injectedIds[2] !== injectedIds[0], "re-entry id differs from first entry");

  // Repeated nags with identical rounds value: episode counter keeps ids unique.
  const { TodoManager } = await import("../dist/dev.mjs");
  const tm = new TodoManager({
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      agent: () => {},
      todo: () => {},
      clear: () => {},
    },
  });
  const first = tm.getNagReminder(3);
  const second = tm.getNagReminder(3);
  assert.notEqual(first, second, "same rounds → different episode → different content");
  assert.ok(second.includes(`#2`), "episode counter is monotonic");
}

// ---------------------------------------------------------------------------
// 10. TurnContextController owns the frozen prompt + admission transaction.
// ---------------------------------------------------------------------------
{
  let config = { systemPrompt: "base prompt" };
  let doc = "doc-v1";
  let invalidations = 0;
  let promptBefore;
  let parentId;
  const generations = [];
  const runner = {
    lastPrompt: undefined,
    lastAgentId: undefined,
    async collectBeforeAgentStart(prompt, agentId) {
      this.lastPrompt = prompt;
      this.lastAgentId = agentId;
      return { turnContextSections: [{ id: "ext", content: "<ext>context</ext>" }] };
    },
  };
  const controller = new TurnContextController({
    agentId: "agent_turn_context",
    getConfig: () => config,
    getCoreEnv: () => ({}),
    getSessionId: () => "ses_turn_context",
    getTodoManager: () => null,
    getPlanState: () => ({
      phase: "off",
      planMarkdown: null,
      steps: [],
      enabledAt: null,
      todosSeeded: false,
      preservedExistingTodos: false,
      planFilePath: null,
    }),
    isAutoModeEnabled: () => false,
    getRelevantMemoryContent: () => "",
    getExtensionRunner: () => runner,
    getParentId: () => parentId,
    getBackgroundJobsSection: async (_messages, generation) => {
      generations.push(generation);
      return undefined;
    },
    onPromptBefore: (input) => {
      promptBefore = input;
    },
    invalidateRunner: () => {
      invalidations += 1;
    },
  });

  controller.setAgentDocContent(doc);
  const firstPrompt = controller.getSystemPrompt();
  assert.ok(firstPrompt?.includes("base prompt") && firstPrompt.includes("doc-v1"));
  doc = "doc-v2";
  controller.setAgentDocContent(doc);
  assert.equal(controller.getSystemPrompt(), firstPrompt, "the frozen prefix stays frozen until reset");

  controller.resetSystemPrompt();
  assert.equal(invalidations, 1, "resetSystemPrompt invalidates the cached runner");
  assert.ok(controller.getSystemPrompt().includes("doc-v2"), "the rebuilt prompt sees the new doc");

  controller.setAdmittedContextHashes(new Map([["current_date", "hash"]]));
  controller.setTurnContextAdmitMessageCount(9);
  await controller.getBackgroundJobsSection([]);
  assert.deepEqual(generations, [0], "the first jobs section uses generation 0");
  controller.resetAdmittedTurnContext();
  assert.equal(controller.getAdmittedContextHashes(), undefined);
  assert.equal(controller.getTurnContextAdmitMessageCount(), 0);
  await controller.getBackgroundJobsSection([]);
  assert.deepEqual(generations, [0, 1], "a context reset bumps the jobs generation");
  parentId = "parent-agent";
  await controller.getBackgroundJobsSection([]);
  assert.deepEqual(generations, [0, 1], "subagents never receive the jobs pointer");

  await controller.collectExtensionPromptHooks("hello");
  assert.deepEqual(promptBefore, { prompt: "hello", hasTurnContext: true });
  assert.equal(runner.lastPrompt, "hello");
  assert.equal(runner.lastAgentId, "agent_turn_context");

  controller.setAdmittedContextHashes(new Map([["mode", "hash"]]));
  controller.setTurnContextAdmitMessageCount(12);
  controller.resetTurnState();
  assert.equal(controller.getAdmittedContextHashes(), undefined);
  assert.equal(controller.getTurnContextAdmitMessageCount(), 0);
  assert.equal(invalidations, 2, "resetTurnState also unfreezes the prompt");
  assert.ok(controller.getSystemPrompt().includes("doc-v2"), "resetTurnState rebuilds from current state");
}

console.log("turn-context validation passed");
