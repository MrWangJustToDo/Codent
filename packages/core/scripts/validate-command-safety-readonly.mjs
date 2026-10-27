/**
 * Validate the read-only command table's *argument* semantics.
 *
 * A name-only read-only entry is a fail-open whenever the command's danger lives in its
 * arguments rather than its name. This asserts the specific holes that a `READONLY_PREFIXES`
 * membership check left open, plus the genuine read-only forms those commands still have:
 *
 * - `env` — only a pure assignment list (`env FOO=1`) is read-only; `env rm -rf x`,
 *   `env -i sh -c …`, `env -u FOO cmd` launch another program and must ask.
 * - `find` — read-only unless a write/exec predicate (`-delete`, `-exec`, …) is present.
 * - `sed` — read-only unless its *script* contains `w` / `W` / `r` / `R` / `e` (or the existing
 *   `-i` flag is present). Letters inside a pattern/replacement (`s/world/earth/`) must NOT count.
 * - `git diff` / `log` / `show` — `--output[=]` writes a file; `--output-indicator-*` does not.
 *
 * The second half covers the invocation-level table (`readonly-rules.ts`): every command newly
 * admitted without a prompt is paired with the form that WOULD write, and that form must still
 * ask. A bare allow-list without its write counterpart is what let `sort -o` and `uniq in out`
 * through, so the pairs are the point of the block rather than an extra.
 *
 * The read-only axis asserted here is the analyzer's own (`isReadOnly` per command, no write op).
 * External-path prompting is a *separate* axis — `find . -name "*.ts"` is read-only yet its
 * `*.ts` glob argument counts as unresolvable/external — so it is deliberately not folded in.
 *
 * Modelled on validate-command-safety-portability.mjs: the bash grammar is located from the real
 * `tree-sitter-wasms` install so the AST path is genuinely exercised. If the grammar were absent,
 * the "still read-only" assertions below would fail loudly rather than pass for the wrong reason.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeCommand, defaultPath, evaluateCommandApproval, getEnv, registerCoreEnv } from "../dist/dev.mjs";

// ----------------------------------------------------------------------------
// Minimal CoreEnv so the AST path can actually run (see the portability validator
// for the same setup). Without a registered env, `parseCommandTree` returns null
// for every input and the "still read-only" assertions below are meaningless.
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

const analyze = (cmd, shellKind) => analyzeCommand(cmd, { ...ctx, path: defaultPath, shellKind });

/** The analyzer's read-only reading: every command read-only, with no write op. */
function isReadOnly(report) {
  return report.commands.length > 0 && !report.anyWriteOp && report.commands.every((c) => c.isReadOnly);
}

// ----------------------------------------------------------------------------
// Canary: the bash grammar must be present, or "still read-only" below is a false green.
// ----------------------------------------------------------------------------

const canary = await analyze("git diff", "bash");
check("canary: bash grammar present (git diff parses read-only)", isReadOnly(canary), true);

// ----------------------------------------------------------------------------
// These wrote/executed with no approval prompt before the fix. Each must now be not read-only,
// and the root agent must be prompted (never auto-allowed).
// ----------------------------------------------------------------------------

const mustAsk = [
  ["env rm -rf src", "env rm -rf src"],
  ["env sh -c", 'env sh -c "rm -rf src"'],
  ["env -i sh -c", 'env -i sh -c "rm -rf src"'],
  ["env -u FOO cmd", "env -u FOO cmd"],
  ["find -delete", "find . -delete"],
  ["find -exec", "find . -exec rm -rf {} ;"],
  ["sed -e write", 'sed -e "w /tmp/pwn" f'],
  ["sed 1w write", 'sed -n "1w /tmp/pwn" f'],
  ["sed 1,5w write", "sed '1,5w /tmp/pwn' f"],
  ["sed s-flag write", 'sed "s/a/b/w /tmp/x" f'],
  ["sed e execute", 'sed "e ls" f'],
  ["sed 1e execute", "sed '1e ls' f"],
  // Existing conservative rule must be untouched.
  ["sed -i in place", "sed -i 's/a/b/' f"],
  ["git diff --output= writes", "git diff --output=/repo/x"],
  ["git log --output= writes", "git log --output=/repo/x"],
  ["git show --output= writes", "git show --output=/repo/x"],
  // Process substitution has no `$`/backtick, so it used to be swallowed as a redirection
  // target: only `cat` was classified and `cat <(rm -rf src)` was auto-approved. The body is a
  // command that really runs and must be classified on both paths.
  ["process substitution", "cat <(rm -rf src)"],
  ["process substitution via sh", "cat <(sh -c 'rm -rf src')"],
  ["output process substitution", "tee >(rm -rf src)"],
  // `xxd` writes its second OPERAND even without `-r`; only one operand keeps stdout.
  ["xxd with an output operand", "xxd in.bin out.bin"],
];

