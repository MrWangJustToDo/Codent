/**
 * Shared scanner for the "a shared rule has one definition" guards.
 *
 * Each guard names the pattern(s) that re-derive a shared rule and the module(s) allowed to
 * contain them, and reports every other file as `file:line`. The walk and the reporting live here
 * once so the guards stay a few lines each — the alternative is eight copies of the same
 * `readdirSync` loop, which is the very shape this change exists to remove.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "../../src");
const repoRoot = resolve(here, "../../../..");
const packagesRoot = join(repoRoot, "packages");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".wxt",
  ".output",
  ".turbo",
  "coverage",
  "scripts",
  "test",
  "tests",
]);

/** Every `.ts` file under `packages/core/src`, excluding generated trees. */
export function sourceFiles(dir = srcRoot, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * Every `.ts`/`.tsx` source file in every workspace package.
 *
 * A "one definition" rule is only a rule if the consumer side is scanned too. Excluded on purpose:
 * - `workers/` — `packages/playground/workers/*` are standalone runtimes (a fetch proxy with its
 *   own entry); importing the core barrel there would pull the whole agent into a Worker bundle.
 * - `packages/mcp-server` — a standalone MCP server with no `@codent/core` dependency; giving it
 *   one to share an error helper is the wrong trade.
 * - `vite-plugins/` — build-time tooling, not a runtime host.
 */
const SKIP_PACKAGES = new Set(["mcp-server"]);

export function packageSourceFiles(out = []) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "workers" || entry.name === "vite-plugins" || SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(full);
    }
  };
  for (const pkg of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!pkg.isDirectory() || pkg.name.startsWith(".") || SKIP_PACKAGES.has(pkg.name)) continue;
    walk(join(packagesRoot, pkg.name));
  }
  return out;
}

/**
 * Scan every package (not just core) for re-derived shared rules.
 *
 * `definitionFiles` are repo-relative paths (`packages/core/src/utils/errors.ts`).
 */
export function scanPackages({ patterns, definitionFiles = [] }) {
  const allowed = new Set(definitionFiles);
  const offenders = [];
  for (const file of packageSourceFiles()) {
    const rel = relative(repoRoot, file).split("\\").join("/");
    if (allowed.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const { re, reason } of patterns) {
        if (re.test(line)) offenders.push({ rel, line: index + 1, text: line.trim(), reason });
      }
    });
  }
  return offenders;
}

/**
 * Every line outside the allowlisted definition modules that matches one of `patterns`.
 *
 * @param {{ patterns: Array<{ re: RegExp, reason: string }>, definitionFiles?: string[], scope?: string }} options
 *   `definitionFiles` are paths relative to `src/`. `scope` limits the scan to a subdirectory of
 *   `src/` (also relative). Returns `{ rel, line, text, reason }[]`.
 */
export function scanSource({ patterns, definitionFiles = [], scope }) {
  const allowed = new Set(definitionFiles);
  const root = scope ? join(srcRoot, scope) : srcRoot;
  const offenders = [];
  for (const file of sourceFiles(root)) {
    const rel = relative(srcRoot, file).split("\\").join("/");
    if (allowed.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const { re, reason } of patterns) {
        if (re.test(line)) offenders.push({ rel, line: index + 1, text: line.trim(), reason });
      }
    });
  }
  return offenders;
}

/** Run a guard: print each offender and exit non-zero when any exists. */
export function runGuard({ name, patterns, definitionFiles = [], scope, note }) {
  const offenders = scanSource({ patterns, definitionFiles, scope });
  if (offenders.length > 0) {
    process.stderr.write(`${name}: re-derived a shared rule instead of calling its definition:\n`);
    for (const offender of offenders) {
      process.stderr.write(`  ${offender.rel}:${offender.line}  (${offender.reason})\n      ${offender.text}\n`);
    }
    if (note) process.stderr.write(`\n${note}\n`);
    process.exit(1);
  }
  process.stdout.write(`${name}: ok\n`);
}
