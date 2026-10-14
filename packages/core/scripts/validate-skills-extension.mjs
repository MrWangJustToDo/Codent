/**
 * Validation for the built-in Skills extension (`codent-skills`).
 *
 * Covers:
 * - SkillRegistry loads SKILL.md files from `.agents/skills` (progressive disclosure)
 * - createSkillsExtension is exported and produces an extension API
 * - activation registers list_skills / load_skill tools (ExtensionToolDefinition)
 * - activation registers a turn-context provider that emits the <skills> index
 * - activation registers a /skill command that injects the full skill body
 * - createSkillsExtension config can disable tools / index independently
 * - ManagedAgentConfig.skills accepts boolean | SkillsExtensionConfig (typecheck)
 *
 * Run: pnpm --filter @codent/core run validate:skills-extension
 */

import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerCoreEnv, SkillRegistry, createSkillsExtension } from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

// SkillLoader uses the global CoreEnv (getEnv()) for fs/path/homedir — register a
// node-backed environment rooted at the package dir so .agents/skills resolves.
registerCoreEnv({
  rootPath: root,
  getPlatform: async () => "linux",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => root,
  path,
  fs: {
    readFile: async (p) => readFile(p, "utf-8"),
    writeFile: async () => {},
    mkdir: async () => {},
    exists: async () => false,
    readdir: async (p) =>
      (await readdir(p, { withFileTypes: true })).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : "file",
      })),
    stat: async (p) => {
      const s = await stat(p);
      return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, mtime: s.mtime };
    },
    remove: async () => {},
  },
});

