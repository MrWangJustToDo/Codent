/**
 * Guards the log convergence: no module may write an `AgentLog` directly.
 *
 * The change that introduced this rule turned 61 hand-written `log.*` call sites into bus events plus
 * one policy table (`agent/log/event-log-rules.ts`), so "what gets recorded" became one decision
 * instead of a decision per call site. That property is invisible at compile time — `log.warn(...)`
 * still type-checks in any module that can reach an `AgentLog` — so a single new direct write would
 * silently reopen the old design without failing anything.
 *
 * What counts as a direct write:
 *   - `<x>.getLog().<level>(` / `<x>.getLog?.()?.<level>(`   (the managed-agent accessor)
 *   - `resolveLog(<scope>)?.<level>(`                        (the bus-scope resolver)
 *   - `<x>.log[?].<level>(`                                  (a field holding an AgentLog)
 *   - `log[?].<level>(`                                      (an AgentLog passed as a bare parameter)
 *   - `<x>.eventEntry(` / bare `eventEntry(`                 (the bridge's write path)
 *
 * The allowlist is not "files we did not get to": every entry is a place where a write is the correct
 * shape, with the reason written down. It is a FILE list, not a directory prefix — a directory-wide
 * grant would exempt any new file dropped into it.
 *
 * The scan can only see calls, not data flow: `const sink = agent.getLog(); sink.warn(...)` still
 * passes. That limit is stated, not hidden; the accessor spelling at the call site is what the guard
 * enforces.
 *
 * Run: pnpm --filter @codent/core run validate:no-direct-agent-log
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

/** Files allowed to write an `AgentLog` directly, each with the reason it must. */
const ALLOWLIST = new Map([
  ["packages/core/src/agent/agent-log/agent-log.ts", "The AgentLog seam itself (entry construction)."],
  [
    "packages/core/src/agent/agent-log/lifecycle-guards.ts",
    "The crash/exit path: after an uncaught exception the bus and its listeners cannot be trusted, so the fatal row is written straight to the seam.",
  ],
  [
    "packages/core/src/agent/log/event-log-bridge.ts",
    "The Event→Log bridge: it IS the consumer of the policy table, so it is the one place that writes.",
  ],
  [
    "packages/core/src/agent/log/event-log-specialized.ts",
    "Dedicated handlers for the events whose row shape is not one formatter (multi-row, per-server).",
  ],
  [
    "packages/core/src/agent/log/subagent-log-mirror.ts",
    "Mirrors a child's lifecycle into the PARENT file (indexOnly contract) — the bus event already has a destination (the child's log), so publishing a second event would record the same fact twice.",
  ],
]);

