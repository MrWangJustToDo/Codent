/**
 * Validate command-safety classification, with the fallback's fail-safe invariant as the
 * centrepiece.
 *
 * Two things are asserted here, and the second is the reason this script exists at all:
 *
 * 1. POSIX behaviour is unchanged (task 4.9) — adding Windows entries to the arity/file tables
 *    must not alter how an existing POSIX command normalizes or classifies.
 * 2. The table-driven fallback (used when the host shell has no grammar — PowerShell, cmd.exe)
 *    can only ever make the decision *narrower*, never more permissive (task 4.4).
 *
 * Point 2 matters because the fallback grants read-only status from lookup tables rather than
 * from an AST. That is exactly the kind of path that fails in the permissive direction, so it
 * is asserted directly rather than reviewed: an unrecognised command, a write command, a write
 * redirection, a background command, and a path escaping the project root must all fail to be
 * allowed, in every shell kind.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeCommand,
  classifyShell,
  defaultPath,
  evaluateCommandApproval,
  isShellParsable,
  getEnv,
  registerCoreEnv,
  tokenizeCommandString,
} from "../dist/dev.mjs";

// ----------------------------------------------------------------------------
// Minimal CoreEnv so the AST path can actually run.
//
// This matters more than it looks: without a registered env, `parseCommandTree` returns null
// for every input, so the "POSIX unchanged" assertions below would silently exercise the
// *fallback* path and pass for the wrong reason. The grammar is located from the real
// `tree-sitter-wasms` install so the bash parse is genuine.
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
  // Only the bash grammar is needed here; a missing one degrades to `null`, which the
  // assertions below would catch as an empty command list.
  locateTreeSitterGrammar: async (file) => {
    const p = path.join(grammarDir, file);
    return fs.existsSync(p) ? fs.promises.readFile(p) : null;
  },
});

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    console.log(`      expected ${JSON.stringify(expected)}`);
    console.log(`      actual   ${JSON.stringify(actual)}`);
  }
}

const ctx = {
  coreEnv: getEnv(),
  rootPath: "/repo",
  cwd: "/repo",
  home: "/home/user",
  env: { HOME: "/home/user" },
  path: undefined, // filled below from the exported defaultPath
};

// --- shell classification ---------------------------------------------------
check("classify /bin/bash", classifyShell("/bin/bash"), "bash");
check("classify Git Bash on Windows", classifyShell("C:\\Program Files\\Git\\bin\\bash.exe"), "bash");
check("classify pwsh.exe", classifyShell("C:\\pwsh.exe"), "powershell");
check("classify cmd.exe", classifyShell("C:\\Windows\\System32\\cmd.exe"), "cmd");
check("classify absent shell", classifyShell(undefined), "unknown");
check("bash is parsable", isShellParsable("bash"), true);
check("powershell is not parsable", isShellParsable("powershell"), false);
check("cmd is not parsable", isShellParsable("cmd"), false);

// --- tokenizer --------------------------------------------------------------
const t = (s) => tokenizeCommandString(s);
check("split on chain", t("ls && cat a.txt"), [["ls"], ["cat", "a.txt"]]);
check("split on pipe", t("cat a.txt | grep x"), [
  ["cat", "a.txt"],
  ["grep", "x"],
]);
check("separator inside quotes is literal", t('echo "a && b"'), [["echo", "a && b"]]);
check("quotes stripped", t("cat 'a b.txt'"), [["cat", "a b.txt"]]);
check("redirection removed, command name intact", t("echo hello > out.txt"), [["echo", "hello"]]);
check("fd redirection removed", t("echo x 2>&1"), [["echo", "x"]]);

// --- POSIX regression (task 4.9) -------------------------------------------
const posix = async (cmd) => analyzeCommand(cmd, { ...ctx, path: defaultPath, shellKind: "bash" });

let r = await posix("git status");
check(
  "posix: git status is read-only",
  r.commands.map((c) => c.isReadOnly),
  [true]
);
check(
  "posix: git status normalizes to 'git status'",
  r.commands.map((c) => c.normalized),
  ["git status"]
);
check("posix: git status allowed for root", evaluateCommandApproval(r, { agentKind: "root" }).action, "allow");

r = await posix("rm -rf src");
check(
  "posix: rm is not read-only",
  r.commands.map((c) => c.isReadOnly),
  [false]
);
check("posix: rm asks for root", evaluateCommandApproval(r, { agentKind: "root" }).action, "ask");

r = await posix("echo hi > out.txt");
check(
  "posix: write redirection is not read-only",
  r.commands.map((c) => c.isReadOnly),
  [false]
);

// An unrecognised command must never be allowed, in any shell.
r = await posix("frobnicate --secret");
check(
  "posix: unknown command is not read-only",
  r.commands.map((c) => c.isReadOnly),
  [false]
);

// --- FALLBACK FAIL-SAFE INVARIANT (task 4.4) -------------------------------
// Same checks under a shell with no grammar — the fallback path.
const fallback = async (cmd) => analyzeCommand(cmd, { ...ctx, path: defaultPath, shellKind: "powershell" });

// The assertion needs a *path argument*, not just a bare command: `dir` alone has no pathArgs,
// so `fileOps` is empty and an "is this path external?" check would pass vacuously. A path
// argument that resolves inside the root is what makes the read-only claim mean something.
r = await fallback("dir src");
check(
  "fallback: dir <path> is read-only and not external",
  [r.commands.map((c) => c.isReadOnly), r.anyExternalDir, r.commands[0].fileOps.length],
  [[true], false, 1]
);
check("fallback: report flags the missing grammar", r.grammarUnavailable, true);
check("fallback: dir allowed for a SUBAGENT", evaluateCommandApproval(r, { agentKind: "subagent" }).action, "allow");

// A Windows path must be judged by win32 rules even when the host is POSIX. This is the case
// the whole change exists for, and it is testable here because `containsPath` picks the path
// flavour from the strings rather than from the host.
r = await analyzeCommand("dir C:\\repo\\src", {
  ...ctx,
  path: defaultPath,
  shellKind: "powershell",
  rootPath: "C:\\repo",
  cwd: "C:\\repo",
});
check("fallback: Windows path inside the root is not external", r.anyExternalDir, false);

r = await analyzeCommand("dir C:\\Users\\me\\proj", {
  ...ctx,
  path: defaultPath,
  shellKind: "powershell",
  rootPath: "C:\\repo",
  cwd: "C:\\repo",
});
check("fallback: Windows path outside the root IS external", r.anyExternalDir, true);

r = await fallback("type notes.md");
check(
  "fallback: type is read-only",
  r.commands.map((c) => c.isReadOnly),
  [true]
);

r = await fallback("where git");
check(
  "fallback: where normalizes to 'where'",
  r.commands.map((c) => c.normalized),
  ["where"]
);

// ---------------------------------------------------------------------------
// cmd.exe and PowerShell resolve commands case-insensitively, and report the real file name.
// `where.exe`, `DIR` and `TYPE` are what the shells actually see, so matching only the lowercase
// extension-free spelling left them unrecognised — denied on the very platform this table exists
// for. Canonicalising the name closes both at once.
// ---------------------------------------------------------------------------

for (const [label, cmd, expected] of [
  ["where.exe normalizes like where", "where.exe node", "where"],
  ["WHERE.EXE normalizes like where", "WHERE.EXE node", "where"],
  ["DIR normalizes like dir", "DIR", "dir"],
  ["Dir normalizes like dir", "Dir", "dir"],
  ["TYPE normalizes like type", "TYPE notes.md", "type"],
]) {
  const report = await fallback(cmd);
  check(
    `fallback: ${label}`,
    report.commands.map((c) => c.normalized),
    [expected]
  );
  check(
    `fallback: ${label} is read-only`,
    report.commands.map((c) => c.isReadOnly),
    [true]
  );
}

// A `.cmd`/`.bat` shim is a different program from its bare name (`npm` is a `.cmd` wrapper), so
// it must NOT be folded into the bare name's read-only status by the canonicalisation. `npm` has
// no arity entry, so its prefix is the name alone.
r = await fallback("npm.cmd --version");
check(
  "fallback: a .cmd shim is not silently equated with the bare name",
  [r.commands.map((c) => c.normalized), r.commands.map((c) => c.isReadOnly)],
  [["npm.cmd"], [false]]
);

// --- the invariant: none of these may be allowed ---
const mustNotAllow = [
  ["unrecognised command", "frobnicate --secret"],
  ["write command (del)", "del important.txt"],
  ["write command (copy)", "copy a.txt b.txt"],
  ["write redirection", "echo hi > out.txt"],
  ["append redirection", "echo hi >> out.txt"],
  ["background command", "ping localhost &"],
  ["path escaping the root", "dir /etc/passwd"],
  ["chained read-only + write", "dir && del important.txt"],
  ["chained read-only + unknown", "dir && frobnicate"],

  // --- command substitution: the fail-open this invariant exists to catch ---------------
  // The tokenizer could not split `$(...)` / backticks, so only the outer `echo` was seen,
  // `echo` is read-only, and the whole string was granted read-only status. The substitution
  // body — a real command that really runs — was never classified. Both the quoted and the
  // bare spellings have to be covered: fixing only the quoted one leaves `echo $(rm -rf x)`
  // open, which is the form a model actually writes.
  ["quoted substitution", 'echo "$(rm -rf /tmp/x)"'],
  ["bare substitution", "echo $(rm -rf /tmp/x)"],
  ["backtick substitution", "echo `rm -rf /tmp/x`"],
  ["read-only wrapper + substitution", 'git status "$(rm -rf /tmp/x)"'],
  ["read-only substitution", 'echo "$(cat /etc/passwd)"'],
  ["nested substitution", 'echo "$(cat $(rm -rf /tmp/x))"'],
  ["substitution in an assignment", "x=$(rm -rf /tmp/x)"],
];

for (const [label, cmd] of mustNotAllow) {
  const report = await fallback(cmd);
  const decision = evaluateCommandApproval(report, { agentKind: "subagent" });
  check(`invariant: ${label} is NOT allowed for a subagent`, decision.action === "allow", false);
}

// The invariant must also hold for the root agent (ask, never allow).
for (const [label, cmd] of mustNotAllow) {
  const report = await fallback(cmd);
  const decision = evaluateCommandApproval(report, { agentKind: "root" });
  check(`invariant: ${label} is NOT allowed for root`, decision.action === "allow", false);
}

// A parse failure under a bash shell with no productive parse must stay conservative.
const broken = await analyzeCommand(")))", { ...ctx, path: defaultPath, shellKind: "bash" });
check(
  "bash parse failure is not allowed",
  evaluateCommandApproval(broken, { agentKind: "root" }).action === "allow",
  false
);

if (failures > 0) {
  console.error(`\nvalidate:command-safety-portability FAILED (${failures} case(s))`);
  process.exit(1);
}
console.log("\nvalidate-command-safety-portability: ok");