// ---------------------------------------------------------------------------
// 1. SkillRegistry loads real SKILL.md content
// ---------------------------------------------------------------------------
// A temp fixture, not `.agents/skills`: `.agents` is gitignored, so that directory
// is absent on a fresh clone and this assertion could only ever pass on a machine
// that happened to have it populated. (The sibling `validate:builtin-skills` had
// the identical bug and it broke CI the moment it was wired up.)
const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "skills-extension-fixture-"));
for (const name of ["fixture-one", "fixture-two"]) {
  const dir = path.join(fixtureRoot, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n\nBody for ${name}.\n`
  );
}

const registry = new SkillRegistry({ rootPath: fixtureRoot });
await registry.loadFromDirectories([fixtureRoot]);
assert.ok(registry.size >= 1, `SkillRegistry loaded at least 1 skill (got ${registry.size})`);
assert.deepEqual(
  registry.names().sort(),
  ["fixture-one", "fixture-two"],
  `expected the fixture skills, got ${registry.names().join(", ")}`
);

const summaries = registry.list();
for (const s of summaries) {
  assert.equal(typeof s.name, "string", `skill name is string: ${s.name}`);
  assert.equal(typeof s.description, "string", `skill description is string: ${s.name}`);
  assert.ok(["user", "project"].includes(s.source), `directory skill "${s.name}" carries a source`);
}

// Loading a skill body returns wrapped <skill> content.
const first = summaries[0];
const loaded = registry.get(first.name);
assert.ok(loaded, `registry.get(${first.name}) resolves`);
assert.ok(loaded.body.length > 0, "skill body is non-empty");

// ---------------------------------------------------------------------------
// 2. Extension factory shape
// ---------------------------------------------------------------------------
const api = createSkillsExtension({ skillRegistry: registry });
assert.equal(api.id, "codent-skills", "extension id is codent-skills");
assert.equal(typeof api.activate, "function", "extension has activate");

// ---------------------------------------------------------------------------
// 3. Activation registers tools + turn-context provider
// ---------------------------------------------------------------------------
const registeredTools = [];
const registeredCommands = [];
let contextProvider = null;

const mockCtx = {
  z: (await import("zod")).z,
  registerTool: (def) => registeredTools.push(def),
  registerCommand: (cmd) => registeredCommands.push(cmd),
  registerInterceptor: () => () => {},
  registerContextProvider: (provider) => {
    contextProvider = provider;
    return () => {};
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

await api.activate(mockCtx);

const toolNames = registeredTools.map((t) => t.name);
assert.ok(toolNames.includes("list_skills"), "registers list_skills");
assert.ok(toolNames.includes("load_skill"), "registers load_skill");

// list_skills is lazy (the <skills> index already carries its whole payload, so the
// eager schema was per-turn prompt cost for a tool never called in 195 root runs).
const listDef = registeredTools.find((t) => t.name === "list_skills");
assert.equal(listDef.lazy, true, "list_skills is registered lazy");
assert.ok(
  listDef.description.includes("__lazy__tool__discovery__"),
  "list_skills description names the discovery tool"
);
// load_skill stays eager: it is the second hop the model reaches for mid-task.
assert.notEqual(registeredTools.find((t) => t.name === "load_skill").lazy, true, "load_skill stays eager");

assert.ok(contextProvider, "registers a context provider");
const index = await contextProvider.content();
assert.ok(index.includes("<skills>"), "turn-context index wraps <skills>");
assert.ok(index.includes(first.name), `turn-context index lists ${first.name}`);
// A lazy tool only pays off if the model can still find it — the index is the one
// surface that is always present, so it must advertise the discovery route.
assert.ok(index.includes("__lazy__tool__discovery__"), "turn-context index names the discovery tool for list_skills");

// list_skills executes and returns summaries.
const listTool = registeredTools.find((t) => t.name === "list_skills");
const listResult = await listTool.execute({}, { toolCallId: "t1" });
assert.equal(listResult.count, registry.size, "list_skills returns correct count");

// load_skill executes and returns wrapped content.
const loadTool = registeredTools.find((t) => t.name === "load_skill");
const loadResult = await loadTool.execute({ name: first.name }, { toolCallId: "t2" });
assert.ok(loadResult.content.includes("<skill"), "load_skill wraps content in <skill> tags");
assert.ok(loadResult.content.includes(first.name), "load_skill content includes skill name");

// Unknown skill throws a helpful error.
await assert.rejects(() => loadTool.execute({ name: "does-not-exist" }, { toolCallId: "t3" }), /Unknown skill/);

// ---------------------------------------------------------------------------
// 3b. /skill command registration + injection semantics
// ---------------------------------------------------------------------------
const skillCmd = registeredCommands.find((c) => c.name === "skill");
assert.ok(skillCmd, "registers /skill command");
assert.equal(typeof skillCmd.injectMessage, "function", "/skill command has injectMessage");
assert.equal(typeof skillCmd.getOptions, "function", "/skill command has getOptions for the secondary menu");

// getOptions returns the available skills as browseable menu options.
const skillOptions = await skillCmd.getOptions([]);
assert.ok(Array.isArray(skillOptions), "getOptions returns an array");
assert.ok(skillOptions.length >= 1, "getOptions lists available skills");
assert.equal(skillOptions[0].label, summaries[0].name, "option label is the skill name");
assert.equal(skillOptions[0].value, summaries[0].name, "option value is the skill name");
assert.ok(
  skillOptions.some((o) => o.description),
  "options carry descriptions"
);

// No args -> lists available skills in the UI message, no injection.
const listMsg = await skillCmd.execute([]);
assert.ok(listMsg.includes(first.name), "/skill with no args lists available skills");
assert.equal(await skillCmd.injectMessage([], listMsg), undefined, "/skill with no args injects nothing");

// With a known name -> UI confirmation + injects the full skill body.
const confirm = await skillCmd.execute([first.name]);
assert.ok(confirm.includes(first.name), "/skill <name> returns a confirmation");
const injected = await skillCmd.injectMessage([first.name], confirm);
assert.ok(injected.includes("<skill"), "/skill injects <skill>-wrapped content");
assert.ok(injected.includes(first.name), "/skill injects the skill name");
assert.ok(injected.includes(loaded.body), "/skill injects the full skill body");

// Follow-up text after /skill <name> is merged into the injected message.
const injectedWithFollowup = await skillCmd.injectMessage([first.name, "refactor the loader"], confirm);
assert.ok(injectedWithFollowup.includes(loaded.body), "follow-up inject still includes the skill body");
assert.ok(injectedWithFollowup.includes("refactor the loader"), "follow-up text is merged into the injected message");

// Unknown skill -> error message, no injection.
const unknownMsg = await skillCmd.execute(["does-not-exist"]);
assert.ok(unknownMsg.includes("Unknown skill"), "/skill <unknown> returns an error message");
assert.equal(await skillCmd.injectMessage(["does-not-exist"], unknownMsg), undefined, "unknown skill injects nothing");

// ---------------------------------------------------------------------------
// 4. Config semantics
// ---------------------------------------------------------------------------
const toolsOnlyApi = createSkillsExtension({ skillRegistry: registry, config: { indexDisabled: true } });
let toolsOnlyProvider = null;
const toolsOnlyTools = [];
const toolsOnlyCommands = [];
await toolsOnlyApi.activate({
  z: (await import("zod")).z,
  registerTool: (def) => toolsOnlyTools.push(def),
  registerCommand: (cmd) => toolsOnlyCommands.push(cmd),
  registerInterceptor: () => () => {},
  registerContextProvider: (provider) => {
    toolsOnlyProvider = provider;
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});
assert.ok(
  toolsOnlyTools.some((t) => t.name === "list_skills"),
  "indexDisabled still registers tools"
);
assert.ok(
  toolsOnlyCommands.some((c) => c.name === "skill"),
  "indexDisabled still registers /skill command"
);
assert.equal(toolsOnlyProvider, null, "indexDisabled removes turn-context provider");

const indexOnlyApi = createSkillsExtension({ skillRegistry: registry, config: { toolsDisabled: true } });
const indexOnlyTools = [];
const indexOnlyCommands = [];
await indexOnlyApi.activate({
  z: (await import("zod")).z,
  registerTool: (def) => indexOnlyTools.push(def),
  registerCommand: (cmd) => indexOnlyCommands.push(cmd),
  registerInterceptor: () => () => {},
  registerContextProvider: () => () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});
assert.equal(indexOnlyTools.length, 0, "toolsDisabled removes both tools");
assert.ok(
  indexOnlyCommands.some((c) => c.name === "skill"),
  "toolsDisabled still registers /skill command"
);

await rm(fixtureRoot, TEMP_RM_OPTIONS);

console.log("skills-extension validation passed");
