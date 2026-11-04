/**
 * Control-plane writer gate.
 *
 * The convergence plan replaces several competing mechanisms with one owner each (Epoch, one
 * status transition writer, one session lease). Until those land, this gate freezes the CURRENT set
 * of writers so a new one cannot be added by accident: every match must belong to an allowlisted
 * file, every allowlist entry must still match (no stale exemption), and every entry states which
 * task removes it.
 *
 * It is intentionally a *scatter* gate, not an architecture check: it cannot prove the owners are
 * correct, only that the number of places answering "is this current?" / "what is the status?" does
 * not grow while the migration is in progress.
 *
 * Run:
 *   node scripts/validate-control-plane-writers.mjs            # strict (CI)
 *   node scripts/validate-control-plane-writers.mjs --report   # inventory snapshot
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

/** Remove comments while preserving line numbers (the gate is about code, not prose). */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
}

/**
 * Each pattern is a mechanism that must converge to one owner. `allowed` maps the current
 * owner/legacy file to a reason; `removeBy` names the task that deletes the legacy entries.
 */
const PATTERNS = [
  {
    id: "status-write",
    re: /\bsetStatus\s*\(/,
    owner: "T3 (single transition writer)",
    allowed: new Map([
      ["managers/controllers/agent-status-controller.ts", "the current status owner (becomes transition())"],
      ["managers/controllers/compaction-controller.ts", "compaction restores the status through the controller"],
      ["managers/managed-agent.ts", "ManagedAgent forwards to the controller / session reset"],
      ["managers/managed-agent-run-lifecycle.ts", "run finalization applies the terminal status"],
    ]),
  },
  {
    id: "epoch-guard-session-id",
    re: /\b(sessionIdAtStart|stillOnStartSession|stillOnSession)\b/,
    owner: "E9 (Epoch) — retired; a new match is a regression",
    allowed: new Map(),
  },
  {
    id: "epoch-guard-lifecycle",
    re: /\badvanceLifecycleEpoch\s*\(/,
    owner: "E2/E9 (Epoch source)",
    allowed: new Map([
      ["managers/controllers/agent-chat-controller.ts", "pump lifecycle generation — the Epoch source"],
    ]),
  },
  {
    id: "epoch-guard-staleness",
    re: /\bcaptureSessionStaleness\s*\(/,
    owner: "E8/E9 (Epoch; middleware migration pending)",
    allowed: new Map([
      ["agent/turn-context/session-staleness.ts", "definition — kept until the middlewares migrate"],
      ["managers/middleware/background-middleware.ts", "background delivery guard — migrate with the Epoch wave"],
      ["managers/middleware/turn-context-middleware.ts", "turn-context delivery guard — migrate with the Epoch wave"],
    ]),
  },
  {
    id: "session-generation",
    re: /\badvanceSessionGeneration\s*\(/,
    owner: "S1/S5 (SessionLease)",
    allowed: new Map([
      ["agent/ui/ui-channel.ts", "definition — the UI channel stores the session generation"],
      ["managers/managed-agent.ts", "lease commit port — the only production advance"],
    ]),
  },
  {
    id: "session-switching",
    re: /\bisSessionSwitching\s*\(/,
    owner: "E9 (Epoch)",
    allowed: new Map([
      ["managers/approval-decision-coordinator.ts", "synchronous admission — keeps the predicate"],
      ["managers/controllers/agent-chat-controller.ts", "pump admission — keeps the synchronous predicate"],
      ["managers/managed-agent.ts", "definition — the flag itself"],
      ["managers/run-agent.ts", "background-middleware delivery wiring (synchronous)"],
    ]),
  },
  {
    id: "ownership-write",
    re: /\b(acquire|release)SessionOwnership\s*\(/,
    owner: "S2 (SessionLease)",
    allowed: new Map([
      ["managers/agent-manager.ts", "manager facade (bootstrap claim)"],
      ["managers/managed-agent.ts", "agent facade / lease wiring"],
    ]),
  },
];

const files = sourceFiles();
const matches = new Map(PATTERNS.map((pattern) => [pattern.id, []]));

for (const file of files) {
  const rel = relative(srcRoot, file).split("\\").join("/");
  const lines = stripComments(readFileSync(file, "utf8")).split("\n");
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (pattern.re.test(line)) matches.get(pattern.id).push({ rel, line: index + 1, text: line.trim() });
    }
  });
}

if (process.argv.includes("--report")) {
  for (const pattern of PATTERNS) {
    const rows = matches.get(pattern.id);
    const byFile = new Map();
    for (const row of rows) byFile.set(row.rel, (byFile.get(row.rel) ?? 0) + 1);
    console.log(`\n## ${pattern.id} — owner: ${pattern.owner} — ${rows.length} match(es)`);
    for (const [rel, count] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${count.toString().padStart(3)}  ${rel}`);
    }
  }
  process.exit(0);
}

const problems = [];
for (const pattern of PATTERNS) {
  const offenders = matches.get(pattern.id).filter((row) => !pattern.allowed.has(row.rel));
  for (const row of offenders) {
    problems.push(
      `${pattern.id}: ${row.rel}:${row.line} — ${row.text}\n` +
        `    this mechanism is being converged to one owner (${pattern.owner}); ` +
        `use that owner or add a reasoned allowlist entry in validate-control-plane-writers.mjs`
    );
  }
  // A stale exemption means the migration advanced; remove the entry so the gate stays honest.
  for (const [rel, reason] of pattern.allowed) {
    const stillUsed = matches.get(pattern.id).some((row) => row.rel === rel);
    if (!stillUsed) {
      problems.push(
        `${pattern.id}: stale allowlist entry for ${rel} — no match remains. Delete it.` +
          (reason ? ` (was: ${reason})` : "")
      );
    }
  }
}

assert.deepEqual(problems, [], `control-plane writers drifted:\n\n${problems.join("\n\n")}`);

const total = [...matches.values()].reduce((sum, rows) => sum + rows.length, 0);
console.log(`control-plane writers: ${total} tracked site(s), no new scatter`);
