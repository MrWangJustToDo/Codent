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
 *   4. reconcile   — pump cost (`turn:summary`) vs the session's persisted `cost`. A pump summary
 *                    already includes its root calls, the delegated run's total and in-pump side
 *                    queries; the residual is post-run side-query spend, which the log does not
 *                    carry on purpose (`memory:*` start/complete rows are silent). The usage store
 *                    is read only as an upper bound that can explain that residual.
 *   5. check mode  — `--check` exits non-zero on a regression (mechanical status rows, a
 *                    `(structured)` prompt, missing bootstrap summary, unscoped child rows,
 *                    an UNEXPLAINED cost gap > 10%)
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
const USAGE_DIR = path.join(repoRoot, ".agents", "usage");

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
  const file = path.join(LOGS_DIR, "agent.log");
  if (!fs.existsSync(file)) return null;
  // The timeline is workspace-wide; the session a report defaults to is the newest row's owner.
  const entries = readLog(file).entries;
  return entries.filter((entry) => entry.sessionId).at(-1)?.sessionId ?? null;
}

const sessionId = sessionArg ?? newestSessionWithLog();
if (!sessionId) {
  console.error("no session rows found in .agents/logs/agent.log — run a session first");
  process.exit(2);
}

const rootLog = path.join(LOGS_DIR, "agent.log");
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

const allEntries = readLog(rootLog);
const sessionEntries = allEntries.entries.filter((entry) => entry.sessionId === sessionId);
const root = {
  ...allEntries,
  entries: sessionEntries.filter((entry) => !entry.scope || entry.scope.profile === "root"),
  // Byte size must describe the SAME rows as the row count (the file also holds other sessions
  // and unattributed bootstrap rows).
  bytes: sessionEntries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0),
};
const unattributedRows = allEntries.entries.filter((entry) => !entry.sessionId).length;

// Child rows share the workspace file; a child is identified by its agent id (falling back to
// profile + task call for rows written before the agentId field existed).
const childGroups = new Map();
for (const entry of sessionEntries) {
  if (!entry.scope || entry.scope.profile === "root") continue;
  const key = entry.scope.agentId ?? `${entry.scope.profile}:${entry.scope.taskCallId ?? "internal"}`;
  if (!childGroups.has(key)) childGroups.set(key, []);
  childGroups.get(key).push(entry);
}
const childLogs = [...childGroups].map(([name, entries]) => ({ name, entries, bytes: 0, badLines: 0 }));

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
  // Keep in sync with `MECHANICAL_STATE_EVENTS` in
  // packages/core/src/agent/log/event-log-specialized.ts. The handler REFUSES to write a row for
  // these, so a current-build log has none; a row here is the regression this check exists for.
  // Counting every `data.event` row instead would flag the transitions the policy deliberately
  // keeps (error / aborted / ask_user pause), turning a healthy session with one failure into
  // `preChangeBuild` and a false `--check` failure.
  const MECHANICAL_STATE_EVENTS = new Set([
    "prepare",
    "stream-chunk",
    "settle",
    "reset",
    "compaction-start",
    "compaction-end",
    "teardown",
  ]);
  const status = root.entries.filter(
    (entry) =>
      entry.event === "agent:status" &&
      typeof entry.data?.event === "string" &&
      MECHANICAL_STATE_EVENTS.has(entry.data.event)
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
 * legitimately unscoped — and so is the construction preface before the child's FIRST run: the
 * `[model] Setting model info` diagnostic happens before there is a run to name. A row emitted
 * AFTER that first run must carry one; that is the property this check protects.
 */
const CHILD_PRE_RUN_EVENTS = new Set(["subagent:created", "subagent:started"]);
function unscopedChildRows() {
  let rows = 0;
  for (const child of childLogs) {
    const firstRunAt = child.entries.findIndex((entry) => entry.run);
    let lastRunAt = -1;
    for (let i = child.entries.length - 1; i >= 0; i -= 1) {
      if (child.entries[i].run) {
        lastRunAt = i;
        break;
      }
    }
    child.entries.forEach((entry, index) => {
      if (!entry.event || CHILD_PRE_RUN_EVENTS.has(entry.event)) return;
      if (entry.run) return;
      if (firstRunAt === -1) {
        rows += 1;
        return;
      }
      // Outside the run window there is nothing to scope to: the construction preface (model info)
      // and the teardown epilogue (`subagent:destroyed`) have no run. A gap INSIDE the window is the
      // defect this check is for.
      if (index > firstRunAt && index < lastRunAt) rows += 1;
    });
  }
  return rows;
}

/**
 * What the log can attribute: one `turn:summary` per pump.
 *
 * `llm:response` cannot be used — it reports the LAST iteration of a multi-iteration `chat()`, so a
 * root turn that ran two iterations looked far cheaper than it was. A pump summary already
 * aggregates everything the session tracker accrued during it: the root calls, a delegated run's
 * total, and in-pump side queries. The remaining spend is post-run side queries (memory
 * extraction/consolidation), whose start/complete rows are silent by policy; that is the residual
 * the report explains separately rather than a missing row.
 */
function loggedCost() {
  let cost = 0;
  let pumps = 0;
  for (const entry of root.entries) {
    if (entry.event !== "turn:summary") continue;
    const value = entry.data?.costUsd;
    if (typeof value !== "number") continue;
    cost += value;
    pumps += 1;
  }
  return { value: cost, pumps };
}

/** The persisted billed cost. State is attached to message lines, not a `t: "state"` record. */
function sessionCost() {
  const file = path.join(SESSIONS_DIR, `${sessionId}.session.jsonl`);
  if (!fs.existsSync(file)) return { value: null, reason: "no session file" };
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const record = JSON.parse(lines[i]);
      if (typeof record.state?.cost === "number") {
        return { value: record.state.cost, reason: null, state: record.state };
      }
    } catch {
      // keep scanning: a truncated tail should not hide the previous state line
    }
  }
  return { value: null, reason: "session has no state.cost", state: null };
}

