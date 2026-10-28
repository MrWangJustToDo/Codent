/**
 * Validation for the built-in Memory extension (`codent-memory`).
 *
 * Covers:
 * - createMemoryExtension is exported and produces an extension API
 * - activation registers memory_list / memory_read / memory_write tools
 * - activation registers a turn-context provider that emits the <memory_index>
 * - activation registers a /memory command that injects the full memory body
 * - memory tools operate against a real MemoryManager-backed store
 * - MemoryExtensionConfig can disable tools / index independently
 * - ManagedAgentConfig.memory accepts boolean | MemoryExtensionConfig (typecheck)
 *
 * Run: pnpm --filter @codent/core run validate:memory-extension
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";

import { registerCoreEnv, MemoryManager, MemoryService, createMemoryExtension } from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const root = await mkdtemp(join(tmpdir(), "codent-memory-ext-"));

// Minimal CoreEnv backed by the real filesystem, scoped to `root`.
registerCoreEnv({
  rootPath: root,
  path: {
    join: (...p) => join(...p),
    dirname: (p) => dirname(p),
    basename: (p, ext) => (ext ? basename(p, ext) : basename(p)),
    extname: (p) => extname(p),
    resolve: (...p) => resolve(...p),
    normalize: (p) => normalize(p),
    isAbsolute: (p) => isAbsolute(p),
    getSep: () => sep,
    parse: (p) => parse(p),
  },
  getPlatform: async () => "test",
  getArch: async () => "test",
  getEnv: async () => ({}),
  homedir: async () => root,
  byteLength: (s) => Buffer.byteLength(s, "utf-8"),
  fs: {
    readFile: async (p) => readFile(p, "utf-8"),
    stat: async (p) => {
      const s = await stat(p);
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
    },
    readdir: async (p) => {
      const names = await readdir(p);
      return names.map((name) => ({ name, type: "file" }));
    },
    writeFile: async (p, content) => writeFile(p, content),
    mkdir: async (p) => {
      await mkdir(p, { recursive: true });
    },
    exists: async (p) => {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    },
    remove: async (p) => {
      await rm(p, TEMP_RM_OPTIONS);
    },
  },
});

// ---------------------------------------------------------------------------
// 1. Extension factory shape
// ---------------------------------------------------------------------------
const manager = new MemoryManager({ rootPath: root });
await manager.initialize();
await manager.writeMemory("user-prefers-tabs", "user", "Prefers tabs over spaces", "Always use tabs for indentation.");
await manager.flushIndex(); // writeMemory debounces index refresh — flush synchronously for the test

/**
 * The selection state (surfaced set, pending commit, injected body) lives in the owning
 * `MemoryService`; the extension is only the per-turn trigger. The lifecycle calls
 * `memoryService.resetState()` on a session switch, which is what the test simulates below.
 */
const memoryService = new MemoryService();
memoryService.setManager(manager);

const api = createMemoryExtension({ memoryManager: manager, selection: memoryService });
assert.equal(api.id, "codent-memory", "extension id is codent-memory");
assert.equal(typeof api.activate, "function", "extension has activate");

/**
 * Activation context. The extension is an ordinary extension: tools/commands/providers plus the
 * observer and `ctx.llm` ports the selection flow needs. `selection` answers from the fake
 * completion, so the test never touches a provider.
 */
