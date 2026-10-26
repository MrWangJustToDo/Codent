/**
 * File-size guard for `packages/core/src`.
 *
 * The design guideline is 400 lines (`.cursor/rules/040`), but four cohesive modules
 * legitimately exceed the 800-line ESLint ceiling or sit just under it. Keep those in the
 * allowlist with a written reason, and fail any new file above the hard ceiling — without a
 * guard, "400 guideline" is just a comment the next module can ignore.
 *
 * Run: pnpm --filter @codent/core run validate:file-size
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const MAX_LINES = 800;

/** Existing over-ceiling files. Every entry must still exceed the ceiling or the guard is stale. */
const ALLOWLIST = new Map([
  [
    "managers/managed-agent.ts",
    "Composes the agent lifecycle, controllers and public facade; split is tracked separately.",
  ],
  ["agent/extension/runner.ts", "Extension registration/lifecycle orchestrator; owns the five registration channels."],
]);

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(absolute)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(absolute);
  }
  return out;
}

const files = await collect(SRC);
const over = [];
const seen = new Set();
for (const file of files) {
  const relative = file.slice(SRC.length + 1).replaceAll("\\", "/");
  const source = await readFile(file, "utf8");
  const lines = source.split("\n").length;
  if (lines > MAX_LINES) {
    over.push({ relative, lines, reason: ALLOWLIST.get(relative) });
    if (ALLOWLIST.has(relative)) seen.add(relative);
  }
}

const unexpected = over.filter((entry) => entry.reason === undefined);
assert.deepEqual(
  unexpected.map((entry) => `${entry.relative}:${entry.lines}`),
  [],
  `files over ${MAX_LINES} lines must be added to ALLOWLIST with a reason`
);

const stale = [...ALLOWLIST.keys()].filter((file) => !seen.has(file));
assert.deepEqual(stale, [], "ALLOWLIST entries must still exceed the ceiling; remove the stale entry");

for (const entry of over) console.log(`ok  ${entry.relative} ${entry.lines} lines — allowlisted`);
console.log(`file-size validation passed (${files.length} files, ceiling ${MAX_LINES})`);