/**
 * Side-query spend inside the session's time window, as an UPPER BOUND.
 *
 * The usage store records side queries under the shared `agentId: "side-query"`, so rows from a
 * concurrent session can fall in the same window. This number is therefore only used to decide
 * whether the post-pump residual is *explainable*, never as the exact cost of this session.
 */
function sideQueryCostInWindow(state) {
  if (!state || typeof state.createdAt !== "number") return { value: 0, rows: 0 };
  const from = state.createdAt;
  const to = typeof state.updatedAt === "number" ? state.updatedAt : Date.now();
  const file = path.join(USAGE_DIR, `usage-${new Date(from).getFullYear()}.jsonl`);
  if (!fs.existsSync(file)) return { value: 0, rows: 0 };
  let value = 0;
  let rows = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.agentId !== "side-query") continue;
    if (typeof record.ts !== "number" || record.ts < from || record.ts > to) continue;
    value += typeof record.costUsd === "number" ? record.costUsd : 0;
    rows += 1;
  }
  return { value, rows };
}

const noise = noiseRows();
const pump = loggedCost();
const cost = pump.value;
const billedState = sessionCost();
const billed = billedState.value;
const sideQueries = sideQueryCostInWindow(billedState.state);
// Positive = the log accounts for less than was billed. Negative means the log over-counted.
// A log that already violates the timeline contract (direct-seamer status rows, or the mechanical
// pump transitions the current policy suppresses) cannot be priced against today's semantics: its
// `turn:summary` deltas were produced by a different finalizer. Report the contract failure and
// skip cost instead of printing a misleading "unexplained gap" on top of it.
const preChangeBuild = noise.legacyStatus.length > 0 || noise.status.length > 0;
// A log written before the diagnostic events existed has none of them — that is "could not check",
// not "checked and fine", and not a failure of a healthy session. Presence of ANY of the three
// means the build that wrote it can emit them, so an empty one is a real gap.
const diagnosticEvents = ["tool:phase", "context:inject", "session:persist"];
const diagnosticsUnavailable = diagnosticEvents.every((event) => countEvent(event) === 0);
// "Could not check" is not "checked and fine": a build that predates the diagnostic events writes
// none of them, and a failed check there would blame a healthy session for an old log.
const diagnosticsSkipReason = preChangeBuild
  ? "pre-change build"
  : diagnosticsUnavailable
    ? "this log has no tool:phase / context:inject / session:persist rows (pre-diagnostics build)"
    : null;
const residual = billed != null && billed > 0 ? billed - cost : null;
const unexplained = residual != null && residual > 0 ? Math.max(0, residual - Math.max(0, sideQueries.value)) : 0;
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
if (unattributedRows > 0) {
  console.log(`         ${fmtInt(unattributedRows)} row(s) without a sessionId (bootstrap/construction)`);
}

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
  ["tool:phase", "tool-phase decision set"],
  ["tool:resume", "held sibling resumed after approval"],
  ["tool:settle", "engine could not run a call"],
  ["context:inject", "synthetic context admitted"],
  ["session:persist", "transcript write decision"],
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

// The log sink summarizes every object/array payload into `<key>Bytes` + `<key>Preview`, so the
// persisted row carries SCALAR counts, never the arrays themselves. Reading `data.held` here made
// every counter print 0 while the rows were present — a metric that read as "nothing happened".
const scalar = (value) => (typeof value === "number" ? value : 0);

