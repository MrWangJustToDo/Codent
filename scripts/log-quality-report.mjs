/**
 * Log quality report — read one real session's `agent.log` and answer the questions a log is
 * supposed to answer, with numbers instead of impressions.
 *
 * This is NOT a validator and deliberately does not live under `packages/*​/scripts/`: the
 * `validate-*` glob would pick it up, and `run-all-validators` rejects scripts that read the
 * gitignored `.agents/` tree (it passes only on a machine where sessions happen to exist, i.e.
 * never in CI). It reads a real artifact on purpose — the acceptance check for a log change
 * (`tasks.md` 7.3) is "what does a real session look like", which no fixture can substitute.
 *
 * What it measures:
 *
 *   1. volume      — rows / bytes, by level, category and event (top sources of noise)
 *   2. coverage    — the events that must exist in any run (startup, prompt, llm, tool, turn)
 *   3. promise     — the facts that used to be missing: prompt text, approval source, mode
 *                    switch, delegation cost, per-child run scope
 *   4. reconcile   — logged cost vs the session's persisted `cost` (children included)
 *   5. check mode  — `--check` exits non-zero on a regression (mechanical status rows, a
 *                    `(structured)` prompt, missing bootstrap summary, unscoped child rows,
 *                    cost gap > 10%)
 *
 * Usage:
 *   node scripts/log-quality-report.mjs                 # newest session with a log
 *   node scripts/log-quality-report.mjs <sessionId>      # one session
 *   node scripts/log-quality-report.mjs <sessionId> --check
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const LOGS_DIR = path.join(repoRoot, ".agents", "logs");
const SESSIONS_DIR = path.join(repoRoot, ".agents", "sessions");

const args = process.argv.slice(2);
const check = args.includes("--check");
/**
 * Treat "the session's billed cost cannot be read" as a failure.
 *
 * The acceptance run for the log change (tasks.md 7.3) names cost reconciliation as one of its
 * machine-checkable outcomes; without this flag a missing `.session.jsonl` / `state.cost` reported
 * `?` and the check still printed PASS — a false green on the one item it was supposed to prove.
 */
const requireCost = args.includes("--require-cost");
const sessionArg = args.find((arg) => !arg.startsWith("--"));

// ============================================================================
// Discovery
// ============================================================================

function newestSessionWithLog() {
  if (!fs.existsSync(LOGS_DIR)) return null;
  const dirs = fs
    .readdirSync(LOGS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("ses_"))
    .map((entry) => ({
      id: entry.name,
      mtime: fs.statSync(path.join(LOGS_DIR, entry.name, "agent.log")).mtimeMs,
    }))
    .filter((entry) => fs.existsSync(path.join(LOGS_DIR, entry.id, "agent.log")))
    .sort((a, b) => b.mtime - a.mtime);
  return dirs[0]?.id ?? null;
}

const sessionId = sessionArg ?? newestSessionWithLog();
if (!sessionId) {
  console.error("no session log found under .agents/logs — run a session first");
  process.exit(2);
}

const logDir = path.join(LOGS_DIR, sessionId);
const rootLog = path.join(logDir, "agent.log");
if (!fs.existsSync(rootLog)) {
  console.error(`no agent.log for session ${sessionId}`);
  process.exit(2);
}

// ============================================================================
// Parsing
// ============================================================================

/** @returns {{entries: any[], bytes: number, badLines: number}} */
function readLog(file) {
  const text = fs.readFileSync(file, "utf8");
  const entries = [];
  let badLines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      badLines += 1;
    }
  }
  return { entries, bytes: Buffer.byteLength(text), badLines };
}

const root = readLog(rootLog);
const childLogs = fs
  .readdirSync(logDir)
  .filter((name) => name.startsWith("subagent_") && name.endsWith(".log"))
  .map((name) => ({ name, ...readLog(path.join(logDir, name)) }));