function makeCtx(overrides = {}) {
  const observers = new Map();
  const llmCalls = [];
  const ctx = {
    id: "codent-memory",
    agentId: "agent-1",
    sessionId: "ses_1",
    signal: undefined,
    z: overrides.z,
    getMessages: () => [{ role: "user", content: "How do I indent?" }],
    events: {
      observe: (type, handler) => {
        observers.set(type, handler);
        return () => observers.delete(type);
      },
    },
    llm: {
      complete: async (request) => {
        llmCalls.push(request);
        return { data: { selected_memories: overrides.selected ?? ["user-prefers-tabs"] } };
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      log: () => {},
    },
    registerTool: (def) => (overrides.tools ?? []).push(def),
    registerCommand: (cmd) => (overrides.commands ?? []).push(cmd),
    registerInterceptor: () => () => {},
    registerContextProvider: (provider) => {
      overrides.onProvider?.(provider);
      return () => {};
    },
    ...overrides.extra,
  };
  return { ctx, observers, llmCalls };
}

// ---------------------------------------------------------------------------
// 2. Activation registers tools + turn-context provider
// ---------------------------------------------------------------------------
const registeredTools = [];
const registeredCommands = [];
let contextProvider = null;
const {
  ctx: mockCtx,
  observers,
  llmCalls,
} = makeCtx({
  z: (await import("zod")).z,
  tools: registeredTools,
  commands: registeredCommands,
  onProvider: (provider) => {
    contextProvider = provider;
  },
});
await api.activate(mockCtx);

const toolNames = registeredTools.map((t) => t.name);
assert.ok(toolNames.includes("memory_list"), "registers memory_list");
assert.ok(toolNames.includes("memory_read"), "registers memory_read");
assert.ok(toolNames.includes("memory_write"), "registers memory_write");

// memory_list is lazy (the <memory_index> already carries its whole payload, so the
// eager schema was per-turn prompt cost for a tool called once in 195 root runs).
const listDef = registeredTools.find((t) => t.name === "memory_list");
assert.equal(listDef.lazy, true, "memory_list is registered lazy");
assert.ok(
  listDef.description.includes("__lazy__tool__discovery__"),
  "memory_list description names the discovery tool"
);
// The other two stay eager: memory_read is a second hop the model reaches for
// mid-task, and memory_write is the visible path when the user says "remember".
assert.notEqual(registeredTools.find((t) => t.name === "memory_read").lazy, true, "memory_read stays eager");
assert.notEqual(registeredTools.find((t) => t.name === "memory_write").lazy, true, "memory_write stays eager");

// The three tools' result bodies reach the transcript. They declared only a fold category, so the
// TUI showed a bare row while the model read the result through `toModelOutput`.
const displayOf = (name) => registeredTools.find((tool) => tool.name === name)?.present?.text;
for (const name of ["memory_list", "memory_read", "memory_write"]) {
  assert.equal(typeof displayOf(name), "function", `${name} declares a result renderer`);
}
assert.match(
  displayOf("memory_list")({
    memories: [{ name: "user-prefers-tabs", type: "user", description: "Prefers tabs" }],
    count: 1,
  }),
  /^Available memories:\n {2}\[user\] user-prefers-tabs: Prefers tabs$/
);
assert.equal(displayOf("memory_list")({ memories: [], count: 0 }), "No memories stored.");
assert.match(
  displayOf("memory_read")({ content: '<memory name="user-prefers-tabs" type="user">\nAlways use tabs.\n</memory>' }),
  /Always use tabs/,
  "memory_read shows the body"
);
assert.equal(
  displayOf("memory_write")({ filename: "user-prefers-tabs.md", ok: true }),
  "Memory saved to user-prefers-tabs.md"
);

assert.ok(contextProvider, "registers a context provider");
const section = (name) => contextProvider.sections?.find((entry) => entry.name === name);
const indexSection = section("index");
const selectionSection = section("selection");
assert.ok(indexSection, "index is its own named section (ext:codent-memory:index)");
assert.ok(selectionSection, "selection is its own named section (ext:codent-memory:selection)");
assert.equal(contextProvider.content, undefined, "no unnamed base section");

const index = await indexSection.content();
assert.ok(index.includes("<memory_index>"), "turn-context index wraps <memory_index>");
assert.ok(index.includes("user-prefers-tabs"), "turn-context index lists the written memory");
// A lazy tool only pays off if the model can still find it — the index is the one
// surface that is always present, so it must advertise the discovery route.
assert.ok(index.includes("__lazy__tool__discovery__"), "turn-context index names the discovery tool for memory_list");

// Selection: one structured completion for the turn, injected as the selection section.
const selection = await selectionSection.content();
assert.ok(selection.includes("<relevant_memories>"), "selection carries the memory block");
assert.ok(selection.includes("user-prefers-tabs"), "selection includes the selected memory");
assert.equal(llmCalls.length, 1, "one selection completion per user turn");
assert.equal(llmCalls[0].maxOutputTokens, 256, "selection caps its output");
assert.ok(llmCalls[0].schema, "selection asks for the structured schema");

// The surfaced set commits on the first assistant message of the turn.
assert.ok(observers.has("message:start"), "observes message:start to commit the surfaced set");
observers.get("message:start")({
  type: "message:start",
  agentId: "agent-1",
  payload: { role: "assistant", firstOutput: true },
});
await selectionSection.content();
assert.equal(llmCalls.length, 1, "a committed memory is not selected again in the same session");

// A session switch clears the surfaced set (the new conversation has not seen them). This is the
// real lifecycle hook (`SessionLifecycleService.resetTransientState` → `memory.resetState()`).
memoryService.resetState();
const afterSwitch = await selectionSection.content();
assert.ok(afterSwitch.includes("user-prefers-tabs"), "a new session may surface the memory again");
assert.equal(llmCalls.length, 2, "the selection query runs again after a session switch");

// Only the turn's FIRST assistant message commits, and only for this agent.
observers.get("message:start")({
  type: "message:start",
  agentId: "agent-1",
  payload: { role: "assistant", firstOutput: false },
});
await selectionSection.content();
assert.equal(llmCalls.length, 3, "firstOutput:false does not commit the turn's selection");

observers.get("message:start")({
  type: "message:start",
  agentId: "another-agent",
  payload: { role: "assistant", firstOutput: true },
});
await selectionSection.content();
assert.equal(llmCalls.length, 4, "a child/foreign agent message does not commit this agent's selection");

// An aborted run drops the pending set: a later pump that skips prepare must not consume it.
observers.get("agent:abort")({ type: "agent:abort", agentId: "agent-1", payload: {} });
observers.get("message:start")({
  type: "message:start",
  agentId: "agent-1",
  payload: { role: "assistant", firstOutput: true },
});
await selectionSection.content();
assert.equal(llmCalls.length, 5, "an aborted turn does not consume the surfaced set");

// The real commit marks it, and the same memory is not selected again in this session.
observers.get("message:start")({
  type: "message:start",
  agentId: "agent-1",
  payload: { role: "assistant", firstOutput: true },
});
assert.equal(await selectionSection.content(), undefined, "a committed memory is not selected again");
assert.equal(llmCalls.length, 5, "the committed set suppresses the next completion");

// An already-aborted run issues no completion at all.
mockCtx.signal = { aborted: true };
assert.equal(await selectionSection.content(), undefined, "an aborted run injects no selection");
assert.equal(llmCalls.length, 5, "an aborted run issues no completion");
mockCtx.signal = undefined;

// Synthetic <ctx> blocks are user-role but are not the user's query.
let filteredQuery = "";
let filteredProvider = null;
const filterSelection = new MemoryService();
filterSelection.setManager(manager);
const filterApi = createMemoryExtension({ memoryManager: manager, selection: filterSelection });
await filterApi.activate(
  makeCtx({
    z: (await import("zod")).z,
    onProvider: (provider) => {
      filteredProvider = provider;
    },
    extra: {
      getMessages: () => [
        { role: "user", content: "How do I indent?" },
        { role: "user", content: '<ctx kind="current_date">\nOctober 27, 2026\n</ctx>' },
      ],
      llm: {
        complete: async (request) => {
          filteredQuery = request.prompt;
          return { data: { selected_memories: [] } };
        },
      },
    },
  }).ctx
);
await filteredProvider.sections.find((entry) => entry.name === "selection").content();
assert.ok(filteredQuery.includes("How do I indent?"), "selection skips synthetic <ctx> user messages");
assert.ok(!filteredQuery.includes("<ctx"), "the query is the real user text, not the injected block");

// memory_list executes and returns summaries.
const listTool = registeredTools.find((t) => t.name === "memory_list");
const listResult = await listTool.execute({}, { toolCallId: "t1" });
assert.equal(listResult.count, 1, "memory_list returns correct count");
assert.equal(listResult.memories[0].name, "user-prefers-tabs", "memory_list returns memory name");

// memory_read executes and returns wrapped content.
const readTool = registeredTools.find((t) => t.name === "memory_read");
const readResult = await readTool.execute({ name: "user-prefers-tabs" }, { toolCallId: "t2" });
assert.ok(readResult.content.includes("<memory"), "memory_read wraps content in <memory> tags");
assert.ok(readResult.content.includes("user-prefers-tabs"), "memory_read content includes memory name");
assert.ok(readResult.content.includes("tabs"), "memory_read content includes the body");

// memory_read by filename (without .md) also resolves.
const readByFile = await readTool.execute({ name: "user-prefers-tabs.md" }, { toolCallId: "t3" });
assert.equal(readByFile.name, "user-prefers-tabs", "memory_read resolves by filename");

// Unknown memory throws a helpful error.
await assert.rejects(() => readTool.execute({ name: "does-not-exist" }, { toolCallId: "t4" }), /Unknown memory/);

// memory_write creates a new memory.
const writeTool = registeredTools.find((t) => t.name === "memory_write");
const writeResult = await writeTool.execute(
  { name: "user-prefers-spaces", type: "user", description: "Prefers spaces", body: "Prefers spaces in most code." },
  { toolCallId: "t5" }
);
assert.equal(writeResult.ok, true, "memory_write returns ok");
const allAfterWrite = await manager.listMemories();
assert.equal(allAfterWrite.length, 2, "memory_write persists a new memory");

// ---------------------------------------------------------------------------
// 3. /memory command registration + injection semantics
// ---------------------------------------------------------------------------
const memoryCmd = registeredCommands.find((c) => c.name === "memory");
assert.ok(memoryCmd, "registers /memory command");
assert.equal(typeof memoryCmd.injectMessage, "function", "/memory command has injectMessage");
assert.equal(typeof memoryCmd.getOptions, "function", "/memory command has getOptions for the secondary menu");

// getOptions returns the stored memories as browseable menu options.
const memoryOptions = await memoryCmd.getOptions([]);
assert.ok(Array.isArray(memoryOptions), "getOptions returns an array");
assert.equal(memoryOptions.length, 2, "getOptions lists all stored memories");
assert.ok(
  memoryOptions.some((o) => o.label === "user-prefers-tabs"),
  "options include written memory"
);
assert.ok(
  memoryOptions.some((o) => o.description),
  "options carry descriptions"
);

// No args -> lists all memories in the UI message, no injection.
const listMsg = await memoryCmd.execute([]);
assert.ok(listMsg.includes("user-prefers-tabs"), "/memory with no args lists memories");
assert.equal(await memoryCmd.injectMessage([], listMsg), undefined, "/memory with no args injects nothing");

// With a known name -> UI confirmation + injects the full memory body.
const confirm = await memoryCmd.execute(["user-prefers-tabs"]);
assert.ok(confirm.includes("user-prefers-tabs"), "/memory <name> returns a confirmation");
const injected = await memoryCmd.injectMessage(["user-prefers-tabs"], confirm);
assert.ok(injected.includes("<memory"), "/memory injects <memory>-wrapped content");
assert.ok(injected.includes("user-prefers-tabs"), "/memory injects the memory name");
assert.ok(injected.includes("Always use tabs"), "/memory injects the full memory body");

// Follow-up text after /memory <name> is merged into the injected message.
const injectedWithFollowup = await memoryCmd.injectMessage(["user-prefers-tabs", "apply this rule"], confirm);
assert.ok(injectedWithFollowup.includes("Always use tabs"), "follow-up inject still includes the memory body");
assert.ok(injectedWithFollowup.includes("apply this rule"), "follow-up text is merged into the injected message");

// Unknown memory -> error message, no injection.
const unknownMsg = await memoryCmd.execute(["does-not-exist"]);
assert.ok(unknownMsg.includes("Unknown memory"), "/memory <unknown> returns an error message");
assert.equal(
  await memoryCmd.injectMessage(["does-not-exist"], unknownMsg),
  undefined,
  "unknown memory injects nothing"
);

// ---------------------------------------------------------------------------
// 4. Config semantics
// ---------------------------------------------------------------------------
const toolsOnlyApi = createMemoryExtension({
  memoryManager: manager,
  selection: memoryService,
  config: { indexDisabled: true },
});
let toolsOnlyProvider = null;
const toolsOnlyTools = [];
const toolsOnlyCommands = [];
await toolsOnlyApi.activate(
  makeCtx({
    z: (await import("zod")).z,
    tools: toolsOnlyTools,
    commands: toolsOnlyCommands,
    onProvider: (provider) => {
      toolsOnlyProvider = provider;
    },
  }).ctx
);
assert.ok(
  toolsOnlyTools.some((t) => t.name === "memory_list"),
  "indexDisabled still registers tools"
);
assert.ok(
  toolsOnlyCommands.some((c) => c.name === "memory"),
  "indexDisabled still registers /memory command"
);
assert.equal(
  toolsOnlyProvider.sections.some((entry) => entry.name === "index"),
  false,
  "indexDisabled removes the index section"
);
assert.ok(
  toolsOnlyProvider.sections.some((entry) => entry.name === "selection"),
  "indexDisabled keeps per-turn selection"
);

const indexOnlyApi = createMemoryExtension({
  memoryManager: manager,
  selection: memoryService,
  config: { toolsDisabled: true },
});
const indexOnlyTools = [];
const indexOnlyCommands = [];
await indexOnlyApi.activate(
  makeCtx({
    z: (await import("zod")).z,
    tools: indexOnlyTools,
    commands: indexOnlyCommands,
  }).ctx
);
assert.equal(indexOnlyTools.length, 0, "toolsDisabled removes all three tools");
assert.ok(
  indexOnlyCommands.some((c) => c.name === "memory"),
  "toolsDisabled still registers /memory command"
);

const noContextApi = createMemoryExtension({
  memoryManager: manager,
  selection: memoryService,
  config: { indexDisabled: true, selectionDisabled: true },
});
let noContextProvider = null;
await noContextApi.activate(
  makeCtx({
    z: (await import("zod")).z,
    onProvider: (provider) => {
      noContextProvider = provider;
    },
  }).ctx
);
assert.equal((noContextProvider.sections ?? []).length, 0, "both disabled leaves the provider with only its notice");

// ---------------------------------------------------------------------------
// 5. Selection service: telemetry sink + finalize discards the pending commit
// ---------------------------------------------------------------------------
{
  const events = [];
  const service = new MemoryService((type, data) => events.push([type, data]));
  service.setManager(manager);
  let calls = 0;
  const complete = async () => {
    calls += 1;
    return { data: { selected_memories: ["user-prefers-tabs"] } };
  };
  const input = { messages: [{ role: "user", content: "tabs" }], complete };

  await service.prefetchRelevantMemories(input);
  assert.equal(events.length, 1, "the service emits memory:prefetch through its own sink");
  assert.equal(events[0][0], "memory:prefetch");
  assert.equal(events[0][1].status, "selected");
  assert.ok(service.getRelevantContent().includes("user-prefers-tabs"));

  // The extension never carries an emitter; the agent's sink is injected at construction.
  // A turn that finalizes without producing a message drops the pending set, so a later pump
  // cannot commit a selection the model never saw.
  service.clearTurnContext();
  service.commitSurfacedMemories();
  await service.prefetchRelevantMemories(input);
  assert.equal(calls, 2, "clearTurnContext discards the pending commit (the memory is selected again)");
  assert.equal(events.length, 2, "the second turn emits its own selection event");
}

// Cleanup
await rm(root, TEMP_RM_OPTIONS);

console.log("memory-extension validation passed");
