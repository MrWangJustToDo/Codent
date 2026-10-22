/**
 * Validation for the command-safety layer (run_command).
 *
 * Covers the pure decision surfaces that don't require tree-sitter WASM:
 * - arity normalization (commandPrefix / normalizedCommand)
 * - approval policy matrix (evaluateCommandApproval: allow / deny / ask)
 * - subagent deny semantics (ask downgraded to deny, with a model-readable reason)
 *
 * Tree-sitter parsing itself is host-provided (CoreEnv.locateTreeSitterGrammar);
 * this script intentionally avoids it so it runs in any runtime.
 *
 * Run: pnpm --filter @codent/core run validate:safe-command
 */

import assert from "node:assert/strict";

import {
  SUBAGENT_DENY_MESSAGE,
  clearCoreEnv,
  commandPrefix,
  createRunCommandTool,
  CommandJobRegistry,
  defaultPath,
  evaluateCommandApproval,
  normalizedCommand,
  getEnv,
  registerCoreEnv,
} from "../dist/dev.mjs";

/** Workspace root the analyzer resolves paths against. */
const ROOT = "/home/user/project";

// ---------------------------------------------------------------------------
// Arity normalization (pure)
// ---------------------------------------------------------------------------

assert.deepEqual(commandPrefix(["git", "status"]), ["git", "status"]);
assert.deepEqual(commandPrefix(["git", "checkout", "main"]), ["git", "checkout"]);
assert.deepEqual(commandPrefix(["npm", "install", "lodash"]), ["npm", "install"]);
assert.deepEqual(commandPrefix(["npm", "exec", "vite"]), ["npm", "exec", "vite"]);
assert.deepEqual(commandPrefix(["cat", "README.md"]), ["cat"]);
assert.deepEqual(commandPrefix([]), []);

assert.equal(normalizedCommand(["git", "status"]), "git status");
assert.equal(normalizedCommand(["git", "log", "--oneline"]), "git log");
assert.equal(normalizedCommand(["ls", "-la"]), "ls");

// ---------------------------------------------------------------------------
// Approval policy — built-in default (pure decision on a report)
// ---------------------------------------------------------------------------

const baseReport = {
  ok: true,
  commands: [
    {
      tokens: ["git", "status"],
      source: "git status",
      prefix: ["git", "status"],
      normalized: "git status",
      isReadOnly: true,
      fileOps: [],
    },
  ],
  anyExternalDir: false,
  anyWriteOp: false,
};

// Project-internal read-only command → allow for both root and subagent.
assert.equal(evaluateCommandApproval(baseReport, { agentKind: "root" }).action, "allow");
assert.equal(evaluateCommandApproval(baseReport, { agentKind: "subagent" }).action, "allow");

// Write operation → ask (root) / deny (subagent).
const writeReport = {
  ...baseReport,
  commands: [{ ...baseReport.commands[0], normalized: "rm", isReadOnly: false }],
  anyWriteOp: true,
};
assert.equal(evaluateCommandApproval(writeReport, { agentKind: "root" }).action, "ask");
assert.equal(evaluateCommandApproval(writeReport, { agentKind: "subagent" }).action, "deny");
assert.match(evaluateCommandApproval(writeReport, { agentKind: "subagent" }).reason ?? "", /insufficient permissions/i);

// External directory → ask (root) / deny (subagent).
const externalReport = {
  ...baseReport,
  commands: [{ ...baseReport.commands[0], isReadOnly: true }],
  anyExternalDir: true,
};
assert.equal(evaluateCommandApproval(externalReport, { agentKind: "root" }).action, "ask");
assert.equal(evaluateCommandApproval(externalReport, { agentKind: "subagent" }).action, "deny");

// Parse failure (ok:false) → conservative: ask (root) / deny (subagent).
const parseFailReport = { ok: false, commands: [], anyExternalDir: true, anyWriteOp: true };
assert.equal(evaluateCommandApproval(parseFailReport, { agentKind: "root" }).action, "ask");
assert.equal(evaluateCommandApproval(parseFailReport, { agentKind: "subagent" }).action, "deny");

// Empty command list → not allowed by default.
const emptyReport = { ok: true, commands: [], anyExternalDir: false, anyWriteOp: false };
assert.equal(evaluateCommandApproval(emptyReport, { agentKind: "root" }).action, "ask");

