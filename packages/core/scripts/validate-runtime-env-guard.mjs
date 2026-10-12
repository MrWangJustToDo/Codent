/**
 * Validates the runtime-env guard: the run path resolves its environment/model-provider from
 * the owning runtime (via the run context or an injected value), never from the process-global
 * `getEnv()` / `getModelProvider()` registries.
 *
 * Allowed forms:
 *   - a fallback/default: `x ?? getEnv()`, `= getEnv()` (injected value wins; ambient only when
 *     no runtime was supplied — the documented compatibility seam);
 *   - the explicit allowlist below, each with the reason it is not a workspace-scoped read.
 *
 * Run: pnpm --filter @codent/core run validate:runtime-env-guard
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Run-path directories whose files must not read the global env directly. */
const SCAN_DIRS = ["agent/tools", "agent/media", "agent/persistence", "agent/mcp", "managers"];

/** Files allowed to reference the global env, with the reason. */
const ALLOWLIST = new Map([
  [
    "agent/tools/runtime/define-tool.ts",
    "the ambient fallback Proxy — resolves getEnv() only when a tool runs without a run context",
  ],
  [
    "agent/tools/command-safety/command-parser.ts",
    "resolves the host's shell kind + grammar; host-level, not workspace-scoped data",
  ],
  [
    "agent/tools/util/command-output-log.ts",
    "background-job log files; the job registry is converged to the runtime in Stage 4",
  ],
  [
    "agent/tools/util/preview-edit.ts",
    "public host helper with no internal caller; ambient env is the intended source",
  ],
]);

const CALL_RE = /(?<![.\w])(getEnv|getModelProvider)\s*\(/g;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
}

const offenders = [];
for (const rel of SCAN_DIRS) {
  const base = join(SRC, rel);
  const files = [];
  try {
    walk(base, files);
  } catch {
    continue;
  }
  for (const file of files) {
    const relPath = relative(SRC, file);
    const allowReason = ALLOWLIST.get(relPath);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//") || line.trimStart().startsWith("/"))
        return;
      CALL_RE.lastIndex = 0;
      let m;
      while ((m = CALL_RE.exec(line)) !== null) {
        const before = line.slice(0, m.index);
        const isFallback = /\?\?\s*$/.test(before) || /=\s*$/.test(before);
        if (isFallback) continue;
        // A method *named* `getEnv` (e.g. `getEnv(): ResolvedCoreEnv {`) is not the registry call.
        if (/^getEnv\s*\(\s*\)\s*:/.test(line.slice(m.index))) continue;
        if (allowReason) continue;
        offenders.push(`${relPath}:${i + 1}  ${line.trim()}`);
      }
    });
  }
}

if (offenders.length > 0) {
  console.error("runtime-env guard: the run path reads the global env/provider directly:\n");
  for (const o of offenders) console.error("  " + o);
  console.error(
    "\nResolve the env from the run context (tools) or an injected runtime (stores/services); " +
      "or add the file to ALLOWLIST with a reason if it is not workspace-scoped."
  );
  process.exit(1);
}

console.log("runtime-env guard passed: no direct global env read on the run path");
