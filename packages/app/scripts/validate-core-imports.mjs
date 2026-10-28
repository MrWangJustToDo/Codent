/**
 * Fail if @codent/app UI code imports forbidden @codent/core runtime APIs.
 *
 * Run: pnpm --filter @codent/app run validate:core-imports
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(scriptDir, "../src");

/**
 * Runtime singletons / stateful classes stay forbidden — the host process owns
 * them. Pure resolvers (`resolveModelConfigFromProvider`,
 * `buildDefaultSystemPrompt`) are allowed: no runtime state crosses the seam.
 */
const FORBIDDEN_IDENTIFIERS = [
  "agentManager",
  "AgentManager",
  "ManagedAgent",
  "createManagedAgent",
  "createLocalAgentSessionHost",
  "SessionStore",
  "TodoManager",
  "AgentLog",
  "autoCompact",
  "applyCompactionResult",
  "runSideTextQuery",
  "resolveTextAdapterForManaged",
  "ExtensionRunner",
  "ExtensionLoader",
  // The workspace env reaches the app through <CoreEnvProvider> / useCoreEnv, never the
  // ambient registry — an ambient read would bind to whichever runtime registered last.
  "getEnv",
  "hasCoreEnv",
  "clearCoreEnv",
  "registerCoreEnv",
];

/**
 * Pure resolvers the UI may call: they read only their arguments (no process state), so no runtime
 * singleton crosses the seam. Kept as an explicit allowlist WITH the reason, instead of a skip
 * clause on the denylist above (which silently exempted `agentManager` and
 * `createLocalAgentSessionHost` too — they were listed as forbidden and then always skipped).
 */
const ALLOWED_PURE_IDENTIFIERS = new Set(["buildDefaultSystemPrompt", "resolveModelConfigFromProvider"]);

function walkTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function extractNamedImports(line) {
  const brace = line.match(/\{([^}]*)\}/);
  if (!brace) return [];
  return brace[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name] = part.split(/\s+as\s+/);
      return name.replace(/^type\s+/, "").trim();
    })
    .filter(Boolean);
}

/** Forbidden named imports in one file's text, as `{ line, name }`. */
function scanCoreImports(text) {
  const found = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Statement start, not "a line that already names the module". The old gate tested the LINE
    // for `@codent/core` (or the single-line import shape) before its multi-line branch could
    // run, so `import {\n moduleA,\n} from "@codent/core";` was skipped entirely — 7 real
    // multi-line imports went unparsed while the script printed a clean pass.
    if (!/^\s*(?:import|export)\b/.test(line)) continue;
    let block = line;
    if (!/\bfrom\s*["']/.test(line)) {
      // Accumulate the statement (named or default imports) until its `from "…"` clause.
      for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
        block += "\n" + lines[j];
        if (/\bfrom\s*["']/.test(block)) break;
        // A side-effect import (`import "x";`) has no from-clause; it cannot name a binding.
        if (/^\s*import\s*["']/.test(line) || /;\s*$/.test(lines[j])) break;
      }
    }
    if (!block.includes("@codent/core")) continue;

    // A namespace import binds every export at once, so no named-import scan can see it.
    if (/\bimport\s+\*\s+as\s+/.test(block)) {
      found.push({ line: i + 1, name: "* as namespace" });
      continue;
    }

    for (const name of extractNamedImports(block)) {
      if (ALLOWED_PURE_IDENTIFIERS.has(name)) continue;
      if (!FORBIDDEN_IDENTIFIERS.includes(name)) continue;
      found.push({ line: i + 1, name });
    }
  }
  return found;
}

// Canary: the real tree may have no violating multi-line import (it does not today), so a
// regression to the old line-gated scan would still print a clean pass. This pins the shape the
// gate exists to see.
{
  const canary = 'import {\n  agentManager,\n} from "@codent/core";';
  if (!scanCoreImports(canary).some((v) => v.name === "agentManager")) {
    console.error("app core-imports: the scanner no longer sees a multi-line core import");
    process.exit(1);
  }
}

const violations = [];
for (const file of walkTsFiles(srcRoot)) {
  const rel = relative(srcRoot, file).replaceAll("\\", "/");
  const text = readFileSync(file, "utf8");
  for (const v of scanCoreImports(text)) violations.push({ ...v, file: rel });
}

if (violations.length > 0) {
  console.error("@codent/app forbidden @codent/core imports:");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  imports "${v.name}"`);
  }
  console.error("\nSee packages/app/README.md allowlist. Prefer AgentSession.dispatch / Host APIs.");
  process.exit(1);
}

console.log("app core-imports validation passed (0 forbidden)");
