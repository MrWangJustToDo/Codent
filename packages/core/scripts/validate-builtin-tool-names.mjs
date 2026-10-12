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

/** Every tool name that declares `present` at its definition site. */
function collectDeclared() {
  const declared = new Set();
  const re = /\bname(?::\s*"([a-z_]+)"|),\s*\n\s*present:\s*\{/g;
  for (const file of walk(SRC)) {
    if (file === TABLE_FILE) continue;
    for (const [, literalName] of readFileSync(file, "utf8").matchAll(re)) {
      if (literalName) declared.add(literalName);
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

assert.equal(missing.length, 0, `BUILTIN_TOOL_NAMES is missing built-in tools:\n  ${missing.join("\n  ")}`);
assert.equal(extra.length, 0, `BUILTIN_TOOL_NAMES lists tools core does not build:\n  ${extra.join("\n  ")}`);

console.log(`validate-builtin-tool-names: ok — ${actualSet.size} built-in tool names`);
