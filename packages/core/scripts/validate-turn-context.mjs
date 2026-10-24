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
  contextAttributesFromText,
  contextKindFromText,
  extractContextSection,
  findCutPointByBudget,
  findLatestContextSectionsFromWire,
  findLatestTurnContextSectionHashesFromWire,
  formatContextSectionUserContent,
  hashTurnContextPayload,
  hashTurnContextSection,
  injectSyntheticMessages,
  isContextModelMessage,
  isContextUIMessage,
  syntheticKindFromId,
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
assert.match(
  update,
  /If earlier <current_date> blocks appear above/,
  "the notice names the section's own slot, not the ctx envelope"
);

const parsed = extractContextSection(update);
assert.deepEqual(parsed, section, "extract round-trips (notice stripped)");

const parsedFirst = extractContextSection(first);
assert.deepEqual(parsedFirst, section);
assert.equal(contextKindFromText(first), "current_date");

// Machine-readable shell attrs round-trip without leaking into the kind, and are not hashed.
const withAttrs = formatContextSectionUserContent({
  key: "reminder",
  content: "<reminder>body</reminder>",
  attrs: { cycle: "call-1", count: "3" },
});
assert.ok(withAttrs.startsWith('<ctx kind=reminder cycle="call-1" count="3">'), "attrs render on the ctx shell");
assert.equal(contextKindFromText(withAttrs), "reminder", "attrs do not leak into the kind");
assert.deepEqual(contextAttributesFromText(withAttrs), { cycle: "call-1", count: "3" });
assert.deepEqual(extractContextSection(withAttrs).attrs, { cycle: "call-1", count: "3" });
assert.equal(
  hashTurnContextSection(extractContextSection(withAttrs)),
  hashTurnContextSection({ key: "reminder", content: "<reminder>body</reminder>" }),
  "shell attrs are recovery state, not admission content"
);
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

// Recovery: latest occurrence of each kind in the wire wins, newest-first walk.
const gitSection = { key: "git_status", content: "<git_status>\nBranch: dev\n</git_status>" };
const gitV2 = { key: "git_status", content: "<git_status>\nBranch: main\n</git_status>" };
const wireHistory = [
  { role: "user", content: "hello" },
  { role: "user", content: formatContextSectionUserContent(section) },
  { role: "user", content: formatContextSectionUserContent(gitSection) },
  { role: "user", content: formatContextSectionUserContent(gitV2, { isUpdate: true }) },
  { role: "assistant", content: "hi" },
];
const seeded = findLatestTurnContextSectionHashesFromWire(wireHistory);
assert.equal(seeded.size, 2);
assert.equal(seeded.get("current_date"), hashTurnContextSection(section));
assert.equal(seeded.get("git_status"), hashTurnContextSection(gitV2), "newest git_status wins");
assert.equal(
  findLatestContextSectionsFromWire(wireHistory, new Set(["git_status"])).size,
  1,
  "a key filter limits what is recovered"
);

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

// Extension ids may contain hyphens. The nonce counter must recover the whole kind,
// not stop at the first dash, or a state cycle back to identical content is deduped.
assert.equal(syntheticKindFromId("ctx-codent-memory-deadbeef"), "codent-memory");
assert.equal(syntheticKindFromId("ctx-codent-memory-deadbeef-2"), "codent-memory");
assert.equal(syntheticKindFromId("ctx-current_date-1"), undefined, "a legacy nonce-only id carries no kind");
assert.equal(syntheticKindFromId("not-a-ctx-id"), undefined);

// Shell prefix constant is the single detection anchor.
assert.equal(CONTEXT_OPEN_PREFIX, "<ctx kind=");

// ---------------------------------------------------------------------------
// 8. Admission is stateless: the middleware reads the block back from the wire it is
//    handed, so a dropped block re-admits and a surviving one suppresses itself —
//    with no remembered hash map, message counter or reset call.
// ---------------------------------------------------------------------------
{
  const { AgentUIChannel, createTurnContextMiddleware } = await import("../dist/dev.mjs");
  const channel = new AgentUIChannel();
  channel.setMessages([{ id: "u1", role: "user", parts: [{ type: "text", content: "hello" }] }]);
  const middleware = createTurnContextMiddleware({
    getFrozenSystemPrompt: () => undefined,
    getSections: async () => [{ key: "current_date", content: "<current_date>now</current_date>" }],
    getUIChannel: () => channel,
    persistMessages: () => {},
    getManagedAgent: () => null,
  });
  // The real pipeline re-projects the wire from the channel on every model call.
  const projectWire = () =>
    channel.getMessages().map((message) => ({ role: message.role, content: message.parts[0].content }));
  const run = async () => {
    const before = projectWire();
    const result = await middleware.onConfig({}, { messages: before });
    return { before, after: result.messages ?? before };
  };

  const first = await run();
  assert.equal(first.after.length, 2, "first admit injects");
  const again = await run();
  assert.equal(again.after.length, again.before.length, "already in the window → no re-inject");

  // A compaction cut drops the block from the projected wire: it re-admits with no reset.
  const cutWire = [{ role: "user", content: "<CONVERSATION SUMMARY>…</CONVERSATION SUMMARY>" }];
  const afterCut = await middleware.onConfig({}, { messages: cutWire });
  assert.equal((afterCut.messages ?? cutWire).length, 2, "a cut that dropped the block re-admits it");

  // A long conversation with the block still in the window does NOT re-inject just because
  // it grew: admission is content-decided, there is no message-count refresh pass.
  const longWire = projectWire();
  for (let i = 0; i < 200; i++) longWire.push({ role: "user", content: `filler ${i}` });
  const grown = await middleware.onConfig({}, { messages: longWire });
  assert.equal(grown.messages, undefined, "an unchanged block in a grown window is not refreshed");
}