// ---------------------------------------------------------------------------
// Approval policy — explicit rules
// ---------------------------------------------------------------------------

const denyRules = evaluateCommandApproval(baseReport, {
  agentKind: "root",
  rules: { deny: ["git status"] },
});
assert.equal(denyRules.action, "deny");

const allowRules = evaluateCommandApproval(baseReport, {
  agentKind: "root",
  rules: { allow: ["git status"] },
});
assert.equal(allowRules.action, "allow");

// Subagent deny message is exported for the model-facing tool error.
assert.ok(typeof SUBAGENT_DENY_MESSAGE === "string" && SUBAGENT_DENY_MESSAGE.length > 0);

// ---------------------------------------------------------------------------
// Analyzer — read-only classification of real command shapes
//
// These need a CoreEnv (the analyzer resolves cwd/root/homedir/env from it) and the bash
// grammar for anything that must parse. Both are supplied here, so the assertions cover the
// full `analyzeCommand` → `evaluateCommandApproval` path rather than a hand-built report.
//
// Two directions, and both matter: the left column is read-only inspection that every session
// runs constantly and must NOT prompt; the right column is a write wearing a read-only name,
// which must keep asking. A false allow here is a security bug, not an annoyance.
// ---------------------------------------------------------------------------

registerCoreEnv({
  rootPath: ROOT,
  getPlatform: async () => "linux",
  getArch: async () => "arm64",
  getEnv: async () => ({ HOME: "/home/user" }),
  homedir: async () => "/home/user",
  fs: {},
  runCommand: async () => ({}),
  exec: async () => ({}),
  fetch: async () => new Response(""),
});
const { createAnalysisContext, analyzeCommand } = await import("../dist/dev.mjs");
const cmdCtx = await createAnalysisContext(getEnv());

/** Decision for a command, via the real analyzer. */
async function decide(command) {
  const report = await analyzeCommand(command, cmdCtx);
  return { action: evaluateCommandApproval(report, { agentKind: "root" }).action, report };
}

// Read-only inspection → allow.
const READ_ONLY_COMMANDS = [
  // `cd` into the project, bare or as the head of a chained inspection command.
  "cd packages/core && grep -rn foo .",
  `cd ${ROOT} && ls`,
  // Benign output redirection: fd duplication and the null device write no file.
  "echo hi 2>&1",
  "ls -la 2>/dev/null",
  // Filter stages inside an inspection pipeline.
  'grep -rn foo . | sed -n "1,20p" | head',
  "sort file.txt | uniq -c | head",
  "cat file.ts | cut -d: -f1 | head",
  "test -f a.ts && echo yes",
  "cat file.ts | wc -l",
  // A grep *pattern* is not a path: `\\.foo\\b` used to resolve to `/.foo/b` (outside the root)
  // and forced an approval for an ordinary search.
  'grep -rn "\\.todoManager\\b" packages/core/src',
  'grep -rn --include="*.ts" "x" packages/core/src',
  // `find` PREDICATE values are patterns, not paths. `-name "*.d.mts"` used to be extracted as a
  // path operand, and a glob with no prefix to resolve is reported as an unresolvable external
  // path — so an ordinary read-only traversal demanded approval.
  'find . -name "*.d.mts" -print',
  'find . -path ./node_modules -prune -o -name "*.d.mts" -print',
  'find . -type f -name "*.ts"',
  // GNU's leading global options are not starting points either.
  'find -L . -name "*.ts"',
];
for (const command of READ_ONLY_COMMANDS) {
  const { action } = await decide(command);
  assert.equal(action, "allow", `expected read-only (no prompt) for: ${command}`);
}

// Writes that hide behind a read-only spelling → must still ask.
const MUTATING_COMMANDS = [
  "rm -rf node_modules",
  "sed -i s/a/b/ file.ts",
  "sort -o out.txt in.txt",
  'awk "BEGIN{system(\\"touch pwned\\")}"',
  "echo a > /tmp/x",
  "echo a >> out.txt",
  "echo hi 2> out.txt",
  "grep -rn x . | tee out.txt",
  `cd /etc && ls`,
  "cd ../.. && ls",
  "cat /etc/passwd",
  "git checkout -- file.ts",
  "pnpm build",
];
for (const command of MUTATING_COMMANDS) {
  const { action } = await decide(command);
  assert.notEqual(action, "allow", `expected approval for: ${command}`);
}

