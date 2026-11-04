/**
 * Mode single-read gate.
 *
 * Plan and auto mode are read through `ModeState` (`agent/mode/mode-state.ts`): the phase, the auto
 * flag, the approval policy and tool availability. The controllers stay the owners, and the mode
 * domain may touch them; everything else — turn context, persistence, status, the runner, the chat
 * controller — must go through the read surface, or the spread of ad-hoc mode reads returns.
 *
 * A stale allowlist entry fails: when the last read in a file is migrated, delete its entry here.
 *
 * Run: node scripts/validate-mode-single-read.mjs
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "../src");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

function sourceFiles(dir = srcRoot, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
}

const READS = [
  {
    id: "plan-controller-read",
    re: /\bplanMode\s*\.\s*(?:getPhase|getState|isRestrictingTools|shouldAutoApproveTools)\s*\(/g,
    why: "read the mode through ModeState; the plan controller is an owner, not a consumer surface",
    allowed: new Map([["agent/mode/mode-state.ts", "the read surface itself"]]),
  },
  {
    id: "auto-controller-read",
    re: /\bautoMode\s*\.\s*isEnabled\s*\(/g,
    why: "auto mode is read from ModeState, not the controller",
    allowed: new Map([["agent/mode/mode-state.ts", "the read surface itself"]]),
  },
  {
    id: "legacy-auto-read",
    re: /\.isAutoModeEnabled\s*\(/g,
    why: "the derived auto flag is ModeState.auto; the legacy helper has no callers",
    allowed: new Map(),
  },
  {
    id: "derived-auto-read",
    re: /\.isAutoEnabled\s*\(/g,
    why: "consumers read ModeState.auto; the coordinator method is only a convenience projection",
    allowed: new Map(),
  },
];

const violations = [];
const stale = [];

for (const read of READS) {
  const seen = new Set();
  for (const file of sourceFiles()) {
    const rel = relative(srcRoot, file).replaceAll("\\", "/");
    const text = stripComments(readFileSync(file, "utf8"));
    const matches = [...text.matchAll(read.re)];
    if (matches.length === 0) continue;
    if (!read.allowed.has(rel)) {
      for (const match of matches) {
        const line = text.slice(0, match.index).split("\n").length;
        violations.push(`${rel}:${line} — ${read.id} (${read.why})`);
      }
    } else {
      seen.add(rel);
    }
  }
  for (const [rel, reason] of read.allowed) {
    if (!seen.has(rel))
      stale.push(`${read.id}: stale allowlist entry for ${rel} — no match remains. Delete it. (was: ${reason})`);
  }
}

assert.deepEqual(violations, []);
assert.deepEqual(stale, []);

console.log("mode single-read validation passed");