for (const [label, cmd] of mustAsk) {
  const report = await analyze(cmd, "bash");
  check(`readonly: ${label} is not read-only`, isReadOnly(report), false);
  check(
    `readonly: ${label} is not auto-allowed for root`,
    evaluateCommandApproval(report, { agentKind: "root" }).action === "allow",
    false
  );
}

// ----------------------------------------------------------------------------
// The genuine read-only forms of those same commands must NOT start prompting as writes.
// ----------------------------------------------------------------------------

const mustAllow = [
  ["env bare", "env"],
  ["env assignment", "env FOO=1"],
  ["env assignments", "env A=1 B=2"],
  ["find ordinary", 'find . -name "*.ts"'],
  ["sed range print", "sed -n '1,20p' f"],
  ["sed substitution", "sed 's/foo/bar/' f"],
  ["sed substitution with w/e in words", "sed 's/world/earth/' f"],
  ["sed -e substitution", "sed -e 's/foo/bar/' f"],
  ["sed range print (no -n)", "sed '1,20p' f"],
  ["git diff", "git diff"],
  ["git log", "git log --oneline"],
  ["git diff --output-indicator is not a write", "git diff --output-indicator-new=+ --output-indicator-old=-"],
  // `xxd` prints unless `-r` names an output operand.
  ["xxd print", "xxd f"],
  ["xxd reverse to stdout", "xxd -r in.hex"],
  // Process substitution inside double quotes is literal text, not a command.
  ["quoted process substitution is literal", 'echo "a <(b)"'],
];

for (const [label, cmd] of mustAllow) {
  const report = await analyze(cmd, "bash");
  check(`readonly: ${label} is read-only`, isReadOnly(report), true);
}

// ----------------------------------------------------------------------------
// The same classification is shared by the grammar-less fallback (PowerShell/cmd), so the
// session-relevant write forms must stay closed there too.
// ----------------------------------------------------------------------------

for (const [label, cmd] of [
  ["env rm -rf src", "env rm -rf src"],
  ["env -i sh -c", 'env -i sh -c "rm -rf src"'],
  ["find -delete", "find . -delete"],
  ["find -exec", "find . -exec rm -rf {} ;"],
  ["sed -e write", 'sed -e "w /tmp/pwn" f'],
  ["git log --output=", "git log --output=/repo/x"],
]) {
  const report = await analyze(cmd, "powershell");
  check(`fallback: ${label} is not read-only`, isReadOnly(report), false);
}

for (const [label, cmd] of [
  ["env assignment", "env FOO=1"],
  ["find ordinary", 'find . -name "*.ts"'],
  ["sed range print", "sed -n '1,20p' f"],
]) {
  const report = await analyze(cmd, "powershell");
  check(`fallback: ${label} is read-only`, isReadOnly(report), true);
}

// ----------------------------------------------------------------------------
// Invocation-level table: each newly admitted command, and the form that writes.
//
// The pair is the assertion. `sort -o out.txt` was auto-approved because `sort` had a
// name-only entry; `uniq in.txt out.txt` had the same shape through its second POSITIONAL
// operand. A new entry therefore has to ship with the write form it is guarding against, or
// the next flag someone adds reopens the hole silently.
// ----------------------------------------------------------------------------

const admitted = [
  // plain read-only
  ["tail", "tail -5 f"],
  ["stat", "stat f"],
  ["file", "file f"],
  ["diff", "diff a b"],
  ["du", "du -sh src"],
  ["df", "df -h"],
  ["tr", "tr a-z A-Z"],
  ["jq", "jq '.a' f"],
  ["column", "column -t f"],
  ["md5sum", "md5sum f"],
  ["base64", "base64 f"],
  ["id", "id"],
  ["whoami", "whoami"],
  ["hostname", "hostname"],
  ["date", "date"],
  ["printenv", "printenv HOME"],
  ["sleep", "sleep 1"],
  ["expr", "expr 1 + 1"],
  ["seq", "seq 1 5"],
  ["true", "true"],
  ["tree (no -o)", "tree -L 2 src"],
  ["rg", "rg TODO src"],
  ["eslint (no --fix)", "eslint src"],
  ["prettier --check", "prettier --check src"],
  ["tsc --noEmit", "tsc --noEmit"],

  // git, by subcommand
  ["git branch -a", "git branch -a"],
  ["git tag -l", "git tag -l"],
  ["git remote -v", "git remote -v"],
  ["git rev-parse", "git rev-parse HEAD"],
  ["git blame", "git blame f"],
  ["git ls-files", "git ls-files"],
  ["git config --get", "git config --get user.name"],
  ["git config lone key", "git config user.name"],
  ["git -C dir log", "git -C /repo log --oneline"],
  ["git stash list", "git stash list"],
];