const PATTERNS = [
  // `<x>.getLog()` / `getLog?.()` / `(x.getLog())` — closing parens are allowed between the call and
  // the member, because `(managed.getLog()).warn(` is the same write.
  {
    re: /\bgetLog\s*(?:\?\.)?\s*\(\s*\)\s*\)*\s*(?:\?\.|\.)\s*(debug|info|warn|error)\s*\(/,
    what: "getLog() write",
  },
  // `managed["getLog"]()?.warn(` — computed access is the same accessor.
  {
    re: /\[\s*["']getLog["']\s*\]\s*\(\s*\)\s*\)*\s*(?:\?\.|\.)\s*(debug|info|warn|error)\s*\(/,
    what: "getLog() write (computed access)",
  },
  // The bus-scope resolver: `resolveLog(scopeId)?.warn(`.
  {
    re: /\bresolveLog\s*\([^)]*\)\s*(?:\?\.|\.)\s*(debug|info|warn|error)\s*\(/,
    what: "resolveLog() write",
  },
  { re: /\.log\s*\??\.\s*(debug|info|warn|error)\s*\(/, what: "AgentLog field write" },
  // `log.warn(` / `agentLog.warn(` / any identifier that ENDS in `Log` (`subagentLog?.warn(`).
  // Deliberately `Log` (capital L): `catalog.info(` / `dialog.warn(` are not AgentLog handles.
  {
    re: /\b(?:log|agentLog|[A-Za-z_$][\w$]*Log)\s*\??\.\s*(debug|info|warn|error)\s*\(/,
    what: "AgentLog parameter write",
  },
  // `const { warn } = agent.getLog()` — reading the level methods off the accessor is the same write.
  {
    re: /\{[^}]*\b(?:debug|info|warn|error)\b[^}]*\}\s*=\s*[^;\n]*\bgetLog\b/,
    what: "getLog() destructure",
  },
  { re: /\b(?:log|agentLog|this)\s*\??\.\s*eventEntry\s*\(/, what: "eventEntry write" },
  { re: /(?<![\w$])eventEntry\s*\(/, what: "eventEntry write" },
];

/** Comment-only lines describe the calls that were removed; they are not writes. */
function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/**
 * Every match in `text`, with the line it starts on.
 *
 * Scanned as WHOLE TEXT, not line by line: `\s*` in the patterns then also covers a chain broken
 * across lines (`managed.getLog()` followed by `?.warn(`), which a per-line matcher cannot see. The
 * one shape this still cannot see is data flow (`const sink = managed.getLog(); sink.warn(...)`) —
 * stated in the header, and why the accessor spelling is the enforced form.
 */
function scanSource(text) {
  const lines = text.split("\n");
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const hits = [];
  for (const { re, what } of PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const match of text.matchAll(global)) {
      const line = lineOf(match.index);
      const source = lines[line] ?? "";
      if (isCommentLine(source)) continue;
      hits.push({ line: line + 1, what, source: source.trim() });
    }
  }
  return hits;
}

/** The first violation in one line (self-test entry point). */
function violationFor(line) {
  return scanSource(line)[0];
}

// ----------------------------------------------------------------------------
// Self-test: a guard nobody can prove rejects is the false green this change removes elsewhere.
// These run against the same matcher the scan uses, so a regex edit that loses a spelling fails here.
// ----------------------------------------------------------------------------
const MUST_MATCH = [
  'log.info("system", "x")',
  'this.log?.warn("system", "x")',
  'managed.getLog()?.warn("system", "x")',
  'this.host.getLog?.()?.warn("system", "x")',
  '(managed.getLog()).warn("system", "x")',
  'managed["getLog"]()?.warn("system", "x")',
  'subagentLog?.warn("system", "x")',
  "const { warn, debug } = agent.getLog()",
  'deps.resolveLog(scopeId)?.warn("hooks", "x")',
  'log.eventEntry("info", "system", "e", "m")',
  'eventEntry("info", "system", "e", "m")',
  'agentLog.error("system", "x")',
];
const MUST_MATCH_MULTILINE = [
  'const x = managed.getLog()\n  ?.warn("system", "x");',
  'const x = agent\n  .getLog()\n  .debug("system", "x");',
];
const MUST_NOT_MATCH = [
  'logger.info("x")',
  'ctxLogger.warn("x")',
  "catalog.info(entry)",
  "dialog.warn(message)",
  "const log = createAgentLog()",
  "managed.getLog()",
  '// log.info("system", "x") is removed',
];
for (const line of MUST_MATCH) {
  if (!violationFor(line)) {
    console.error(`guard self-test failed: expected a violation for: ${line}`);
    process.exit(1);
  }
}
for (const text of MUST_MATCH_MULTILINE) {
  if (scanSource(text).length === 0) {
    console.error(`guard self-test failed: expected a cross-line violation for: ${JSON.stringify(text)}`);
    process.exit(1);
  }
}
for (const line of MUST_NOT_MATCH) {
  if (violationFor(line)) {
    console.error(`guard self-test failed: false positive for: ${line}`);
    process.exit(1);
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, out);
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function packageSources() {
  const packagesDir = path.join(repoRoot, "packages");
  const files = [];
  for (const pkg of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    // `src` when the package has one, the package root for WXT-style layouts.
    const src = path.join(packagesDir, pkg.name, "src");
    const root = fs.existsSync(src) ? src : path.join(packagesDir, pkg.name);
    if (!fs.existsSync(root)) continue;
    walk(root, files);
  }
  return files;
}

const violations = [];
for (const file of packageSources()) {
  const relative = path.relative(repoRoot, file).split(path.sep).join("/");
  if (ALLOWLIST.has(relative)) continue;

  // Comments are skipped per match line inside `scanSource`: the rules and docs *describe* the calls
  // that were removed.
  for (const hit of scanSource(fs.readFileSync(file, "utf8"))) {
    violations.push(`${relative}:${hit.line}  ${hit.what}: ${hit.source}`);
  }
}

if (violations.length > 0) {
  console.error("Direct AgentLog writes found — record a bus event instead (see openspec/specs/agent-log-timeline):");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    "\nIf a write really is the right shape here, add the FILE to ALLOWLIST in validate-no-direct-agent-log.mjs with the reason."
  );
  process.exit(1);
}

console.log(`no-direct-agent-log validation passed (${ALLOWLIST.size} allowlisted files, matcher self-tested)`);