// `find`: only the starting points are paths, and the write predicates still decide "not read-only".
{
  const predicate = await decide('find . -name "*.d.mts" -print');
  assert.deepEqual(
    predicate.report.commands[0].fileOps.map((op) => op.arg),
    ["."],
    "only find's starting point is a path; -name's value is a pattern"
  );
  assert.equal(predicate.report.anyExternalDir, false, "an internal starting point is not external");

  // The external check must still see a starting point behind a leading global option…
  for (const command of ["find /etc -name passwd", "find -L /etc -name passwd"]) {
    const { action, report } = await decide(command);
    assert.notEqual(action, "allow", `external find traversal must ask: ${command}`);
    assert.equal(report.anyExternalDir, true, `the starting point is external: ${command}`);
  }
  // …and the write predicates keep classifying the invocation as a write at all.
  for (const command of ["find . -delete", "find . -exec rm {} \\;"]) {
    const { action, report } = await decide(command);
    assert.notEqual(action, "allow", `write predicate must ask: ${command}`);
    assert.equal(
      report.commands.some((c) => c.isReadOnly === false),
      true,
      `not read-only: ${command}`
    );
  }
}

// ---------------------------------------------------------------------------
// The tool's own gate: what a subagent's `run_command` refuses
// ---------------------------------------------------------------------------
//
// The policy above answers "may this command run"; the gate in `run-command-tool.ts` is what a
// subagent actually meets, and it has one rule the policy cannot express — a background job. A
// subagent's tool set has neither `get_command_output` nor `kill_command`, so a job it starts is one
// it can never poll or stop: the call returns a job id, the run ends, and the job keeps going. A
// read-only command passing the analyzer is therefore not enough to allow it, which is asserted here
// rather than left to the policy's tables.

{
  const makeEnv = () => ({
    rootPath: ROOT,
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    homedir: async () => "/home/user",
    getEnv: async () => ({}),
    // The real helper (pathe-backed): the analyzer resolves globs and checks absoluteness through it.
    path: defaultPath,
    fs: { readFile: async () => "", writeFile: async () => {}, readdir: async () => [], exists: async () => false },
    runCommand: async () => ({ stdout: "ok\n", stderr: "", exitCode: 0 }),
    startCommand: async () => ({ pid: 1, kill: async () => {} }),
    commandExists: async () => true,
  });

  /** Run a subagent-safe command, reporting either the result or the refusal. */
  const run = async (args) => {
    const env = makeEnv();
    clearCoreEnv();
    registerCoreEnv(env);
    try {
      const result = await createRunCommandTool({ subagentSafe: true }).execute(args, {
        toolCallId: "t",
        coreEnv: env,
      });
      return { result, error: null };
    } catch (error) {
      return { result: null, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const allowed = await run({ command: "ls -la" });
  assert.equal(allowed.error, null, `a read-only command runs: ${allowed.error}`);
  assert.equal(allowed.result.cachedOutputPath, null, "…and reports no spill for a small output");

  const write = await run({ command: "rm -rf src" });
  assert.match(write.error ?? "", /insufficient permissions/i, "a write command is refused with the subagent message");

  const external = await run({ command: "cat /etc/passwd" });
  assert.ok(external.error, "an external path is refused");

  // The rule this section exists for: the command itself is read-only, so the analyzer allows it —
  // only the background guard can refuse it.
  const background = await run({ command: "ls -la", run_in_background: true });
  assert.match(
    background.error ?? "",
    /[Bb]ackground commands are not available to subagents/,
    `a read-only BACKGROUND command must still be refused (got: ${background.result ? "allowed" : background.error})`
  );
  assert.match(background.error ?? "", /get_command_output|kill_command/, "…and the reason names what is missing");

  // The main agent keeps it: nothing here may take background execution away from the user's own run.
  const mainEnv = makeEnv();
  clearCoreEnv();
  registerCoreEnv(mainEnv);
  const mainAgent = await createRunCommandTool({
    context: { getCommandJobRegistry: () => new CommandJobRegistry() },
  }).execute({ command: "ls -la", run_in_background: true }, { toolCallId: "t", coreEnv: mainEnv });
  assert.equal(mainAgent.runInBackground, true, "the main agent can still start a background job");
  assert.equal(typeof mainAgent.jobId, "string", "…and gets a job id back");
}

console.log("validate:safe-command OK");
