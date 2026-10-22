/**
 * Validation: tool presentation descriptors live with their tools.
 *
 * Run: pnpm --filter @codent/core run validate:tool-presentation
 *
 * `packages/core/src/agent/tools/presentation/builtin.ts` keeps a fallback copy
 * of the built-in presentation (a remote host that renders before the snapshot catalog
 * lands, unit tests, third-party tools reusing a built-in name). This script makes sure
 * that copy cannot drift away from the real declarations:
 *
 *   1. every built-in tool declares `present` at its definition site (`defineServerTool`
 *      / `defineClientTool` / the plan authoring factory)
 *   2. the declared values equal the fallback table entry for that name
 *   3. names that are assembled at runtime are listed in DYNAMIC_TABLE_ONLY and the
 *      list must stay accurate — a stale entry is an error
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const TABLE_FILE = join(SRC, "agent/tools/presentation/builtin.ts");

/**
 * Names assembled at runtime rather than written as a `name:` literal (the lazy-tool
 * discovery surface and the code-mode entry point), so the fallback table **is** their
 * declaration. If one of them ever gets a literal definition site it must be removed
 * from this set — the check below enforces that.
 */
const DYNAMIC_TABLE_ONLY = new Set(["discover_tools", "execute_typescript"]);

/** The plan authoring factory takes its name as a parameter, so both names share one declaration. */
const FACTORY_NAMES = ["create_plan", "update_plan"];

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** Parse `name: "x", present: { ... }` (or `name, present: { ... }`) from the sources. */
function collectDeclarations() {
  const declared = new Map();
  for (const file of walk(SRC)) {
    if (file === TABLE_FILE) continue;
    const src = readFileSync(file, "utf8");
    const re = /\bname(?::\s*"([a-z_]+)"|),\s*\n\s*present:\s*\{([^}]*)\}/g;
    for (const [, literalName, body] of src.matchAll(re)) {
      const entry = parseEntries(body);
      const names = literalName ? [literalName] : FACTORY_NAMES;
      for (const name of names) declared.set(name, { ...entry, file });
    }
  }
  return declared;
}

function parseEntries(body) {
  const entry = {};
  for (const [, key, value] of body.matchAll(/(\w+):\s*("([a-z]+)"|true|false)/g)) {
    entry[key] = value.startsWith('"') ? value.replaceAll('"', "") : value === "true";
  }
  return entry;
}

/** Parse the fallback table from its source (it is not part of the public API). */
function collectTable() {
  const src = readFileSync(TABLE_FILE, "utf8");
  const table = new Map();
  for (const [, name, body] of src.matchAll(/^\s{2}([a-z_]+):\s*\{([^}]*)\},$/gm)) {
    table.set(name, parseEntries(body));
  }
  return table;
}

const table = collectTable();
const declared = collectDeclarations();
assert.ok(table.size > 20, `fallback table parsed (${table.size} entries)`);

const problems = [];
for (const [name, expected] of table) {
  const actual = declared.get(name);
  if (!actual) {
    if (!DYNAMIC_TABLE_ONLY.has(name)) problems.push(`${name}: no \`present\` declaration found`);
    continue;
  }
  if (DYNAMIC_TABLE_ONLY.has(name)) {
    problems.push(`${name}: declared in ${actual.file}, remove it from DYNAMIC_TABLE_ONLY`);
  }
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (key === "file") continue;
    if (expected[key] !== actual[key]) {
      problems.push(`${name}.${key}: declared ${actual[key]}, fallback table says ${expected[key]}`);
    }
  }
}

assert.equal(problems.length, 0, `presentation drift:\n  ${problems.join("\n  ")}`);
console.log(
  `validate-tool-presentation: ok — ${table.size - DYNAMIC_TABLE_ONLY.size} declared at definition sites, ` +
    `${DYNAMIC_TABLE_ONLY.size} dynamic (table-owned)`
);