const fmtInt = (n) => n.toLocaleString("en-US");
const pct = (part, whole) => (whole === 0 ? "0.0%" : `${((part / whole) * 100).toFixed(1)}%`);
const top = (counter, n = 10) => [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

const byEvent = new Map();
const byCategory = new Map();
const byLevel = new Map();
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

for (const entry of root.entries) {
  bump(byEvent, entry.event ?? "(direct)");
  bump(byCategory, entry.category ?? "?");
  bump(byLevel, entry.level ?? "?");
}
const total = root.entries.length;

// ============================================================================
// Signals
// ============================================================================

const countEvent = (type, entries = root.entries) => entries.filter((entry) => entry.event === type).length;

/** Rows a reader would call machinery: status bookkeeping, auto approvals, empty thinking. */
function noiseRows() {
  const status = root.entries.filter(
    (entry) => entry.event === "agent:status" && typeof entry.data?.trigger === "string"
  );
  const autoApprovals = root.entries.filter(
    (entry) =>
      (entry.event === "agent:tool-approval-request" && entry.data?.auto === true) ||
      (entry.event === "agent:tool-approval-resolved" && entry.data?.source === "auto")
  );
  const emptyThinking = root.entries.filter(
    (entry) => entry.event === "agent:thinking" && entry.data?.iteration == null
  );
  const structuredPrompt = root.entries.filter(
    (entry) => entry.event === "prompt:submit" && /\((?:structured)\)/.test(entry.message ?? "")
  );
  // A pre-change build wrote status transitions straight to the seam: no `event`, message
  // `Status: a → b`. Counting them separately is how the report stays useful on an old artifact.
  const legacyStatus = root.entries.filter((entry) => !entry.event && /^Status: /.test(entry.message ?? ""));
  return { status, autoApprovals, emptyThinking, structuredPrompt, legacyStatus };
}

/**
 * Child rows that cannot be sliced by run (the reason `run` moved onto the envelope).
 *
 * `subagent:created` / `subagent:started` are emitted before the child's run exists, so they are
 * legitimately unscoped. Everything else in a child log belongs to that run.
 */
const CHILD_PRE_RUN_EVENTS = new Set(["subagent:created", "subagent:started"]);
function unscopedChildRows() {
  let rows = 0;
  for (const child of childLogs) {
    for (const entry of child.entries) {
      if (!entry.event || CHILD_PRE_RUN_EVENTS.has(entry.event)) continue;
      if (!entry.run) rows += 1;
    }
  }
  return rows;
}

/**
 * What the log says was spent: every root model call, plus each delegated run's own total.
 *
 * A worker runs its whole loop in one `chat()`, so its `llm:response` row reports the LAST
 * iteration's cost only — summing those would undercount. `subagent:completed.costUsd` is the
 * run's total (and is what makes this number comparable to the session's billed cost).
 */
function loggedCost() {
  let cost = 0;
  for (const entry of root.entries) {
    if (entry.event === "llm:response") cost += entry.data?.costUsd ?? 0;
    if (entry.event === "subagent:completed") cost += entry.data?.costUsd ?? 0;
  }
  for (const child of childLogs) {
    for (const entry of child.entries) {
      if (entry.event === "subagent:completed") cost += entry.data?.costUsd ?? 0;
    }
  }
  return cost;
}

/** The persisted billed cost. State is attached to message lines, not a `t: "state"` record. */
function sessionCost() {
  const file = path.join(SESSIONS_DIR, `${sessionId}.session.jsonl`);
  if (!fs.existsSync(file)) return { value: null, reason: "no session file" };
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const record = JSON.parse(lines[i]);
      if (typeof record.state?.cost === "number") return { value: record.state.cost, reason: null };
    } catch {
      // keep scanning: a truncated tail should not hide the previous state line
    }
  }
  return { value: null, reason: "session has no state.cost" };
}

const noise = noiseRows();
const cost = loggedCost();
const billedState = sessionCost();
const billed = billedState.value;
const costGap = billed && billed > 0 ? Math.abs(billed - cost) / billed : null;

// ============================================================================
// Report
// ============================================================================

