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

const CORE_IMPORT_RE =
  /(?:import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+|import\s*\(\s*)["']@codent\/core(?:\/[^"']*)?["']/;

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

const violations = [];
for (const file of walkTsFiles(srcRoot)) {
  const rel = relative(srcRoot, file).replaceAll("\\", "/");
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!CORE_IMPORT_RE.test(line) && !line.includes("@codent/core")) continue;
    // Multi-line import: check following lines until from "@codent/core"
    let block = line;
    if (line.includes("import") && line.includes("{") && !line.includes("}")) {
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        block += "\n" + lines[j];
        if (lines[j].includes("}")) break;
      }
    }
    if (!block.includes("@codent/core")) continue;

    const names = extractNamedImports(block);
    for (const name of names) {
      if (ALLOWED_PURE_IDENTIFIERS.has(name)) continue;
      if (!FORBIDDEN_IDENTIFIERS.includes(name)) continue;
      violations.push({ file: rel, line: i + 1, name });
    }
  }
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
