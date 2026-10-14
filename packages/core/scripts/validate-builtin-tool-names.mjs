/**
 * Validation: the canonical built-in tool registry (`BUILTIN_TOOL_NAMES`) matches
 * the tools core actually builds.
 *
 * Run: pnpm --filter @codent/core run validate:builtin-tool-names
 *
 * Hosts key rendering/routing off `BUILTIN_TOOL_NAMES`, so a tool declared in core
 * but missing from the registry (or a stale registry entry with no tool) would make a
 * host silently mis-handle it. The expected set is derived from the sources — the
 * presentation fallback table (core's classification list), every tool that declares
 * `present`, and the two const/dynamic names — and compared to the exported registry.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILTIN_TOOL_NAMES } from "../dist/dev.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const TABLE_FILE = join(SRC, "agent/tools/presentation/builtin-table.ts");

/** The plan authoring factory takes its name as a parameter (not a literal). */
const FACTORY_NAMES = ["create_plan", "update_plan"];

/** Assembled at runtime; their only definition site is the fallback table. */
const DYNAMIC_TABLE_ONLY = new Set(["discover_tools", "execute_typescript"]);

/** The summary marker is defined by a const and carries no `present` block. */
const CONST_NAMED = ["begin_summary"];

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Every tool name that declares `present` at its definition site.
 *
 * `name` and `present` are two keys of the same object literal, so what proves the pairing is that
 * both appear in the same definition — NOT that one newline separates them. The previous pattern
 * required `name:` + `,` + newline + `present:`, which a formatter is free to invalidate by writing
 * `name: "x", present: { … }` on one line. When that happened the tool silently left the expectation
 * set and the failure blamed `BUILTIN_TOOL_NAMES` (`lists tools core does not build`) — the registry —
 * for a definition that was merely formatted differently. Looking for `present:` in the window right
 * after the `name` key keeps the two keys of one object together without pinning their layout.
 */
function collectDeclared() {
  const declared = new Set();
  const key = /\bname(?::\s*"([a-z_]+)")?\s*,/g;
  for (const file of walk(SRC)) {
    if (file === TABLE_FILE) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(key)) {
      // 240 chars: comfortably past a `name` line's own indentation and short enough that the next
      // definition cannot reach into it.
      if (!/\bpresent:\s*\{/.test(source.slice(match.index, match.index + 240))) continue;
      // No literal means the factory takes its name as a parameter (`create_plan` / `update_plan`).
      if (match[1]) declared.add(match[1]);
      else for (const name of FACTORY_NAMES) declared.add(name);
    }
  }
  return declared;
}

/** Names in the built-in fallback table (core's classification list). */
function collectTable() {
  const names = new Set();
  for (const [, name] of readFileSync(TABLE_FILE, "utf8").matchAll(/^\s{2}([a-z_]+):\s*\{/gm)) {
    names.add(name);
  }
  return names;
}

const expected = new Set([...collectTable(), ...collectDeclared(), ...DYNAMIC_TABLE_ONLY, ...CONST_NAMED]);
const actual = Object.values(BUILTIN_TOOL_NAMES);

assert.ok(expected.size > 30, `expected set derived (${expected.size} names)`);

const actualSet = new Set(actual);
assert.equal(actualSet.size, actual.length, `BUILTIN_TOOL_NAMES has duplicate values`);

const missing = [...expected].filter((name) => !actualSet.has(name));
const extra = [...actualSet].filter((name) => !expected.has(name));

// Both of the next two compare the SOURCES against the BUILT registry, so a stale `dist` fails them
// while nothing is wrong with the code — and the message reads like a source bug. The runner executes
// these `.mjs` files directly (not the `validate:*` npm scripts, which build first), so that state is
// reachable by simply forgetting one command. Say so in the message rather than leaving the reader to
// work out why a name they can see in `src` is "missing".
const STALE_BUILD_HINT =
  "\n  (this check compares `src/` with the built `dist/dev.mjs` — run `pnpm --filter @codent/core run build` if you have not)";

assert.equal(
  missing.length,
  0,
  `BUILTIN_TOOL_NAMES is missing built-in tools:\n  ${missing.join("\n  ")}${STALE_BUILD_HINT}`
);
assert.equal(
  extra.length,
  0,
  `BUILTIN_TOOL_NAMES lists tools core does not build:\n  ${extra.join("\n  ")}${STALE_BUILD_HINT}`
);

// ============================================================================
// No module writes a built-in name as a literal in an identity position
// ============================================================================
//
// The registry's whole point is that a host can reference a built-in without spelling it, so a rename
// stays a core-only edit. The same must hold inside core: a literal in a comparison, an `includes()` or
// a collection keeps compiling while it silently stops matching — a `new Set(["write_file", …])` no
// longer classifies a renamed tool as a write, and nothing fails. This scan is the guard for the two
// files that had exactly that (`tools/runtime/create-tool-sets.ts`, `compaction/file-ops-tracker.ts`).
//
// Deliberately NOT covered: `case "<name>":` dispatch tables (the presentation renderers), `name: "<x>"`
// definition sites, and prose in prompts. A switch is exhaustive by tool and its `default` degrades, and
// it is the tool's own `present` declaration (guarded by `validate:tool-presentation`) that hosts read.

/** Files whose strings match a built-in name for another reason; each with the reason. */
const NAME_LITERAL_EXEMPT = [
  {
    file: "agent/tools/tool-names.ts",
    why: "the registry itself — the one place a wire name is written down",
  },
  {
    file: "agent/tools/presentation/builtin-table.ts",
    why: "the presentation fallback table, pinned to the definition sites by validate:tool-presentation",
  },
  {
    file: "agent/tools/command-safety/command-analyzer.ts",
    why: "shell command names (`grep`, `rg`, …) that happen to share a spelling with a tool name",
  },
  {
    file: "agent/log/schemas.ts",
    why: "log categories, one of which is named `todo`",
  },
  {
    file: "agent/summary-stream/summary-stream-hub.ts",
    why: "a summary SOURCE (`task` | `compact`), not a tool name",
  },
];

{
  const exempt = new Set(NAME_LITERAL_EXEMPT.map((entry) => entry.file));
  const walkTs = (dir) =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? walkTs(path) : path.endsWith(".ts") ? [path] : [];
    });

  const offenders = [];
  for (const file of walkTs(join(SRC, "agent"))) {
    const rel = file.slice(join(SRC).length);
    if (exempt.has(rel)) continue;
    const source = readFileSync(file, "utf8");
    for (const name of actualSet) {
      const patterns = [
        new RegExp(`(?:===|!==)\\s*"${name}"`),
        new RegExp(`includes\\(\\s*"${name}"`),
        new RegExp(`new Set\\(\\[[^\\]]*"${name}"`),
        new RegExp(`^\\s*"${name}",?$`, "m"),
      ];
      if (patterns.some((pattern) => pattern.test(source))) offenders.push(`${rel}: "${name}"`);
    }
  }

  assert.equal(
    offenders.length,
    0,
    "a built-in name is written as a literal in an identity position — use BUILTIN_TOOL_NAMES, or add " +
      `the file to NAME_LITERAL_EXEMPT with its reason:\n  ${offenders.join("\n  ")}`
  );
  console.log(`validate-builtin-tool-names: ${NAME_LITERAL_EXEMPT.length} exempt files, 0 literal sites`);
}

console.log(`validate-builtin-tool-names: ok — ${actualSet.size} built-in tool names`);
