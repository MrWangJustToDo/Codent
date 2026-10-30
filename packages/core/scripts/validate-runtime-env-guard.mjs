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
 * Scope is **default-deny**: every file under `src/` is scanned except {@link EXCLUDED}. The
 * previous form was a 24-entry allowlist of *directories*, so `agent/stream-hub`, `agent/jobs`,
 * `agent/queue`, `agent/run`, `agent/stream`, `agent/agent-log`, `agent/agent-event-bus`,
 * `agent/commands`, `agent/tree-sitter` and every `agent/*.ts` root file were outside the guard by
 * omission — a new ambient read in any of them passed silently. Default-deny moves the cost to the
 * right place: a new exemption has to be written down with a reason.
 *
 * Run: pnpm --filter @codent/core run validate:runtime-env-guard
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * Top-level `src/` entries outside the guard, each with the reason it is not a workspace-scoped
 * read. Everything else is scanned, so a new directory is covered without editing this file.
 */
const EXCLUDED = new Map([
  ["env", "the registry itself: this module DEFINES getEnv() / getModelProvider()"],
  ["dev", "test/dev-only barrel modules (not reachable from the published export map)"],
  ["dev.ts", "test/dev-only entry (not reachable from the published export map)"],
]);

/** Files allowed to reference the global env, with the reason. */
const ALLOWLIST = new Map([
  [
    "agent/extension/runner.ts",
    "resolveCoreEnv()'s final fallback: injected getCoreEnv wins, then a hasCoreEnv()-guarded ambient read, then a non-throwing stub for standalone runners",
  ],
  [
    "provider/models-dev/cache.ts",
    "process-global models.dev metadata (identical across workspaces; the in-memory memo is global by design) and no runtime is in scope. The disk cache path is workspace-scoped, so it follows the AMBIENT root — the multi-runtime caveat is documented in models-dev/cache.ts and the design inventory. The parse/rank modules are pure and must stay off this list.",
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

// Default-deny: collect every source file under `src/`, then drop the excluded top-level entries.
const files = [];
for (const name of readdirSync(SRC)) {
  if (EXCLUDED.has(name)) continue;
  const p = join(SRC, name);
  const s = statSync(p);
  if (s.isDirectory()) walk(p, files);
  else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) files.push(p);
}

const offenders = [];
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

if (offenders.length > 0) {
  console.error("runtime-env guard: the run path reads the global env/provider directly:\n");
  for (const o of offenders) console.error("  " + o);
  console.error(
    "\nResolve the env from the run context (tools) or an injected runtime (stores/services); " +
      "or add the file to ALLOWLIST with a reason if it is not workspace-scoped. A whole directory " +
      "only belongs in EXCLUDED if it can never run on the agent's behalf."
  );
  process.exit(1);
}

console.log("runtime-env guard passed: no direct global env read on the run path");
