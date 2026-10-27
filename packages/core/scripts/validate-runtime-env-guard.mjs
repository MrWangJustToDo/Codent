/**
 * Validates the runtime-env guard: the run path resolves its environment/model-provider from
 * the owning runtime (via the run context or an injected value), never from the process-global
 * `getEnv()` / `getModelProvider()` registries.
 *
 * Allowed forms:
 *   - an explicit fallback: `x ?? getEnv()` (the injected value wins; ambient only when no runtime
 *     was supplied — the documented compatibility seam). A bare assignment (`const env = getEnv()`)
 *     is NOT a fallback and is reported; it reads the ambient registry unconditionally.
 *   - the explicit allowlist below, each with the reason it is not a workspace-scoped read.
 *
 * Run: pnpm --filter @codent/core run validate:runtime-env-guard
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Run-path directories whose files must not read the global env directly. */
const SCAN_DIRS = [
  "agent/tools",
  "agent/media",
  "agent/persistence",
  "agent/mcp",
  "managers",
  "provider",
  "models",
  "runtime",
  "agent-session",
  "agent/usage",
  "agent/code-mode",
  "agent/prompt",
  "agent/turn-context",
  "agent/plan",
  "agent/log",
  "agent/extension",
  "agent/skills",
  "agent/memory",
  "agent/subagent",
  "agent/runner",
  "agent/compaction",
  "agent/ui",
  "agent/approval",
  "agent/todo",
];

/** Files allowed to reference the global env, with the reason. */
const ALLOWLIST = new Map([
  [
    "agent/extension/runner.ts",
    "resolveCoreEnv()'s final fallback: injected getCoreEnv wins, then a hasCoreEnv()-guarded ambient read, then a non-throwing stub for standalone runners",
  ],
  [
    "provider/models-dev.ts",
    "process-global models.dev metadata (identical across workspaces; the in-memory memo is global by design) and no runtime is in scope. The disk cache path is workspace-scoped, so it follows the AMBIENT root — the multi-runtime caveat is documented in models-dev.ts and the design inventory.",
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
    // Normalize to POSIX separators: `relative()` yields `\` on Windows, but the
    // allowlist keys use `/`, so an unnormalized path would false-positive every
    // allowlisted file there.
    const relPath = relative(SRC, file).split(sep).join("/");
    const allowReason = ALLOWLIST.get(relPath);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//") || line.trimStart().startsWith("/"))
        return;
      CALL_RE.lastIndex = 0;
      let m;
      while ((m = CALL_RE.exec(line)) !== null) {
        const before = line.slice(0, m.index);
        // A fallback is either `x ?? getEnv()`, a ternary (`env ? resolve(env) : getEnv()`), or a
        // typed default parameter (`env: CoreEnv = getEnv()`). A bare assignment
        // (`const env = getEnv()`) reads the ambient registry unconditionally and is reported —
        // the blind spot that hid the unmigrated call sites.
        const isFallback =
          /\?\?\s*$/.test(before) || /\?\s[^:]*:\s*$/.test(before) || /:[\s\w.<>[\],|]+\s*=\s*$/.test(before);
        if (isFallback) continue;
        // A method *named* `getEnv` / `getModelProvider` (e.g. `getEnv(): ResolvedCoreEnv {`,
        // `getModelProvider() {`) is not a registry call.
        if (/^get(?:Env|ModelProvider)\s*\(\s*\)\s*(?::|\{)/.test(line.slice(m.index))) continue;
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
