/**
 * Grep gate: core must not resolve LLM/tool secrets from env bags or CoreEnv.getEnv() digs.
 *
 * Run: pnpm --filter @codent/core run validate:core-no-env-config
 *
 * Uses ripgrep when available, otherwise falls back to a Node-native recursive
 * scan so the gate runs in any environment (no external binary dependency).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");

/**
 * Scan source files, returning matching lines for `pattern` among files whose
 * relative path matches a glob such as `**`-slash-`models`-slash-`**` (a dir
 * wildcard) or a filename pattern. Pure-Node fallback: only the glob shapes
 * used by this script are supported (dir wildcard or plain filename).
 */
function scanNative(pattern, globs) {
  const re = new RegExp(pattern);
  const results = [];
  // Normalize `**/x/**` -> directory prefix `x/` (any ancestor), and
  // `**/x.ts` -> any path ending in the filename. `**/` is a wildcard for any
  // number of leading path segments.
  const dirPrefixes = globs
    .filter((g) => g.endsWith("/**"))
    .map((g) => g.replace(/^\*\*\//, "").replace(/\/\*\*$/, "") + "/");
  const fileSuffixes = globs.filter((g) => !g.endsWith("/**")).map((g) => g.replace(/^\*\*\//, ""));

  function matchesGlobs(rel) {
    const norm = rel.split(path.sep).join("/");
    return (
      dirPrefixes.some((p) => norm.startsWith(p)) || fileSuffixes.some((s) => norm === s || norm.endsWith(`/${s}`))
    );
  }

  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && full.endsWith(".ts")) {
        const rel = path.relative(src, full);
        if (!matchesGlobs(rel)) continue;
        const lines = readFileSync(full, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (re.test(line)) {
            results.push(`${rel}:${i + 1}:${line.trim()}`);
          }
        });
      }
    }
  }

  walk(src);
  return results;
}

function rg(pattern, globs) {
  // Prefer ripgrep when present (faster); fall back to native scan otherwise.
  const hasRg = (() => {
    try {
      execFileSync("rg", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  if (!hasRg) {
    return scanNative(pattern, globs).join("\n");
  }

  const args = ["-n", "--no-heading", "-e", pattern, src];
  for (const g of globs) {
    args.push("--glob", g);
  }
  try {
    return execFileSync("rg", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && err.status === 1) {
      return "";
    }
    throw err;
  }
}

const hits = [
  rg("env\\s*\\?:\\s*Record", ["**/models/**"]),
  rg("parseModelInfoFromEnv", ["**/models/**", "**/index.ts"]),
  rg("MODEL_ENV_KEYS", ["**/models/**", "**/index.ts"]),
  rg("(BRAVE|EXA|PARALLEL|TAVILY)_API_KEY", ["**/agent/tools/websearch/**", "**/agent/tools/websearch-tool.ts"]),
  rg("WEBSEARCH_PROVIDER", ["**/agent/tools/websearch/**", "**/agent/tools/websearch-tool.ts"]),
  rg("getEnv\\(\\)\\.getEnv\\(\\)", ["**/agent/tools/websearch/**"]),
  rg("env:\\s*process\\.env", ["**/models/**"]),
]
  .filter(Boolean)
  .join("\n");

assert.equal(hits, "", `core-no-env-config: forbidden patterns found:\n${hits}`);

console.log("core-no-env-config validation passed");
