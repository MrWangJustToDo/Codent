/**
 * Validate that no tool body constructs a POSIX shell command string.
 *
 * Why this exists: the tools used to build command strings containing `set -o pipefail`,
 * `2>/dev/null`, and `| head -n N`. That silently committed every search tool to bash —
 * `set -o pipefail` is not a PowerShell option, so on Windows `glob`, `grep`, `tree`, and
 * skill loading were parse errors rather than degraded results. Reading code does not catch
 * a regression here, because a new `runCommand(` call looks perfectly ordinary.
 *
 * The check is pattern-based on purpose: it flags the shell-only constructs themselves,
 * which is exactly the set of things that cannot work outside a POSIX shell.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// `scripts/` is one level below the package root, so `..` from this file resolves to
// `packages/core/`. Getting this wrong is not a cosmetic bug: the scan would find no files
// and report success, which is a green light over an empty set.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["src/agent/tools", "src/agent/skills"];

/**
 * Shell-only constructs that must never appear in executable code.
 *
 * `pipefail` and `head` pipelines are bash-isms; `2>/dev/null` is POSIX redirection that is
 * a syntax error under cmd.exe (`2>nul`).
 */
const FORBIDDEN = [
  { pattern: /set\s+-o\s+pipefail/, what: "`set -o pipefail` (bash-only option)" },
  { pattern: /2>\s*\/dev\/null/, what: "`2>/dev/null` (POSIX redirection)" },
  { pattern: /\|\s*head\s+-?n?\s*\d/, what: "`| head -n N` (POSIX pipeline)" },
  { pattern: />\s*\/dev\/null/, what: "`>/dev/null` (POSIX redirection)" },
  { pattern: /\bcommand\s+-v\b/, what: "`command -v` (POSIX shell builtin)" },
];

/** Strip block and line comments so documentation of the old approach is not flagged. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function collectFiles(dir) {
  const out = [];
  // A missing scan directory must be an error, not an empty result: silently scanning
  // nothing reports "ok" and looks like a passing check.
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const violations = [];
let scanned = 0;
for (const dir of SCAN_DIRS) {
  const files = collectFiles(join(ROOT, dir));
  if (files.length === 0) {
    console.error(`validate-tool-shell-portability: FAIL - no .ts files found under ${dir}`);
    console.error(`Resolved root: ${ROOT}\nThe scan root is wrong, so this check would pass vacuously.`);
    process.exit(1);
  }
  for (const file of files) {
    scanned += 1;
    const source = stripComments(readFileSync(file, "utf8"));
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      for (const { pattern, what } of FORBIDDEN) {
        if (pattern.test(lines[i])) {
          violations.push({ file: relative(ROOT, file), line: i + 1, what, text: lines[i].trim() });
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error("validate-tool-shell-portability: FAIL");
  console.error("Tool code must not construct POSIX shell command strings.\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error(`    ${v.text}`);
  }
  console.error(
    "\nUse the argv path instead: `execArgs()` / `execArgsCapture()` from `agent/tools/builtin/shell/exec-args.ts`,\n" +
      "with truncation via `truncateLines()`. A shell string is only valid for the one shell family\n" +
      "it was written for, which is why these constructs cannot be made portable."
  );
  process.exit(1);
}

console.log(
  `validate-tool-shell-portability: ok (${scanned} files, no shell-string constructs in ${SCAN_DIRS.join(", ")})`
);
