/**
 * Runner dependency-bag completeness gate.
 *
 * `buildAgentRunner` assembles every middleware from one {@link AgentRunDeps} bag, and
 * two invariants keep that meaningful. Both are invisible at runtime and both were
 * violated by hand-written code before this gate existed:
 *
 * 1. **Every declared field is read.** The bag is a hand-written object, so a field can
 *    survive after its last reader moves to a live accessor — it did: the accessor
 *    migration left `todoManager` / `extensionRunner` as 0-read snapshots, and nothing
 *    noticed, because no gate read `AgentRunDeps` at all.
 * 2. **No factory argument reaches into `managed` directly.** The bag exists so the
 *    assembly reads one surface; a stray `managed.getX()` re-introduces the second path
 *    that makes the bag look complete when it is not.
 *
 * A third property is *not* checked here because it cannot be seen from one file: whether
 * a captured field may go stale. That is the liveness contract documented on
 * `AgentRunDeps` — the runner is cached, so plain fields must be set-once collaborators
 * and anything rebuildable must be a `getX()` accessor. Capturing a mutable field as a
 * plain value passes this gate and still hands middleware a stale reference; the contract
 * note is the only guard, which is why it is spelled out at the interface.
 *
 * Run: pnpm --filter @codent/core run validate:run-deps-completeness
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(scriptDir, "../src");

const DEPS_FILE = join(srcRoot, "managers/agent-run-deps.ts");
const RUNNER_FILE = join(srcRoot, "managers/run-agent.ts");

const depsSource = readFileSync(DEPS_FILE, "utf8");
const runnerSource = readFileSync(RUNNER_FILE, "utf8");

// ---------------------------------------------------------------------------
// 0. Canary: the probes below must be able to find their own inputs.
//
// A regex that silently stops matching (interface renamed, body moved into a helper)
// would make every assertion below vacuously true — the failure mode this repo has hit
// before, where a check reads as passing because it is looking at nothing.
// ---------------------------------------------------------------------------
{
  const marker = "export interface AgentRunDeps {";
  assert.ok(depsSource.includes(marker), `canary: ${marker} not found in ${DEPS_FILE}`);
  assert.ok(
    runnerSource.includes("export function buildAgentRunner("),
    "canary: buildAgentRunner not found — the body probe below would have no target"
  );
  assert.ok(
    [..."managed?.getEventSessionId()".matchAll(/\bmanaged\s*\??\.([A-Za-z_$][\w$]*)/g)].length === 1,
    "canary: the direct-read probe must also see optional chaining (`managed?.x`)"
  );

  const { fields } = collectFields(depsSource);
  // Deliberately low: the canary's job is to prove the parse found a real interface,
  // not to pin the field count (the bag legitimately grows). A threshold near the
  // current count would make the canary fire — for the wrong reason — whenever the
  // interface shrinks, hiding whether the real assertions still bite.
  assert.ok(
    fields.length >= 5,
    `canary: parsed only ${fields.length} fields from AgentRunDeps; the field regex has drifted`
  );
  console.log(`canary: parsed ${fields.length} declared fields, buildAgentRunner present`);
}

// ---------------------------------------------------------------------------
// 1. Every declared field is read by the assembly
// ---------------------------------------------------------------------------
{
  const { fields } = collectFields(depsSource);
  const body = extractRunnerBody(runnerSource, assert);
  // Fields are read either as `deps.x` or by destructuring them straight off `deps`.
  const destructured = extractDestructuredFieldNames(body);
  const unread = [];

  for (const { name } of fields) {
    // `\b` keeps `config` from matching `configKey`.
    const readAsProperty = new RegExp(`\\bdeps\\.${name}\\b`).test(body);
    if (!readAsProperty && !destructured.has(name)) unread.push(name);
  }

  assert.equal(
    unread.length,
    0,
    `AgentRunDeps declares ${unread.length} field(s) the runner never reads: ${unread.join(", ")}. ` +
      "A declared-but-unread bag field is a snapshot that looks like a dependency; remove it, " +
      "or wire it through — see the liveness contract on AgentRunDeps."
  );

  console.log(`completeness: all ${fields.length} declared fields are read`);
}

// ---------------------------------------------------------------------------
// 2. The assembly reaches into `managed` only for whole-agent handoffs
// ---------------------------------------------------------------------------
{
  const body = extractRunnerBody(runnerSource, assert);
  // Optional chaining is the same violation: `managed?.x` used to be invisible to this scan, which
  // let a direct read sit in the assembly while the gate stayed green.
  const directReads = [...body.matchAll(/\bmanaged\s*\??\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);

  assert.equal(
    directReads.length,
    0,
    `buildAgentRunner reads ${directReads.length} value(s) straight off \`managed\` ` +
      `(${[...new Set(directReads)].join(", ")}), bypassing the deps bag. Route them through ` +
      "AgentRunDeps so the bag stays the single collaborator surface."
  );

  console.log("completeness: no factory argument reads a value off `managed` directly");
}

console.log("\nrun-deps completeness validation passed");

// ============================================================================
// Helpers
// ============================================================================

/** Pull `name: type;` field declarations out of the `AgentRunDeps` interface body. */
function collectFields(source) {
  const start = source.indexOf("export interface AgentRunDeps {");
  const body = source.slice(start + "export interface AgentRunDeps {".length);
  const end = body.indexOf("\n}");
  const iface = body.slice(0, end);

  const fields = [];
  for (const line of iface.split("\n")) {
    // Field lines are indented exactly two spaces; comment lines start with ` *`.
    const match = /^ {2}([A-Za-z_$][\w$]*):/.exec(line);
    if (match) fields.push({ name: match[1] });
  }
  return { fields };
}

/** Field names pulled off `deps` by destructuring: `const { a, b } = deps;`. */
function extractDestructuredFieldNames(body) {
  const names = new Set();
  for (const match of body.matchAll(/const\s*\{([^}]*)\}\s*=\s*deps\b/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(":")[0].trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * Slice `buildAgentRunner`'s body out of the file, ending at the next top-level
 * declaration. Extracting rather than scanning the whole file matters: `runnerConfigKey`
 * legitimately reads `managed.tools` (it *is* the cache key), and a whole-file scan would
 * either flag that or force an allowlist that also lets a real escape through.
 */
function extractRunnerBody(source, assert) {
  const start = source.indexOf("export function buildAgentRunner(");
  const body = source.slice(start);
  const end = body.indexOf("\nfunction runnerConfigKey(");
  assert.ok(end > 0, "canary: could not find the end of buildAgentRunner (runnerConfigKey marker missing)");
  return body.slice(0, end);
}