console.log(`\nsession  ${sessionId}`);
console.log(`log      ${rootLog}`);
console.log(
  `volume   ${fmtInt(total)} rows, ${(root.bytes / 1e6).toFixed(2)} MB` +
    (root.badLines ? `  ⚠ ${root.badLines} unparsable line(s)` : "")
);

console.log("\n-- levels ------------------------------------------------");
for (const [level, n] of top(byLevel, 5))
  console.log(`${String(n).padStart(7)}  ${pct(n, total).padStart(6)}  ${level}`);

console.log("\n-- categories --------------------------------------------");
for (const [category, n] of top(byCategory, 12)) {
  console.log(`${String(n).padStart(7)}  ${pct(n, total).padStart(6)}  ${category}`);
}

console.log("\n-- events (top 18) ---------------------------------------");
for (const [event, n] of top(byEvent, 18))
  console.log(`${String(n).padStart(7)}  ${pct(n, total).padStart(6)}  ${event}`);

console.log("\n-- coverage ----------------------------------------------");
const REQUIRED = [
  ["session:start", "bootstrap reached the log"],
  ["session:doc", "project instructions"],
  ["session:skill", "skill index"],
  ["session:memory", "memory init"],
  ["prompt:submit", "user prompt"],
  ["llm:request", "model call out"],
  ["llm:response", "model call in (tokens/cost)"],
  ["agent:tool-start", "tool call"],
  ["agent:tool-end", "tool result"],
  ["turn:summary", "per-turn outcome/cost"],
];
for (const [event, why] of REQUIRED) {
  const n = countEvent(event);
  console.log(`${n > 0 ? "  ok  " : " MISS "}  ${event.padEnd(24)} ${String(n).padStart(5)}  ${why}`);
}
for (const [event, why] of [
  ["session:bootstrap-summary", "single bootstrap row"],
  ["extension:log", "extension output on the bus"],
  ["mode:change", "auto/effort switch"],
  ["compaction:auto-start", "context compaction"],
  ["subagent:completed", "delegated run"],
  ["agent:client-tool-result", "client tool answer (ask_user)"],
  ["job:changed", "background job transition"],
  ["session:deleted", "session deletion"],
]) {
  const n = countEvent(event);
  if (n > 0) console.log(`  ok    ${event.padEnd(24)} ${String(n).padStart(5)}  ${why}`);
  else console.log(`  --    ${event.padEnd(24)} ${String(0).padStart(5)}  ${why} (absent this run)`);
}

console.log("\n-- promise (facts that used to be missing) ----------------");
console.log(
  `  prompt text          ${noise.structuredPrompt.length === 0 ? "ok — no '(structured)' placeholder" : `FAIL — ${noise.structuredPrompt.length} structured placeholder row(s)`}`
);
const approvals = countEvent("agent:tool-approval-resolved");
const autoApprovals = root.entries.filter(
  (entry) => entry.event === "agent:tool-approval-resolved" && entry.data?.source === "auto"
).length;
const userApprovals = root.entries.filter(
  (entry) => entry.event === "agent:tool-approval-resolved" && entry.data?.source === "user"
).length;
const policyApprovals = root.entries.filter(
  (entry) => entry.event === "agent:tool-approval-resolved" && entry.data?.source === "policy"
).length;
const legacyApprovals = approvals - autoApprovals - userApprovals - policyApprovals;
console.log(
  `  approval source      ${approvals} resolution row(s): user ${userApprovals}, policy ${policyApprovals}, auto ${autoApprovals}` +
    (legacyApprovals > 0 ? `, unlabelled ${legacyApprovals} (pre-source build)` : "")
);
console.log(`  mode switch          ${countEvent("mode:change")} row(s)`);
console.log(
  `  child run scope      ${unscopedChildRows() === 0 ? "ok — every child event row carries a run" : `FAIL — ${unscopedChildRows()} unscoped child row(s)`}`
);

