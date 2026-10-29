/**
 * Validate that `run_command`'s model-supplied `env` map is part of the safety verdict.
 *
 * Why this exists: the host merges `env` over `process.env` (`packages/node/src/environment/native-run.ts`),
 * but the analyzer only ever saw the command *text*. So
 *
 *   { command: "ls", env: { PATH: "/tmp/evil" } }
 *
 * was classified read-only and auto-approved — the text said `ls`, the process that ran was the
 * caller's binary. The same shape walked straight through the read-only whitelist a subagent
 * runs under, where there is no approval UI at all.
 *
 * The rule is deliberately NOT a dangerous-key deny-list. That shape fails open on the first key
 * nobody listed, and the class is open-ended (`LD`, `CC`, `RUSTC_WRAPPER`, `JAVA_TOOL_OPTIONS`,
 * `LESSOPEN`, `OPENSSL_CONF`, `DOTNET_STARTUP_HOOKS`, …). These cases therefore pin the
 * fail-closed property itself:
 *
 *   1. ANY non-empty override requires approval — including keys that look harmless, and
 *      including keys the message would not even name.
 *   2. An empty map is not an override; the read-only fast path is intact.
 *   3. The message names the keys and calls out the classic execution selectors.
 *   4. Ordering: an explicit `allow` rule names a command, not its environment.
 *   5. The rule cannot be laundered by a less-known key (`RUSTC_WRAPPER`, `LESSOPEN`, …) — the
 *      assertion is behavioural, not a membership check on the hint table.
 *   6. End to end through the real analyzer: the same call auto-approves without `env`, and stays
 *      pending with an override (i.e. the coordinator really threads `env` through).
 *   7. The subagent tool refuses with the env-specific reason, and its documented escape hatch
 *      (an inline assignment prefix) still works.
 *
 * Run: pnpm --filter @codent/core run validate:command-env-safety
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApprovalDecisionCoordinator,
  analyzeCommand,
  createAnalysisContext,
  createRunCommandTool,
  defaultPath,
  envOverrideApprovalReason,
  envOverrideKeys,
  evaluateCommandApproval,
  executionSelectingEnvKeys,
  getEnv,
  registerCoreEnv,
  subagentEnvOverrideMessage,
} from "../dist/dev.mjs";

// ----------------------------------------------------------------------------
// Minimal CoreEnv: the real grammar path must run, or case 6 is a false green.
// ----------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const grammarDir = path.resolve(
  here,
  "../../../node_modules/.pnpm/tree-sitter-wasms@0.1.13/node_modules/tree-sitter-wasms/out"
);

registerCoreEnv({
  rootPath: "/repo",
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({ HOME: "/home/user" }),
  homedir: async () => "/home/user",
  path: defaultPath,
  fs: {
    readFile: async (p) => fs.promises.readFile(p, "utf8"),
    writeFile: async (p, content) => fs.promises.writeFile(p, content),
    mkdir: async (p) => fs.promises.mkdir(p, { recursive: true }),
    exists: async (p) =>
      fs.promises.access(p).then(
        () => true,
        () => false
      ),
    readdir: async (p) => {
      try {
        const entries = await fs.promises.readdir(p, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
      } catch {
        return [];
      }
    },
    stat: async (p) => {
      const st = await fs.promises.stat(p);
      return { isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size, mtime: st.mtime };
    },
  },
  runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => new Response(),
  locateTreeSitterGrammar: async (file) => {
    const p = path.join(grammarDir, file);
    return fs.existsSync(p) ? fs.promises.readFile(p) : null;
  },
});

const ctx = await createAnalysisContext(getEnv(), { path: defaultPath, shellKind: "bash" });

function isReadOnly(report) {
  return report.commands.length > 0 && !report.anyWriteOp && report.commands.every((c) => c.isReadOnly);
}

// ----------------------------------------------------------------------------
// 0. Canary: the grammar is present, so the report below is a real AST reading.
// ----------------------------------------------------------------------------

const canary = await analyzeCommand("git status", ctx);
assert.equal(isReadOnly(canary), true, "canary: the bash grammar must be present (otherwise case 6 is vacuous)");

const readOnlyReport = await analyzeCommand("ls -la", ctx);
assert.equal(isReadOnly(readOnlyReport), true, "the fixture command must start out read-only");

// ----------------------------------------------------------------------------
// 1. ANY non-empty override asks (root) / denies (subagent) — the fail-closed property
// ----------------------------------------------------------------------------

// A mix of obviously dangerous, less-known, and apparently harmless keys. The verdict must not
// depend on which bucket a key falls in: `envOverrideKeys` is the only input to the decision.
const overrideMaps = [
  { PATH: "/tmp/evil" },
  { LD_PRELOAD: "/tmp/x.so" },
  { NODE_OPTIONS: "--require /tmp/evil.js" },
  { RUSTC_WRAPPER: "/tmp/evil" }, // not in the hint table's original enumeration
  { LESSOPEN: "|/tmp/evil %s" }, // same
  { JAVA_TOOL_OPTIONS: "-javaagent:/tmp/evil.jar" },
  { OPENSSL_CONF: "/tmp/evil.cnf" },
  { CI: "1" }, // looks harmless, still an override
  { FOO: "bar" }, // unknown key: the deny-list shape would have allowed this
  { LC_ALL: "C" },
];

for (const env of overrideMaps) {
  const label = Object.keys(env).join(",");
  assert.equal(
    evaluateCommandApproval(readOnlyReport, { agentKind: "root", envOverrides: env }).action,
    "ask",
    `root: ${label} must require approval (any override is outside the command text)`
  );
  assert.equal(
    evaluateCommandApproval(readOnlyReport, { agentKind: "subagent", envOverrides: env }).action,
    "deny",
    `subagent: ${label} must be denied`
  );
}

// A key that is not in the hint table is still an override — the assertion above would pass on a
// deny-list only if someone happened to list it, so assert the *input* is what decides.
assert.deepEqual(envOverrideKeys({ TOTALLY_UNLISTED_KEY: "x" }), ["TOTALLY_UNLISTED_KEY"]);
assert.equal(
  executionSelectingEnvKeys(["TOTALLY_UNLISTED_KEY"]).length,
  0,
  "the hint table is message-only: an unlisted key is still an override (case 1), it just gets a generic sentence"
);

// ----------------------------------------------------------------------------
// 2. An empty map is not an override — the read-only fast path is intact
// ----------------------------------------------------------------------------

assert.deepEqual(envOverrideKeys(undefined), [], "no env map means no override");
assert.deepEqual(envOverrideKeys({}), [], "an empty env map means no override");
assert.equal(
  evaluateCommandApproval(readOnlyReport, { agentKind: "root" }).action,
  "allow",
  "without an env map the same command is still auto-approved"
);
assert.equal(
  evaluateCommandApproval(readOnlyReport, { agentKind: "root", envOverrides: {} }).action,
  "allow",
  "an empty map must not cost an approval"
);
assert.equal(
  evaluateCommandApproval(readOnlyReport, { agentKind: "subagent", envOverrides: {} }).action,
  "allow",
  "an empty map must not deny a subagent"
);

// ----------------------------------------------------------------------------
// 3. The message names the keys and calls out the classic execution selectors
// ----------------------------------------------------------------------------

const rootReason = envOverrideApprovalReason(["FOO", "PATH", "NODE_OPTIONS"]);
for (const key of ["FOO", "PATH", "NODE_OPTIONS"]) {
  assert.match(rootReason, new RegExp(key), `the reason must name ${key}`);
}
assert.match(rootReason, /different program/, "the classic execution selectors must be called out");
assert.doesNotMatch(
  envOverrideApprovalReason(["TOTALLY_UNLISTED_KEY"]),
  /different program/,
  "an unlisted key gets the generic sentence (no invented claim about it)"
);

const subagentReason = subagentEnvOverrideMessage(["PATH"]);
assert.match(subagentReason, /PATH/, "the denial must name the key");
assert.match(subagentReason, /inline/i, "the denial must offer the inline escape hatch");
assert.doesNotMatch(
  subagentReason,
  /not recognised as read-only/,
  "an env override is a classified risk — the unclassified message would be wrong"
);

// ----------------------------------------------------------------------------
// 4. Ordering: an allow rule names a command, not the environment it runs in
// ----------------------------------------------------------------------------

assert.equal(
  evaluateCommandApproval(readOnlyReport, { agentKind: "root", rules: { allow: ["ls"] } }).action,
  "allow",
  "the allow rule is effective on its own"
);
assert.equal(
  evaluateCommandApproval(readOnlyReport, {
    agentKind: "root",
    rules: { allow: ["ls"] },
    envOverrides: { PATH: "/tmp/evil" },
  }).action,
  "ask",
  "an explicit allow rule must not launder an env override past approval"
);
assert.equal(
  evaluateCommandApproval(readOnlyReport, {
    agentKind: "subagent",
    rules: { allow: ["ls"] },
    envOverrides: { PATH: "/tmp/evil" },
  }).action,
  "deny",
  "…nor past the subagent denial"
);

// A deny rule still outranks the env gate (deny is the safe direction).
assert.equal(
  evaluateCommandApproval(readOnlyReport, {
    agentKind: "root",
    rules: { deny: ["ls"] },
    envOverrides: { FOO: "1" },
  }).action,
  "deny",
  "an explicit deny rule still wins over the env gate"
);

// ----------------------------------------------------------------------------
// 5. End to end: the coordinator threads the call's `env` into the verdict
// ----------------------------------------------------------------------------

function makeCoordinator(env) {
  const responses = [];
  const approvals = [];
  const parts = [
    {
      type: "tool-call",
      id: "call_env",
      name: "run_command",
      arguments: JSON.stringify({ command: "ls -la", ...(env ? { env } : {}) }),
      state: "input-complete",
      approval: { id: "ap_env", needsApproval: true, approved: undefined },
    },
  ];
  const messages = [{ id: "m1", role: "assistant", parts }];
  const coordinator = new ApprovalDecisionCoordinator({
    getMessages: () => messages,
    addToolApprovalResponse: (approvalId, approved, reason) => {
      responses.push({ approvalId, approved, reason });
      return 1;
    },
    upsertApproval: (input) => approvals.push(input),
    shouldAutoApprove: () => false,
    reconcile: () => {},
    persist: () => {},
    enqueueRun: async () => {},
    isSessionSwitching: () => false,
    getCoreEnv: () => getEnv(),
  });
  return { coordinator, responses, approvals };
}

{
  const { coordinator, responses } = makeCoordinator();
  await coordinator.applyCommandSafetyPolicy();
  assert.equal(responses.length, 1, "without env, a read-only command is auto-approved");
  assert.equal(responses[0].approved, true, "and the answer is `approved`");
}

{
  // `CI` is the important one: a text-only or deny-list verdict would auto-approve it here.
  const { coordinator, responses } = makeCoordinator({ CI: "1" });
  await coordinator.applyCommandSafetyPolicy();
  assert.equal(
    responses.length,
    0,
    "any env override must stay pending for the user (a key-list verdict would approve this one)"
  );
}

// ----------------------------------------------------------------------------
// 6. The subagent tool refuses with the env-specific reason; inline still works
// ----------------------------------------------------------------------------

const tool = createRunCommandTool({ subagentSafe: true });
assert.ok(typeof tool.execute === "function", "the subagent tool must expose execute");

await assert.rejects(
  () =>
    tool.execute(
      { command: "ls -la", env: { PATH: "/tmp/evil" } },
      { toolCallId: "c1", abortSignal: new AbortController().signal, coreEnv: getEnv() }
    ),
  (error) => {
    assert.match(String(error.message), /PATH/, "the denial must name the offending key");
    assert.match(String(error.message), /subagent/i, "the denial must be addressed to a subagent");
    return true;
  },
  "a subagent must not run `ls` with PATH=/tmp/evil"
);

// The documented escape hatch: the same intent expressed inline goes through the ordinary
// analyzer and is allowed, so the denial above costs no capability.
const inline = await tool.execute(
  { command: "LC_ALL=C echo hi" },
  { toolCallId: "c2", abortSignal: new AbortController().signal, coreEnv: getEnv() }
);
assert.equal(inline.success, true, "an inline assignment prefix is still a read-only command");

console.log("\nvalidate-command-env-safety: all assertions passed");
