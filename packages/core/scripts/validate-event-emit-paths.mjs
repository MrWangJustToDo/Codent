/**
 * Validates that an agent event is emitted through the right path.
 *
 * Two layers exist by design, and the split is what keeps "who owns this fact" answerable:
 *
 * - **Domain facts** go through the telemetry funnel (`ManagedAgent.emitEvent` →
 *   `emitAgentTelemetry` → `dispatchEvent`). Their envelope fields (agent/parent/session/run) are
 *   resolved once, and the log policy sees them.
 * - **Retained/channel snapshots** (`agent:state`, `session:usage`, `session:todos`, …) are emitted
 *   by the object that owns the state, directly on the scoped bus. A snapshot's owner is its
 *   provider (`bus.retain`), so routing it through a manager would put two writers on one channel.
 *
 * Before this rule, `plan:*` (8 sites), `agent:extension-error` (7) and `extension:log` (1) were
 * direct emits of NON-projection events — the same fact with two possible enqueue paths, which is
 * what made emission look arbitrary. The first two groups now go through the funnel; the one
 * remaining fallback is allowlisted below.
 *
 * It also asserts the other direction of a retained event: every `retained: true` row has a
 * `retain("<type>")` provider, because a retained channel with no provider silently replays nothing.
 *
 * Run: pnpm --filter @codent/core run validate:event-emit-paths
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_EVENT_META } from "../dist/dev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

/**
 * Files allowed to emit a non-projection event directly, with the reason.
 *
 * The extension runner is constructed without a manager in tests and standalone hosts, so it keeps
 * `rawBus.emit` as its floor. Production passes the owning agent's `emitEvent`, so the fallback is
 * cold; keeping it is better than dropping an extension's activation failure on the floor.
 */
const ALLOWLIST = new Map([
  [
    "packages/core/src/agent/extension/runner.ts",
    "Standalone runner: no manager-owned emitter exists, and a dropped extension diagnostic is worse than a direct emit.",
  ],
]);

/** Direct emits on an agent event bus (not the session multicast or DOM emitters). */
const DIRECT_EMIT = /\b(?:this\.)?(?:rawBus|eventBus|bus)\s*\??\.\s*emit\s*\(\s*"([a-z][a-z0-9:-]*)"\s*,/;
const RETAIN = /\bretain\s*\(\s*"([a-z][a-z0-9:-]*)"/;

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
    const src = path.join(packagesDir, pkg.name, "src");
    const root = fs.existsSync(src) ? src : path.join(packagesDir, pkg.name);
    if (!fs.existsSync(root)) continue;
    walk(root, files);
  }
  return files;
}

const violations = [];
const retainedProviders = new Set();

for (const file of packageSources()) {
  const relative = path.relative(repoRoot, file).split(path.sep).join("/");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const allowlisted = ALLOWLIST.has(relative);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    const retain = RETAIN.exec(line);
    if (retain) retainedProviders.add(retain[1]);

    const emit = DIRECT_EMIT.exec(line);
    if (!emit) continue;
    const type = emit[1];
    const meta = AGENT_EVENT_META[type];
    if (!meta) {
      violations.push(`${relative}:${index + 1}  unknown event "${type}"`);
      continue;
    }
    if (meta.retained === true || meta.channel !== undefined) continue;
    if (allowlisted) continue;
    violations.push(`${relative}:${index + 1}  "${type}" is a domain event emitted directly (use emitEvent)`);
  }
}

// A retained channel with no provider replays nothing; the store must exist, not just the row.
for (const [type, meta] of Object.entries(AGENT_EVENT_META)) {
  if (meta.retained !== true) continue;
  if (!retainedProviders.has(type)) violations.push(`retained "${type}" has no retain("…") provider`);
}

if (violations.length > 0) {
  console.error("Event emission-path violations:");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    "\nDomain events go through `emitEvent`; only retained/channel snapshots are emitted by their owner directly." +
      "\nIf a direct emit really is the only option, add the FILE to ALLOWLIST with the reason."
  );
  process.exit(1);
}

console.log(
  `event-emit-paths validation passed (${AGENT_EVENT_META ? Object.keys(AGENT_EVENT_META).length : 0} events, ` +
    `${retainedProviders.size} retained providers, ${ALLOWLIST.size} allowlisted file)`
);