console.log("\n-- noise -------------------------------------------------");
console.log(
  `  legacy status rows   ${noise.legacyStatus.length} row(s) ${pct(noise.legacyStatus.length, total)}  (direct seamer writes: pre-change build)`
);
console.log(`  mechanical status    ${noise.status.length} row(s) ${pct(noise.status.length, total)}`);
console.log(`  auto approvals       ${noise.autoApprovals.length} row(s) ${pct(noise.autoApprovals.length, total)}`);
console.log(`  empty thinking       ${noise.emptyThinking.length} row(s) ${pct(noise.emptyThinking.length, total)}`);

console.log("\n-- delegation --------------------------------------------");
if (childLogs.length === 0) {
  console.log("  (no subagent logs in this session)");
} else {
  for (const child of childLogs) {
    const completed = child.entries.find((entry) => entry.event === "subagent:completed");
    const error = child.entries.find((entry) => entry.event === "subagent:error");
    const phase = child.entries.find((entry) => entry.event === "subagent:phase");
    const calls = child.entries.filter((entry) => entry.event === "llm:request").length;
    const label = completed ? "completed" : error ? "error" : "?";
    const usage = completed?.data ?? error?.data ?? {};
    const c = typeof usage.costUsd === "number" ? ` $${usage.costUsd.toFixed(4)}` : "";
    const tokens = usage.totalTokens != null ? ` ${fmtInt(usage.totalTokens)} tok` : "";
    console.log(
      `  ${child.name.replace(/^subagent_|\.log$/g, "")}  ${label}${phase ? ` (${phase.data?.phase})` : ""}` +
        `${calls ? `  ${calls} llm row(s)` : ""}${tokens}${c}`
    );
  }
}

console.log("\n-- cost reconciliation -----------------------------------");
console.log(`  logged (root llm + child costUsd)  $${cost.toFixed(4)}`);
console.log(
  `  session state cost                 ${billed == null ? `? (${billedState.reason})` : `$${billed.toFixed(4)}`}`
);
console.log(`  gap                                ${costGap == null ? "?" : `${(costGap * 100).toFixed(1)}%`}`);

// ============================================================================
// Check mode
// ============================================================================

if (check) {
  const failures = [];
  if (noise.legacyStatus.length > 0)
    failures.push(
      `${noise.legacyStatus.length} legacy status rows — this log came from a pre-change build (restart and re-run)`
    );
  if (noise.status.length > 0) failures.push(`${noise.status.length} mechanical agent:status row(s)`);
  if (noise.autoApprovals.length > 0) failures.push(`${noise.autoApprovals.length} auto-approval row(s)`);
  if (noise.emptyThinking.length > 0) failures.push(`${noise.emptyThinking.length} payload-less agent:thinking row(s)`);
  if (noise.structuredPrompt.length > 0) failures.push(`${noise.structuredPrompt.length} '(structured)' prompt row(s)`);
  if (countEvent("session:start") === 0) failures.push("no session:start row");
  if (countEvent("prompt:submit") === 0) failures.push("no prompt:submit row");
  if (unscopedChildRows() > 0) failures.push(`${unscopedChildRows()} unscoped child row(s)`);
  if (costGap != null && costGap > 0.1) failures.push(`cost gap ${(costGap * 100).toFixed(1)}% > 10%`);

  // "Could not check" is not "checked and fine". Reported explicitly, and promotable to a failure
  // for the acceptance run (`--require-cost`).
  const costSkipped = costGap == null;
  const costSkipReason = billedState.reason ?? "session cost is zero";
  if (costSkipped && requireCost) {
    failures.push(`cost cannot be reconciled (${costSkipReason}) — required by --require-cost`);
  }

  console.log("\n-- check -------------------------------------------------");
  if (costSkipped && !requireCost) {
    console.log(`  SKIP  cost reconciliation — ${costSkipReason} (pass --require-cost to fail instead)`);
  }
  if (failures.length === 0) {
    console.log(
      costSkipped && !requireCost
        ? "  PASS (1 check skipped) — every applicable check holds"
        : "  PASS — this session's log satisfies the timeline contract"
    );
    process.exit(0);
  }
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exit(1);
}

console.log("");
