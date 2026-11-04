/**
 * Epoch single-source gate.
 *
 * `Epoch` composes three generations; this guard keeps each generation owned by exactly one
 * module and keeps the retired session-id guards out. It is narrower than
 * `validate-control-plane-writers`: that one freezes the whole writer inventory, this one protects
 * the generation producers the Epoch depends on.
 *
 * Run: node scripts/validate-epoch-single-source.mjs
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

/**
 * `allowed` maps the file that owns the producer to a reason. A retired mechanism uses an empty
 * allowlist: any match is a regression.
 */
const PRODUCERS = [
  {
    id: "lifecycle-generation",
    re: /\badvanceLifecycleEpoch\s*\(/,
    why: "the chat controller owns the pump/session-switch lifecycle generation",
    allowed: new Map([["managers/controllers/agent-chat-controller.ts", "owner + internal call sites"]]),
  },
  {
    id: "session-generation-producer",
    re: /\badvanceSessionGeneration\s*\(/,
    why: "the UI channel owns the transcript generation; only a restore may advance it",
    allowed: new Map([
      ["agent/ui/ui-channel.ts", "owner + clearMessages call"],
      ["managers/managed-agent-session.ts", "restore bumps the generation at adoption (moves to lease.commit)"],
    ]),
  },
  {
    id: "run-token-producer",
    re: /\bbeginRun\s*\(/,
    why: "the run token is minted by the coordinator and by the chat pump that begins a run",
    allowed: new Map([
      ["managers/run-coordinator.ts", "definition"],
      ["managers/controllers/agent-chat-controller.ts", "the pump that begins the run"],
    ]),
  },
  {
    id: "retired-session-id-guard",
    re: /\b(sessionIdAtStart|stillOnStartSession|stillOnSession)\b/,
    why: "replaced by Epoch.isCurrent(); a new match re-introduces a second currency",
    allowed: new Map(),
  },
];

const files = sourceFiles();
const hits = new Map(PRODUCERS.map((rule) => [rule.id, []]));

for (const file of files) {
  const rel = relative(srcRoot, file).split("\\").join("/");
  const lines = stripComments(readFileSync(file, "utf8")).split("\n");
  lines.forEach((line, index) => {
    for (const rule of PRODUCERS) {
      if (rule.re.test(line)) hits.get(rule.id).push({ rel, line: index + 1, text: line.trim() });
    }
  });
}

const problems = [];
for (const rule of PRODUCERS) {
  for (const hit of hits.get(rule.id)) {
    if (!rule.allowed.has(hit.rel)) {
      problems.push(
        `${rule.id}: ${hit.rel}:${hit.line} — ${hit.text}\n    ${rule.why}; ` +
          `use the owning module or add a reasoned allowlist entry in validate-epoch-single-source.mjs`
      );
    }
  }
  for (const [file, reason] of rule.allowed) {
    if (!hits.get(rule.id).some((hit) => hit.rel === file)) {
      problems.push(
        `${rule.id}: stale allowlist entry for ${file} — no match remains.` + (reason ? ` (was: ${reason})` : "")
      );
    }
  }
}

assert.deepEqual(problems, [], `epoch generation sources drifted:\n\n${problems.join("\n\n")}`);

const total = [...hits.values()].reduce((sum, rows) => sum + rows.length, 0);
console.log(`epoch single-source: ${total} producer site(s), ${PRODUCERS.length} rule(s)`);
