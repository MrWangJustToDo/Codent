/**
 * Validates the instruction-context enhancement:
 *   1. Instruction file discovery (AGENTS.md / CLAUDE.md priority + override)
 *   2. Change detection via content digest (no change → stable; change → detected)
 *   3. formatInstructionContextSection renders latest content + supersede notice
 *   4. buildTurnContextSections includes the <instruction_context> section and
 *      keeps the other sections' existing semantic tags
 *
 * Run: pnpm --filter @codent/core run validate:instruction-context
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTurnContextSections,
  createManualCompactHost,
  diffInstructionStates,
  formatInstructionContextSection,
  instructionStateChanged,
  loadLatestInstructionContent,
  readInstructionContextState,
  registerCoreEnv,
} from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

// ---------------------------------------------------------------------------
// In-memory + disk-backed CoreEnv with a temp workspace
// ---------------------------------------------------------------------------

const ws = mkdtempSync(join(tmpdir(), "instr-ctx-"));
const files = new Map(); // path -> content (for exists/readFile)

function abs(p) {
  return join(ws, p);
}

registerCoreEnv({
  rootPath: ws,
  getPlatform: async () => "test",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => "/home/test",
  path: {
    join: (...parts) => join(...parts),
    dirname: (p) => join(p, ".."),
    basename: (p, ext) => {
      const base = p.split("/").pop() ?? p;
      return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
    },
    extname: (p) => {
      const base = p.split("/").pop() ?? p;
      const dot = base.lastIndexOf(".");
      return dot >= 0 ? base.slice(dot) : "";
    },
    resolve: (...parts) => join(...parts),
    normalize: (p) => p,
    isAbsolute: (p) => p.startsWith("/"),
    getSep: () => "/",
    parse: (p) => {
      const base = p.split("/").pop() ?? p;
      const dot = base.lastIndexOf(".");
      return {
        root: "/",
        dir: p.slice(0, p.lastIndexOf("/")),
        base,
        ext: dot >= 0 ? base.slice(dot) : "",
        name: dot >= 0 ? base.slice(0, dot) : base,
      };
    },
  },
  byteLength: (s) => encodeURI(s).replace(/%[A-F0-9]{2}/g, "x").length,
  fs: {
    readFile: async (p) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT ${p}`);
      return c;
    },
    stat: async (p) => ({ isDirectory: false, isFile: true, size: files.get(p)?.length ?? 0, mtime: new Date() }),
    readdir: async () => [],
    writeFile: async (p, c) => files.set(p, String(c)),
    mkdir: async () => {},
    exists: async (p) => files.has(p),
    remove: async (p) => files.delete(p),
  },
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => ({ ok: true, status: 200 }),
});

function setFile(name, content) {
  files.set(abs(name), content);
}

// ---------------------------------------------------------------------------
// 1. Discovery: no files → empty state
// ---------------------------------------------------------------------------
{
  const state = await readInstructionContextState();
  assert.equal(state.primary, undefined, "no instruction files → primary undefined");
  assert.equal(state.override, undefined, "no instruction files → override undefined");
}

// ---------------------------------------------------------------------------
// 2. Discovery: CLAUDE.md priority over AGENTS.md + override
// ---------------------------------------------------------------------------
setFile("AGENTS.md", "# AGENTS instructions\n- rule A\n");
setFile("AGENTS.override.md", "# personal override\n");
{
  const state = await readInstructionContextState();
  assert.ok(state.primary, "AGENTS.md discovered");
  assert.equal(state.primary.name, "AGENTS.md");
  assert.ok(state.override, "AGENTS.override.md discovered");
  assert.equal(state.override.name, "AGENTS.override.md");

  // CLAUDE.md wins when both exist
  setFile("CLAUDE.md", "# CLAUDE instructions\n");
  const state2 = await readInstructionContextState();
  assert.equal(state2.primary.name, "CLAUDE.md", "CLAUDE.md takes priority");
}

// ---------------------------------------------------------------------------
// 3. Change detection: digest stable when unchanged, changes on edit
// ---------------------------------------------------------------------------
{
  const before = await readInstructionContextState();
  const afterSame = await readInstructionContextState();
  assert.equal(instructionStateChanged(before, afterSame), false, "no change → not changed");
  assert.equal(diffInstructionStates(before, afterSame).primaryChanged, false, "no change → primary digest stable");

  // Edit the instruction file
  files.set(abs("CLAUDE.md"), "# CLAUDE instructions\n- rule A\n- rule B changed\n");
  const afterEdit = await readInstructionContextState();
  assert.equal(instructionStateChanged(before, afterEdit), true, "edited content → changed");
  assert.equal(diffInstructionStates(before, afterEdit).primaryChanged, true, "primary digest differs after edit");
}

// ---------------------------------------------------------------------------
// 4. loadLatestInstructionContent + formatInstructionContextSection
// --------------------------------------------------------------------------
setFile("CLAUDE.override.md", "# personal override\n");
{
  const loaded = await loadLatestInstructionContent();
  assert.equal(loaded.primary.name, "CLAUDE.md", "primary loaded");
  assert.ok(loaded.primary.content.includes("rule B changed"), "latest content re-read");

  const section = formatInstructionContextSection(loaded);
  assert.ok(section.startsWith("<instruction_context>"), "section opens with <instruction_context>");
  assert.ok(section.endsWith("</instruction_context>"), "section closes with </instruction_context>");
  assert.ok(section.includes("# CLAUDE.md"), "primary heading present");
  assert.ok(section.includes("rule B changed"), "latest instruction content present");
  assert.ok(section.includes("authoritative"), "supersede notice present");
  assert.ok(section.includes("CLAUDE.override.md"), "override listed");
  assert.ok(section.includes("personal override"), "override content present");
}

// ---------------------------------------------------------------------------
// 5. buildTurnContextSections includes <instruction_context> + keeps tags
// ---------------------------------------------------------------------------
{
  const loaded = await loadLatestInstructionContent();
  const instructionContext = formatInstructionContextSection(loaded);

  const payload = buildTurnContextSections({
    relevantMemoryContent: "<relevant_memories>memory A</relevant_memories>",
    todoNagReminder: "<reminder>Update todos</reminder>",
    currentDate: "August 17, 2026",
    gitBranch: "main",
    gitStatus: "M file.ts",
    modeContent: '<plan_mode phase="planning">…</plan_mode>',
    extensionTurnContextSections: [{ id: "codent-lsp", content: "ext activity" }],
    instructionContext,
  })
    .map((section) => section.content)
    .join("\n\n");

  assert.ok(payload.includes("<instruction_context>"), "instruction_context section present");
  assert.ok(payload.includes("rule B changed"), "latest instruction text in payload");
  assert.ok(payload.includes("<current_date>"), "current_date tag kept");
  assert.ok(payload.includes("<git_status>"), "git_status tag kept");
  assert.ok(payload.includes("<relevant_memories>"), "memory tag kept");
  assert.ok(payload.includes("<reminder>"), "todo nag tag kept");
  assert.ok(payload.includes("<plan_mode"), "plan mode tag kept");
  assert.ok(payload.includes("ext activity"), "extension turn-context section body present");
}

// ---------------------------------------------------------------------------
// 7. Payload hash stability across unchanged turns (cache-friendly)
// ---------------------------------------------------------------------------
{
  const loadedA = await loadLatestInstructionContent();
  const a = buildTurnContextSections({
    currentDate: "August 17, 2026",
    gitBranch: "main",
    relevantMemoryContent: "<relevant_memories>m</relevant_memories>",
    instructionContext: formatInstructionContextSection(loadedA),
  })
    .map((section) => section.content)
    .join("\n\n");
  const loadedB = await loadLatestInstructionContent();
  const b = buildTurnContextSections({
    currentDate: "August 17, 2026",
    gitBranch: "main",
    relevantMemoryContent: "<relevant_memories>m</relevant_memories>",
    instructionContext: formatInstructionContextSection(loadedB),
  })
    .map((section) => section.content)
    .join("\n\n");
  assert.equal(a, b, "unchanged instructions → identical payload (cache stable)");
}

// ---------------------------------------------------------------------------
// 8. ManagedAgent integration: baseline → change → sticky active
// ---------------------------------------------------------------------------
{
  const { ManagedAgent } = await import("../dist/dev.mjs");

  // Reset workspace to a clean AGENTS.md baseline for the managed flow.
  files.clear();
  setFile("AGENTS.md", "# AGENTS\n- rule baseline\n");

  const managed = new ManagedAgent(
    { name: "instr-test", model: "gpt-4" },
    {
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        agent: () => {},
        todo: () => {},
        clear: () => {},
      },
      tools: {},
      todoManager: null,
    }
  );

  // Turn 1: baseline — no instruction section (frozen prompt already carries content).
  const turn1 = (await managed.getDynamicTurnContextSections()).map((section) => section.content).join("\n\n");
  assert.ok(!turn1.includes("<instruction_context>"), "baseline turn has no instruction_context");

  // Edit the instruction file, then evaluate again — change detected + injected.
  setFile("AGENTS.md", "# AGENTS\n- rule baseline\n- rule NEW\n");
  const turn2 = (await managed.getDynamicTurnContextSections()).map((section) => section.content).join("\n\n");
  assert.ok(turn2.includes("<instruction_context>"), "changed turn injects instruction_context");
  assert.ok(turn2.includes("rule NEW"), "latest content injected");

  // No further change — still sticky (stable re-injection).
  const turn3 = (await managed.getDynamicTurnContextSections()).map((section) => section.content).join("\n\n");
  assert.ok(turn3.includes("<instruction_context>"), "sticky active keeps injecting");

  // clearTurnContext clears the per-turn snapshot but NOT the instruction state —
  // sticky remains active (it must survive across user turns, since clearTurnContext
  // runs at every turn finalize).
  managed.clearTurnContext();
  const turn4 = (await managed.getDynamicTurnContextSections()).map((section) => section.content).join("\n\n");
  assert.ok(turn4.includes("<instruction_context>"), "clearTurnContext keeps sticky active");
  assert.ok(turn4.includes("rule NEW"), "still injecting latest content after clear");

  // Compaction preserves the instruction digest so an edit made before the cut is not mistaken
  // for a fresh baseline.
  managed.resetAdmittedTurnContext(true);
  const turnPreserved = (await managed.getDynamicTurnContextSections()).map((section) => section.content).join("\n\n");
  assert.ok(turnPreserved.includes("<instruction_context>"), "compaction preserves changed instruction context");

  // A full reset still re-baselines → next turn has no section.
  managed.resetAdmittedTurnContext();
  const turn5 = (await managed.getDynamicTurnContextSections()).map((section) => section.content).join("\n\n");
  assert.ok(!turn5.includes("<instruction_context>"), "resetAdmittedTurnContext re-baselines");

  // The full `/clear` reset owns the same turn-context transaction: it must clear the instruction
  // snapshot too, not just the prompt/admission fields (the old inline reset missed these).
  setFile("AGENTS.md", "# AGENTS\n- rule baseline\n- rule RESET\n");
  const turnBeforeReset = (await managed.getDynamicTurnContextSections())
    .map((section) => section.content)
    .join("\n\n");
  assert.ok(turnBeforeReset.includes("rule RESET"), "a fresh change is active before reset");
  managed.reset();
  const turnAfterReset = (await managed.getDynamicTurnContextSections()).map((section) => section.content).join("\n\n");
  assert.ok(!turnAfterReset.includes("<instruction_context>"), "ManagedAgent.reset re-baselines instruction state");
}

// ---------------------------------------------------------------------------
// 8b. The manual-compact host adapter forwards `preserveInstructionContext`.
//
// This is the regression that the direct `resetAdmittedTurnContext(true)` test
// above cannot catch: a zero-argument adapter is structurally assignable to the
// optional-parameter host type, so the manual `/compact` path silently
// re-baselined the instruction digest while auto/reactive compaction preserved it.
// ---------------------------------------------------------------------------
{
  const seen = [];
  const fakeManaged = {
    id: "manual-compact-adapter",
    getStatus: () => "idle",
    setStatus: () => {},
    getUI: () => undefined,
    usage: {},
    getTodoManager: () => null,
    statusController: {},
    compaction: { getConfig: () => null },
    getContextWindow: () => undefined,
    getCoreEnv: () => ({ rootPath: ws }),
    resetAdmittedTurnContext: (preserveInstructionContext) => seen.push(preserveInstructionContext),
    resetSystemPrompt: () => {},
    persistSession: () => {},
    maybeSaveSessionUIMessages: () => {},
    log: null,
    getAbortSignal: () => undefined,
  };

  const host = createManualCompactHost(fakeManaged);
  host.resetAdmittedTurnContext(true);
  assert.deepEqual(seen, [true], "manual compact must ask the agent to preserve the instruction digest");
}

// ---------------------------------------------------------------------------
// 9. End-to-end injection via turn-context middleware: ctx message injected
//     with instruction section after a change; stable when nothing changes
// ---------------------------------------------------------------------------
{
  const { AgentUIChannel, ManagedAgent, createTurnContextMiddleware, extractContextSection } =
    await import("../dist/dev.mjs");

  files.clear();
  setFile("AGENTS.md", "# AGENTS\n- rule baseline\n");

  const managed = new ManagedAgent(
    { name: "instr-admit-test", model: "gpt-4" },
    {
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        agent: () => {},
        todo: () => {},
        clear: () => {},
      },
      tools: {},
      todoManager: null,
    }
  );
  const channel = new AgentUIChannel();
  managed.setUIChannel(channel);

  const middleware = createTurnContextMiddleware({
    getFrozenSystemPrompt: () => managed.getFrozenSystemPrompt(),
    getSections: () => managed.getDynamicTurnContextSections(),
    getUIChannel: () => channel,
    persistMessages: () => {},
    getManagedAgent: () => managed,
    getAdmittedHashes: () => managed.getAdmittedContextHashes(),
    setAdmittedHashes: (hashes) => managed.setAdmittedContextHashes(hashes),
    getAdmitMessageCount: () => managed.getTurnContextAdmitMessageCount(),
    setAdmitMessageCount: (count) => managed.setTurnContextAdmitMessageCount(count),
  });
  const runOnConfig = async () => {
    const wire = [];
    const result = await middleware.onConfig({}, { messages: wire });
    return result.messages ?? wire;
  };

  // A real user message must exist before injection (keeps synthetic ctx after
  // the user epoch instead of at position 0).
  channel.setMessages([{ id: "u1", role: "user", parts: [{ type: "text", content: "hello" }] }]);

  // Baseline turn — inject (no instruction section yet).
  const baselineWire = await runOnConfig();
  assert.ok(baselineWire.length >= 1, "baseline injected at least current_date");
  const baselineContent = baselineWire[baselineWire.length - 1];
  assert.ok(baselineContent.content.startsWith("<ctx kind="), "wire message is synthetic ctx");
  assert.ok(!baselineContent.content.includes("<instruction_context>"), "baseline has no instruction section");
  assert.equal(channel.getMessages().length, baselineWire.length + 1, "channel: user + injected ctx messages");

  // Same content, next call — no new inject (hash stable, cache friendly).
  const wireCount = baselineWire.length;
  const againWire = await runOnConfig();
  assert.equal(againWire.length, 0, "no change → no re-inject");
  assert.equal(channel.getMessages().length, wireCount + 1, "channel unchanged (cache stable)");

  // Edit AGENTS.md → next call detects change → inject with section. A new user
  // message arrives first (real next-turn traffic): injection inserts the fresh
  // ctx right after the latest real user message, so it becomes last.
  setFile("AGENTS.md", "# AGENTS\n- rule baseline\n- rule NEW-ADMIT\n");
  channel.setMessages([
    ...channel.getMessages(),
    { id: "u2", role: "user", parts: [{ type: "text", content: "next" }] },
  ]);
  const changedWire = await runOnConfig();
  assert.equal(changedWire.length, 1, "change → one ctx message injected (instruction_context)");
  const lastContent = changedWire[changedWire.length - 1].content;
  assert.equal(
    lastContent.startsWith("<ctx kind=instruction_context>"),
    true,
    "newest message is instruction_context ctx"
  );
  assert.ok(lastContent.includes("<instruction_context>"), "instruction section present");
  assert.ok(lastContent.includes("rule NEW-ADMIT"), "latest instruction text injected");
  assert.ok(lastContent.includes("authoritative"), "supersede notice present");
  const channelMessages = channel.getMessages();
  assert.ok(
    channelMessages[channelMessages.length - 1].parts[0].content.startsWith("<ctx kind=instruction_context>"),
    "channel last message matches wire injection"
  );

  // Parsing: extractContextSection recovers the newest block.
  const newest = extractContextSection(lastContent);
  assert.ok(newest.content.includes("<instruction_context>"), "nested section survives extraction");
  assert.equal(newest.key, "instruction_context");
}

rmSync(ws, TEMP_RM_OPTIONS);
console.log("validate:instruction-context PASSED");