// ---------------------------------------------------------------------------
// 9. State cycles must re-inject: mode re-entry with identical instructions and
//    repeated nag reminders must never be swallowed by stable-id dedupe.
// ---------------------------------------------------------------------------
{
  const { AgentUIChannel, createTurnContextMiddleware } = await import("../dist/dev.mjs");
  const channel = new AgentUIChannel();
  const middleware = createTurnContextMiddleware({
    getFrozenSystemPrompt: () => undefined,
    getSections: async () => currentSections,
    getUIChannel: () => channel,
    persistMessages: () => {},
    getManagedAgent: () => null,
  });
  channel.setMessages([{ id: "u0", role: "user", parts: [{ type: "text", content: "hello" }] }]);
  const AUTO = buildAutoModePrompt();
  const INACTIVE = buildModeInactivePrompt();
  let currentSections = [{ key: "mode", content: AUTO }];
  const run = async () => {
    const wire = channel.getMessages().map((message) => ({
      role: message.role,
      content: message.parts[0].content,
    }));
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

  // Repeated nags with identical rounds value: the episode keeps ids/content unique.
  const { buildTodoReminderBody } = await import("../dist/dev.mjs");
  assert.notEqual(
    buildTodoReminderBody(3, 1),
    buildTodoReminderBody(3, 2),
    "same rounds at a later episode hashes differently (no dedupe swallow)"
  );
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

  await controller.collectExtensionPromptHooks("hello");
  assert.deepEqual(promptBefore, { prompt: "hello", hasTurnContext: true });
  assert.equal(runner.lastPrompt, "hello");
  assert.equal(runner.lastAgentId, "agent_turn_context");

  controller.resetTurnState();
  assert.equal(invalidations, 2, "resetTurnState also unfreezes the prompt");
  assert.ok(controller.getSystemPrompt().includes("doc-v2"), "resetTurnState rebuilds from current state");
}

// ---------------------------------------------------------------------------
// 11. Recovery reads the model-visible wire, not the durable channel: a cut is
//     only real on the wire, so a dropped block must not be recovered from the log.
// ---------------------------------------------------------------------------
{
  const wire = [
    { role: "user", content: "<ctx kind=current_date>\n<current_date>today</current_date>\n</ctx>" },
    { role: "assistant", content: "ok" },
  ];
  assert.equal(
    findLatestTurnContextSectionHashesFromWire(wire).get("current_date"),
    hashTurnContextSection({
      key: "current_date",
      content: "<current_date>today</current_date>",
    })
  );
  assert.equal(
    findLatestTurnContextSectionHashesFromWire([{ role: "user", content: "summary only" }]).size,
    0,
    "a compacted wire without the old ctx row has no recoverable hash"
  );
}

// ---------------------------------------------------------------------------
// 12. Middleware seeds from the post-compaction wire, not the channel: a stale
//     <ctx> row still present in the channel must not suppress re-admission.
// ---------------------------------------------------------------------------
{
  const { AgentUIChannel, createTurnContextMiddleware } = await import("../dist/dev.mjs");
  const channel = new AgentUIChannel();
  const currentDate = { key: "current_date", content: "<current_date>2026-10-21</current_date>" };
  channel.setMessages([
    { id: "u1", role: "user", parts: [{ type: "text", content: "hi" }] },
    {
      id: "ctx-current_date-1",
      role: "user",
      parts: [{ type: "text", content: formatContextSectionUserContent(currentDate) }],
    },
  ]);
  const middleware = createTurnContextMiddleware({
    getFrozenSystemPrompt: () => undefined,
    getSections: async () => [currentDate],
    getUIChannel: () => channel,
    persistMessages: () => {},
    getManagedAgent: () => null,
  });
  const result = await middleware.onConfig({}, { messages: [{ role: "user", content: "hi" }] });
  assert.equal(
    result.messages.length,
    2,
    "an old ctx row in the channel must not suppress current_date after compaction"
  );
}

// Hyphenated extension kinds must count their whole prefix when deriving the
// admission nonce; otherwise a state cycle back to identical content collides.
{
  const { AgentUIChannel, createTurnContextMiddleware } = await import("../dist/dev.mjs");
  const channel = new AgentUIChannel();
  let current = { key: "codent-memory", content: "<memory_index>a</memory_index>" };
  const middleware = createTurnContextMiddleware({
    getFrozenSystemPrompt: () => undefined,
    getSections: async () => [current],
    getUIChannel: () => channel,
    persistMessages: () => {},
    getManagedAgent: () => null,
  });
  channel.setMessages([{ id: "u0", role: "user", parts: [{ type: "text", content: "hello" }] }]);
  const run = async () => {
    const wire = channel.getMessages().map((message) => ({
      role: message.role,
      content: message.parts[0].content,
    }));
    const result = await middleware.onConfig({}, { messages: wire });
    return result.messages ?? wire;
  };
  const ids = () =>
    channel
      .getMessages()
      .map((message) => message.id)
      .filter((id) => id?.startsWith("ctx-codent-memory-"));
  await run();
  current = { key: "codent-memory", content: "<memory_index>b</memory_index>" };
  await run();
  current = { key: "codent-memory", content: "<memory_index>a</memory_index>" };
  await run();
  assert.equal(ids().length, 3, "hyphenated extension kind cycles get fresh nonces");
}

console.log("turn-context validation passed");
