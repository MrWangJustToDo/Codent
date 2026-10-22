/**
 * Validates profile-based base toolset assembly:
 * - root includes the root-only tools and an approval-gated run_command;
 * - subagent is the read-only set (no write/edit/task/todo/plan/session tools);
 * - the factory has ONE build site, and spawnSubagent only overrides custom tools.
 *
 * Run: pnpm --filter @codent/core run validate:toolset-factory
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildToolset,
  createSubagentTools,
  ManagedAgent,
  registerCoreEnv,
  resolveToolsRecord,
  TodoManager,
} from "../dist/dev.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
registerCoreEnv({
  rootPath: "/tmp/toolset-factory",
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => "/tmp",
  fs: {},
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => new Response(),
});
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, agent: () => {}, clear: () => {} };
const managed = new ManagedAgent(
  { name: "toolset-factory", model: "gpt-4" },
  { log, tools: {}, todoManager: new TodoManager() }
);

const root = await buildToolset({ profile: "root", managed });
const rootNames = new Set(Object.keys(root));
for (const name of [
  "read_file",
  "run_command",
  "todo",
  "webfetch",
  "websearch",
  "ask_user",
  "create_plan",
  "update_plan",
  "complete_plan",
]) {
  assert.ok(rootNames.has(name), `root toolset is missing ${name}`);
}
assert.ok(!rootNames.has("begin_summary"), "begin_summary is subagent-only");
assert.equal(root.run_command.needsApproval, true, "root run_command keeps approval");

const explore = await buildToolset({ profile: "explore", managed });
const exploreNames = new Set(Object.keys(explore));
for (const name of [
  "read_file",
  "glob",
  "grep",
  "list_file",
  "tree",
  "run_command",
  "webfetch",
  "websearch",
  "begin_summary",
]) {
  assert.ok(exploreNames.has(name), `explore toolset is missing ${name}`);
}
for (const name of [
  "write_file",
  "edit_file",
  "delete_file",
  "task",
  "todo",
  "ask_user",
  "create_plan",
  "session_search",
  "session_read",
]) {
  assert.ok(!exploreNames.has(name), `explore must not get ${name}`);
}
assert.equal(explore.run_command.needsApproval, false, "explore run_command is subagentSafe");
assert.deepEqual(
  resolveToolsRecord(explore)
    .map((tool) => tool.name)
    .sort(),
  resolveToolsRecord(createSubagentTools())
    .map((tool) => tool.name)
    .sort(),
  "the factory's explore profile is the canonical subagent set"
);

const general = await buildToolset({ profile: "general", managed });
const generalNames = new Set(Object.keys(general));
for (const name of ["read_file", "write_file", "edit_file", "run_command", "webfetch", "websearch"]) {
  assert.ok(generalNames.has(name), `general toolset is missing ${name}`);
}
for (const name of ["ask_user", "todo", "create_plan", "update_plan", "complete_plan", "task", "begin_summary"]) {
  assert.ok(!generalNames.has(name), `general must not get ${name}`);
}

const internal = await buildToolset({ profile: "internal", managed });
assert.equal(Object.keys(internal).length, 0, "internal starts with caller-supplied tools only");

await assert.rejects(
  () => buildToolset({ profile: "not-a-profile", managed }),
  /Unsupported toolset profile/,
  "an unknown profile must not fall through to the root toolset"
);

// The factory owns the only default build site; agent-manager only layers a custom override.
const factory = readFileSync(`${SRC}managers/agent-factory.ts`, "utf8");
assert.match(factory, /buildToolset\(\{\s*profile: toolsetProfile/, "factory selects the toolset once");
assert.ok(!/from "\.\.\/agent\/tools\/create-tools\.js"/.test(factory), "factory does not import createTools directly");
assert.ok(!/createSubagentTools/.test(factory), "factory does not import the subagent builder directly");

const manager = readFileSync(`${SRC}managers/agent-manager.ts`, "utf8");
assert.ok(!/createSubagentTools/.test(manager), "spawnSubagent no longer rebuilds the default subagent set");
assert.match(factory, /general agent profile is not enabled/, "the factory keeps general behind an explicit follow-up");
assert.match(factory, /Unknown agent profile/, "the factory rejects unknown profile ids");
assert.match(manager, /Subagents cannot spawn subagents/, "the manager enforces one child level");
assert.match(
  manager,
  /if \(customTools !== undefined\) \{\s*subagent\.tools = customTools/,
  "only custom tools override the factory result"
);
assert.match(
  manager,
  /hasOwnProperty\.call\(config, "subagentTools"\)/,
  "per-spawn overrides beat the root config default"
);
const runSubagent = readFileSync(`${SRC}agent/subagent/run-subagent.ts`, "utf8");
assert.match(
  runSubagent,
  /\.\.\.\(customTools !== undefined \? \{ subagentTools: customTools \}/,
  "runSubagent omits the override key when it has no per-spawn tools, so the root default can apply"
);

console.log("toolset-factory validation passed");