for (const [label, cmd] of admitted) {
  const report = await analyze(cmd, "bash");
  check(`admitted: ${label} is read-only`, isReadOnly(report), true);
  check(
    `admitted: ${label} is auto-allowed for root`,
    evaluateCommandApproval(report, { agentKind: "root" }).action,
    "allow"
  );
}

// Each admitted name's writing form. These must never be read-only on either path.
const writeForms = [
  ["tree -o", "tree -o out.txt src"],
  ["tree --output", "tree --output out.txt src"],
  ["date -s", "date -s 2020-01-01"],
  ["date --set", "date --set=2020-01-01"],
  ["eslint --fix", "eslint --fix src"],
  ["eslint --output-file", "eslint --output-file out.json src"],
  ["prettier --write", "prettier --write src"],
  ["prettier -w", "prettier -w src"],
  ["rg --pre", "rg --pre sh foo"],
  ["rg --pre=", "rg --pre=sh foo"],
  ["rg --pager", "rg --pager less foo"],
  ["jq -i", "jq -i '.a=1' f"],
  ["jq --in-place", "jq --in-place '.a=1' f"],

  // The `uniq` hole this change closes: the SECOND operand is an output file.
  ["uniq two operands", "uniq in.txt out.txt"],
  ["uniq two operands -c", "uniq -c in.txt out.txt"],

  ["hostname rename", "hostname evil"],
  ["command runs a program", "command ls"],

  // `tsc` emits JavaScript unless told not to.
  ["tsc plain", "tsc"],
  ["tsc -p", "tsc -p tsconfig.json"],

  // git subcommands that mutate on their ARGUMENTS, not on a flag.
  ["git branch create", "git branch newbranch"],
  ["git branch -D", "git branch -D main"],
  ["git tag create", "git tag v1.0"],
  ["git tag -d", "git tag -d v1.0"],
  ["git config assign", "git config user.name x"],
  ["git config --global assign", "git config --global user.name x"],
  ["git remote add", "git remote add origin url"],
  ["git stash pop", "git stash pop"],
  ["git reflog expire", "git reflog expire --all"],
  ["git push", "git push"],
  ["git commit", "git commit -m x"],
  ["git checkout", "git checkout main"],

  // Config/program injection through a GLOBAL git option: the subcommand is still `log`/`diff`,
  // but `-c core.pager=…` / `-c diff.external=…` make git execute it.
  ["git -c pager", 'git -c core.pager="sh -c id" log --paginate'],
  ["git -c external diff", "git -c diff.external=/tmp/evil diff"],
  ["git --exec-path", "git --exec-path=/tmp/evil status"],
  ["git --config-env", "git --config-env=core.pager=EVIL log"],

  // `xxd -r IN OUT` reverses into OUT; `man` is not in the table because `-P` runs a pager.
  ["xxd reverse writes", "xxd -r report.hex out.bin"],
  ["xxd writes without -r", "xxd in.bin out.bin"],
  ["man -P executes", 'man -P "sh -c id" ls'],
];

for (const [label, cmd] of writeForms) {
  const parsed = await analyze(cmd, "bash");
  check(`write-form: ${label} is not read-only`, isReadOnly(parsed), false);
  check(
    `write-form: ${label} is not auto-allowed for root`,
    evaluateCommandApproval(parsed, { agentKind: "root" }).action === "allow",
    false
  );
  // The grammar-less fallback shares the tables, so the same form must stay closed there.
  const fallbackReport = await analyze(cmd, "powershell");
  check(`write-form (fallback): ${label} is not read-only`, isReadOnly(fallbackReport), false);
}

if (failures > 0) {
  console.error(`\nvalidate-command-safety-readonly FAILED (${failures} case(s))`);
  process.exit(1);
}
console.log("\nvalidate-command-safety-readonly: ok");