console.log("\n-- decisions (engine diagnostics) ------------------------");
{
  const phases = root.entries.filter((entry) => entry.event === "tool:phase");
  const held = phases.reduce((n, entry) => n + scalar(entry.data?.heldCount), 0);
  const approvals = phases.reduce((n, entry) => n + scalar(entry.data?.needsApprovalCount), 0);
  const resumed = root.entries.filter((entry) => entry.event === "tool:resume");
  const resumedCalls = resumed.reduce((n, entry) => n + scalar(entry.data?.count), 0);
  const settled = root.entries.filter((entry) => entry.event === "tool:settle");
  const settledCalls = settled.reduce((n, entry) => n + scalar(entry.data?.count), 0);
  console.log(`  tool phases          ${phases.length} row(s), ${held} held, ${approvals} awaiting approval`);
  console.log(`  resumed after gate   ${resumed.length} row(s), ${resumedCalls} call(s)`);
  console.log(`  settled unrun        ${settled.length} row(s), ${settledCalls} call(s)`);
  const ctx = root.entries.filter((entry) => entry.event === "context:inject");
  const ctxSources = new Map();
  for (const entry of ctx) {
    const source = typeof entry.data?.source === "string" ? entry.data.source : "?";
    ctxSources.set(source, (ctxSources.get(source) ?? 0) + 1);
  }
  const ctxBreakdown = ctxSources.size > 0 ? ` (${[...ctxSources].map(([k, v]) => `${k} ${v}`).join(", ")})` : "";
  console.log(`  context inject       ${ctx.length} row(s)${ctxBreakdown}`);
  const persist = root.entries.filter((entry) => entry.event === "session:persist");
  const written = persist.filter((entry) => entry.data?.written === true).length;
  const skipped = persist.filter((entry) => entry.data?.skipped === true).length;
  const refused = persist.length - written - skipped;
  console.log(
    `  session persist      ${persist.length} row(s): written ${written}, skipped ${skipped}, not written ${refused}`
  );
}

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
if (preChangeBuild) {
  console.log("  skipped — this log predates the current timeline contract (mechanical status rows)");
  console.log("            cost is not comparable; restart the app and record a session with this build");
} else {
  console.log(`  pumps (turn:summary)               $${cost.toFixed(4)}${pump.pumps ? `  (${pump.pumps})` : ""}`);
  console.log(
    `  session state cost                 ${billed == null ? `? (${billedState.reason})` : `$${billed.toFixed(4)}`}`
  );
  console.log(
    `  residual (outside pumps)            ${
      residual == null ? "?" : `${((residual / billed) * 100).toFixed(1)}% ($${residual.toFixed(4)})`
    }`
  );
  console.log(
    `  side-query spend in window          $${sideQueries.value.toFixed(4)}` +
      (sideQueries.rows ? `  (${sideQueries.rows} call(s); upper bound)` : "")
  );
  console.log(`  unexplained                         $${unexplained.toFixed(4)}`);
}

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
  if (diagnosticsSkipReason == null && countEvent("agent:tool-start") > 0 && countEvent("tool:phase") === 0) {
    failures.push("no tool:phase rows — the tool phase's held/approval decision set is invisible");
  }
  if (diagnosticsSkipReason == null && countEvent("prompt:submit") > 0 && countEvent("session:persist") === 0) {
    failures.push("no session:persist rows — transcript durability is invisible");
  }
  if (unscopedChildRows() > 0) failures.push(`${unscopedChildRows()} unscoped child row(s)`);
  if (!preChangeBuild && billed != null && billed > 0) {
    if (pump.pumps === 0) {
      failures.push("no turn:summary cost row — no pump can be priced");
    } else if (cost > billed * 1.02) {
      failures.push(`pump cost $${cost.toFixed(4)} exceeds billed $${billed.toFixed(4)} — double counting`);
    } else if (unexplained / billed > 0.1) {
      failures.push(
        `unexplained cost gap $${unexplained.toFixed(4)} (${((unexplained / billed) * 100).toFixed(1)}%) > 10%`
      );
    }
  }

  // "Could not check" is not "checked and fine". Reported explicitly, and promotable to a failure
  // for the acceptance run (`--require-cost`).
  const costSkipped = costGap == null || preChangeBuild;
  const costSkipReason = preChangeBuild
    ? "pre-change build: turn:summary rows are not comparable"
    : (billedState.reason ?? "session cost is zero");
  if (costSkipped && requireCost) {
    failures.push(`cost cannot be reconciled (${costSkipReason}) — required by --require-cost`);
  }

  console.log("\n-- check -------------------------------------------------");
  if (diagnosticsSkipReason != null) {
    console.log(`  SKIP  engine diagnostics — ${diagnosticsSkipReason}; restart and record a session`);
  }
  if (costSkipped && !requireCost) {
    console.log(`  SKIP  cost reconciliation — ${costSkipReason} (pass --require-cost to fail instead)`);
  }
  if (failures.length === 0) {
    const skipped = [diagnosticsSkipReason != null, costSkipped && !requireCost].filter(Boolean).length;
    console.log(
      skipped === 0
        ? "  PASS — this session's log satisfies the timeline contract"
        : `  PASS (${skipped} check${skipped === 1 ? "" : "s"} skipped) — every applicable check holds`
    );
    process.exit(0);
  }
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  process.exit(1);
}

console.log("");
