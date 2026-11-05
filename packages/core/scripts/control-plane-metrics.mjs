/**
 * Control-plane convergence metrics.
 *
 * The migration is judged by a handful of numbers (writers, guard mechanisms, trigger count,
 * ManagedAgent size, host surface). This script reports them from source, so a PR can attach the
 * delta instead of arguing from memory. It is descriptive: thresholds belong to the rollout task
 * (`R2`), not here.
 *
 * Run:
 *   node scripts/control-plane-metrics.mjs            # JSON (CI artifact)
 *   node scripts/control-plane-metrics.mjs --markdown # markdown table
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "../src");
const scriptsRoot = here;

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

function walk(dir, filter, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

const sourceFiles = walk(srcRoot, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
const sources = sourceFiles.map((file) => ({
  rel: relative(srcRoot, file).split("\\").join("/"),
  text: readFileSync(file, "utf8"),
}));

const count = (re) => sources.reduce((sum, { text }) => sum + (text.match(re)?.length ?? 0), 0);

/** Quoted members of a `export type X = "a" | "b"` union (keyed strings only). */
function unionMembers(name) {
  const entry = sources.find(({ rel }) => rel === "runtime-types/agent-status.ts");
  if (!entry) return [];
  const match = entry.text.match(new RegExp(`export type ${name}\\s*=([\\s\\S]*?);`));
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Distinct `{ type: "..." }` discriminants in the state event union. */
function transitionEventCount() {
  const entry = sources.find(({ rel }) => rel === "runtime-types/agent-state.ts");
  if (!entry) return 0;
  return new Set([...entry.text.matchAll(/type:\s*"([^"]+)"/g)].map((m) => m[1])).size;
}

function nonBlankLines(text) {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

const managedAgent = sources.find(({ rel }) => rel === "managers/managed-agent.ts");
const sessionRuntimeSource = sources.find(({ rel }) => rel === "runtime-types/session-runtime.ts");
if (!managedAgent || !sessionRuntimeSource) {
  console.error(
    `control-plane-metrics: missing ${!managedAgent ? "managers/managed-agent.ts" : "runtime-types/session-runtime.ts"}; ` +
      "update the path rather than reporting a silent 0."
  );
  process.exit(1);
}
const managedAgentMethods = managedAgent.text
  .split("\n")
  .filter(
    (line) => /^ {2}(?:async )?[A-Za-z][A-Za-z0-9_]*[<(]/.test(line) && !/^ {2}(?:private|protected)\b/.test(line)
  ).length;

const sessionPortBlocks = [
  ...sessionRuntimeSource.text.matchAll(/export interface (Session\w+Port)\s*\{([\s\S]*?)\n\}/g),
];
const sessionPortMembers = sessionPortBlocks.map(
  (match) => match[2].split("\n").filter((line) => /^ {2}[A-Za-z][A-Za-z0-9_]*\??[:(]/.test(line)).length
);

const validators = walk(scriptsRoot, (name) => name.startsWith("validate-") && name.endsWith(".mjs"));
const CONTROL_PLANE_RE =
  /(status|lifecycle|session|approval|mode|compaction|run|switch|state|state|agent-log-binding|event|timeout|cancel)/i;

const metrics = {
  generatedAt: new Date().toISOString(),
  sourceFiles: sourceFiles.length,
  nonBlankLines: sources.reduce((sum, { text }) => sum + nonBlankLines(text), 0),
  managedAgent: {
    nonBlankLines: managedAgent ? nonBlankLines(managedAgent.text) : 0,
    publicMethods: managedAgentMethods,
  },
  status: {
    values: unionMembers("AgentStatus").length,
    triggers: unionMembers("AgentStatusTrigger").length,
    transitionEvents: transitionEventCount(),
    writers: count(/\bsetStatus\s*\(/g),
    readerFiles: sources.filter(({ text }) => /\bgetStatus\s*\(\)/.test(text)).length,
  },
  currency: {
    sessionIdGuards: count(/\b(sessionIdAtStart|stillOnStartSession|stillOnSession)\b/g),
    lifecycleEpoch: count(/\badvanceLifecycleEpoch\s*\(/g),
    stalenessCapture: count(/\bcaptureSessionStaleness\s*\(/g),
    sessionGeneration: count(/\badvanceSessionGeneration\s*\(/g),
    switchingChecks: count(/\bisSessionSwitching\s*\(/g),
  },
  ownership: {
    writes: count(/\b(acquire|release)SessionOwnership\s*\(/g),
    sessionPorts: sessionPortBlocks.length,
    sessionPortMembers: sessionPortMembers.reduce((sum, n) => sum + n, 0),
    largestSessionPort: sessionPortMembers.length > 0 ? Math.max(...sessionPortMembers) : 0,
  },
  permission: {
    needsApprovalReads: count(/\bneedsApproval\b/g),
    autoApprovalSites: count(/\b(?:autoMode|shouldAutoApprove)\w*\b/g),
  },
  modes: {
    planReads: count(/\bplanMode\./g),
    autoReads: count(/\bisAutoModeEnabled\s*\(/g),
    todosSeeded: count(/\btodosSeeded\b/g),
  },
  validators: {
    total: validators.length,
    controlPlane: validators.filter((file) => CONTROL_PLANE_RE.test(file)).length,
  },
};

if (process.argv.includes("--markdown")) {
  const rows = [
    ["source files", metrics.sourceFiles],
    ["non-blank lines", metrics.nonBlankLines],
    ["ManagedAgent non-blank lines", metrics.managedAgent.nonBlankLines],
    ["ManagedAgent public methods", metrics.managedAgent.publicMethods],
    ["AgentStatus values", metrics.status.values],
    ["AgentStatus triggers", metrics.status.triggers],
    ["transition events", metrics.status.transitionEvents],
    ["setStatus sites", metrics.status.writers],
    ["files reading getStatus()", metrics.status.readerFiles],
    ["session-id guard sites", metrics.currency.sessionIdGuards],
    ["lifecycle-epoch sites", metrics.currency.lifecycleEpoch],
    ["staleness-capture sites", metrics.currency.stalenessCapture],
    ["session-generation sites", metrics.currency.sessionGeneration],
    ["isSessionSwitching sites", metrics.currency.switchingChecks],
    ["ownership writes", metrics.ownership.writes],
    ["session ports", metrics.ownership.sessionPorts],
    ["session port members (total)", metrics.ownership.sessionPortMembers],
    ["largest session port", metrics.ownership.largestSessionPort],
    ["needsApproval reads", metrics.permission.needsApprovalReads],
    ["auto-approval sites", metrics.permission.autoApprovalSites],
    ["planMode reads", metrics.modes.planReads],
    ["isAutoModeEnabled reads", metrics.modes.autoReads],
    ["todosSeeded sites", metrics.modes.todosSeeded],
    ["validators (total)", metrics.validators.total],
    ["validators (control-plane)", metrics.validators.controlPlane],
  ];
  console.log("| metric | value |");
  console.log("|---|---:|");
  for (const [name, value] of rows) console.log(`| ${name} | ${value} |`);
} else {
  console.log(JSON.stringify(metrics, null, 2));
}
