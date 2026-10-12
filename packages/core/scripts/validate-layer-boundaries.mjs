/**
 * Layer-boundary gate (generalized).
 *
 * `validate-agent-managers-boundary` and `validate-models-managers-boundary` each
 * matched one literal pattern — a specifier containing `/managers/`. Two gates, one
 * regex: every other edge in the layer diagram was unchecked, so `models → agent`,
 * `runtime-types → managers`, `agent → agent-session` and `env → agent` could all
 * appear (and did) without any script noticing. A gate that covers two of six edges
 * reads as coverage and is not.
 *
 * This script derives the edges from the imports instead of from a pattern: it walks
 * `src/**`, resolves every relative specifier to its top-level layer, and checks the
 * resulting `source → target` pair against {@link ALLOWED_EDGES}. Any pair not listed
 * fails, as does an unlisted layer — so a new top-level directory is a decision, not
 * an accident.
 *
 * Type-only imports (`import type`, `export type`) get their own column. A type-only
 * edge is still an edge — `runtime-types/hosts.ts` is a *ports* module precisely
 * because it re-exports manager classes as types, and that has to be a registered
 * choice rather than a loophole — but it is a weaker coupling than a runtime value,
 * so the table records which of the two it permits.
 *
 * Run: pnpm --filter @codent/core run validate:layer-boundaries
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(scriptDir, "../src");

// ============================================================================
// Layer table
// ============================================================================

/**
 * Top-level directory (or single file) → layer name. Files at the `src/` root are
 * layers too: a root file that is a layer on its own bounds the stack the same way a
 * directory does, and an import out of it is the same kind of inversion.
 *
 * Three root files are not layers in their own right:
 * - `env.ts` (the `env` layer's barrel; the layer itself now lives under `src/env/`);
 * - `dev.ts` — the dev-only barrel;
 * - `index.ts` — the public barrel.
 * `.d.ts` files are declarations, not modules with edges.
 */
function stripModuleExtension(name) {
  return name
    .replace(/\.d\.ts$/, "")
    .replace(/\.tsx?$/, "")
    .replace(/\.js$/, "");
}

const ROOT_FILE_LAYERS = {
  // `env` resolves from a bare directory import (`from "../env"` → `src/env`).
  env: "env",
  dev: "dev",
  index: "index",
};

/**
 * Split a `src/`-relative path into `{ layer, within }`.
 *
 * `within` is the path *inside* the layer (e.g. `stream/stream-errors` for
 * `agent/stream/stream-errors.ts`), which is what an edge allowlist has to name —
 * "agent" alone would let a new `agent/foo` import appear under an allowlisted edge.
 */
function splitLayer(relPath) {
  const parts = relPath.split(sep);
  if (parts.length > 1) return { layer: parts[0], within: stripModuleExtension(parts.slice(1).join("/")) };
  const base = stripModuleExtension(parts[0]);
  const layer = ROOT_FILE_LAYERS[base];
  if (layer) return { layer, within: layer };
  return { layer: base, within: base };
}

/**
 * The layer DAG. `from → to` is the pair being checked; `= "allow"` means the edge
 * is intended, `"type-only"` means only `import type` / `export type` may cross it.
 *
 * Every entry carries a reason, because the reason is the only thing that makes an
 * exception reviewable later. Two optional restrictions narrow an allowed edge so it
 * cannot become a general-purpose hole:
 *
 * - `onlySources` — only these files *within the source layer* may cross the edge;
 * - `onlyTargets` — only these targets *within the target layer* may be imported.
 *
 * An unlisted pair fails the gate, and so does a listed pair that violates its
 * restriction.
 */
const ALLOWED_EDGES = {
  // managers is the orchestration layer: it composes every domain module.
  "managers → agent": { mode: "allow", reason: "orchestration drives domain modules" },
  "managers → models": { mode: "allow", reason: "model selection / adapters" },
  "managers → runtime-types": { mode: "allow", reason: "shared status + payload types" },
  "managers → utils": { mode: "allow", reason: "ids, emitters" },
  "managers → env": { mode: "allow", reason: "CoreEnv access" },

  // agent is the domain layer: it owns tools, compaction, subagents, extensions.
  "agent → models": { mode: "allow", reason: "token estimation, capability utils, side queries" },
  "agent → runtime-types": { mode: "allow", reason: "shared status + payload types" },
  "agent → utils": { mode: "allow", reason: "ids, emitters" },
  "agent → env": { mode: "allow", reason: "CoreEnv access" },
  "agent → agent-session": {
    mode: "type-only",
    reason:
      "agent-event-bus/types.ts names the session channel union (`AgentSessionChannel`) so the event→channel projection is type-checked against the wire, and agent/commands/catalog.ts types a command's dispatched `command` field as the `AgentSessionCommand` discriminant so a host's dispatch switch is compile-checked. Types only.",
    onlySources: ["agent-event-bus/types", "commands/catalog"],
  },

  // models is the LLM plane: config, adapter factories, prompt cache, pricing.
  "models → runtime-types": { mode: "allow", reason: "TokenUsage / pricing helpers" },
  "models → utils": { mode: "allow", reason: "ids" },
  "models → env": { mode: "allow", reason: "CoreEnv access" },
  //
  // `side-text-query` reuses two leaf modules that live under `agent/`: the stream
  // error helper (pure chunk → message) and the global usage history (whose IO layer
  // depends only on env + TokenUsage). Neither imports `models/`, so there is no
  // cycle — and the allowlist names both files so a third one fails the gate.
  "models → agent": {
    mode: "allow",
    reason:
      "side-text-query reuses the pure stream-error helper and the global usage history. Both are leaves: neither imports models/.",
    onlyTargets: ["stream/stream-errors", "usage/usage-history-service"],
  },

  // runtime-types is the shared leaf: types (+ tiny pure helpers) used by every
  // layer. An upward edge from here is what turns "shared" into the coupling hub
  // where cycles hide, so the handful that exist are named file-for-file.
  //
  // These are *ports*: `hosts.ts` declares the manager-side capabilities domain
  // modules consume (ManagedAgent, AgentManager, UsageTracker, AgentUIChannel,
  // AgentStatusController) and `agent-event-payloads.ts` needs the MCP status shape.
  // They are re-exports rather than local interfaces because each port is still
  // owned by its implementation; extracting them outright belongs to the
  // composition-root split, not to a type move.
  "runtime-types → managers": {
    mode: "type-only",
    reason: "hosts.ts declares the manager-side ports that domain modules consume.",
    onlySources: ["hosts"],
  },
  "runtime-types → agent": {
    mode: "type-only",
    reason: "hosts.ts exposes the AgentUIChannel port (`agent/ui/ui-channel.ts` implements it).",
    onlySources: ["hosts"],
  },
  "runtime-types → models": {
    mode: "type-only",
    reason: "ModelInfo / ModelPricing shape the shared payloads.",
    onlySources: ["session-payloads", "token-usage"],
  },

  // env is the runtime abstraction at the bottom of the stack. It declares the LSP
  // transport port (hosts implement `createLspConnection`) but must not reach up.
  "env → runtime-types": { mode: "allow", reason: "shared payload types" },
  "env → utils": { mode: "allow", reason: "ids" },

  // agent-session is the host-facing control surface. It is a host layer: it holds
  // `ManagedAgent` and `AgentManager` by design (the session protocol is defined in
  // terms of them), so `→ managers` is intended rather than an escape.
  "agent-session → agent": {
    mode: "allow",
    reason: "session reads domain state (persistence, tools, subagent phases)",
  },
  "agent-session → managers": {
    mode: "allow",
    reason: "host/UI control surface — the session protocol is defined over ManagedAgent / AgentManager by design.",
  },
  "agent-session → models": { mode: "allow", reason: "model identity in the snapshot + side-text queries" },
  "agent-session → runtime-types": { mode: "allow", reason: "session payload types" },
  "agent-session → utils": { mode: "allow", reason: "ids, emitters" },
  "agent-session → env": { mode: "allow", reason: "CoreEnv access" },
  "agent-session → runtime": { mode: "type-only", reason: "the local host names its manager's `AgentRuntime` type" },
  "agent-session → provider": {
    mode: "type-only",
    reason:
      "host-types declares the optional getModelProvider()/getEnv() on AgentSessionHost so a host-bound consumer uses the runtime's provider/env, not the ambient registry.",
    onlySources: ["host-types"],
  },

  // runtime composes an env + model provider + AgentManager + AgentSessionHost into one
  // instantiable instance (the top of the managers stack); lower layers reference its types.
  "runtime → env": { mode: "allow", reason: "owns the workspace CoreEnv" },
  "runtime → models": { mode: "type-only", reason: "CodentAgentOptions carries a ModelStyle" },
  "runtime → managers": { mode: "allow", reason: "owns the AgentManager" },
  "runtime → agent-session": { mode: "allow", reason: "owns / creates the AgentSessionHost" },
  "runtime → agent": { mode: "type-only", reason: "AgentToolConfig type for session defaults" },
  "runtime → utils": { mode: "allow", reason: "ids" },
  "managers → runtime": { mode: "type-only", reason: "ManagedAgent / manager name the owning AgentRuntime" },

  // models (config + metadata) and provider (the LLM connection plane) are a coupled pair:
  // `provider→models` resolves a connection from config + models.dev types, and
  // `models→provider` lists an entry's provider / registers it. The dependency is a known,
  // bounded cycle, not a DAG; both edges are narrowed so it cannot widen into a blanket.
  "provider → models": {
    mode: "allow",
    reason: "resolveModelConnection/resolveModelConfig + models.dev metadata types",
    onlyTargets: ["config/model-config", "types"],
  },
  "provider → env": { mode: "allow", reason: "CoreEnv.fetch for models.dev lookup" },
  "provider → utils": { mode: "allow", reason: "ids" },
  "models → provider": {
    mode: "allow",
    reason: "an entry lists/registers its ModelProvider (provider construction + models.dev lookup)",
    onlySources: ["config/models-config", "config/model-config", "index"],
  },
  "runtime → provider": { mode: "allow", reason: "runtime owns the ModelProvider" },
};

/**
 * Layers whose imports are not checked: `dev` is the test/dev-only surface and
 * `index` is the public barrel, which is *supposed* to reach every layer.
 */
const EXEMPT_SOURCE_LAYERS = new Set(["dev", "index"]);

/** Resolved specifier → `{ layer, within }`, or `null` for a bare package / escaped path. */
function resolveTarget(fromFileRel, specifier) {
  const rel = relative(srcRoot, resolve(srcRoot, dirname(fromFileRel), specifier));
  if (rel.startsWith("..")) return null; // escaped src/ (e.g. a relative import out of the package)
  return splitLayer(rel);
}

// ============================================================================
// Import extraction
// ============================================================================

/** `import ... from "x"` / `import("x")` / `require("x")` / `export ... from "x"`. */
const IMPORT_RE =
  /(?:^|\s)(?:import|export)\s(?:[\s\S]*?)\sfrom\s*["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * `import type { X } from "..."` and `export type { X } from "..."` are the only
 * forms that erase at compile time. A bare `import { type X }` is still a runtime
 * import (the statement is emitted), so it is deliberately not counted here.
 */
const TYPE_ONLY_RE = /(?:^|\s)(?:import|export)\s+type\s/;

function walkTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTsFiles(full));
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function extractSpecifiers(line) {
  const specs = [];
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(line)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec.startsWith(".")) specs.push(spec);
  }
  return specs;
}

// ============================================================================
// Rules
// ============================================================================

const unlistedLayer = [];
const unlistedEdge = [];
const wrongMode = [];
const edges = new Map();

for (const file of walkTsFiles(srcRoot)) {
  const sourceLayer = splitLayer(relative(srcRoot, file)).layer;
  if (EXEMPT_SOURCE_LAYERS.has(sourceLayer)) continue;

  // `rel` still needs the posix-ish separators the specifier resolver expects.
  const rel = relative(srcRoot, file);
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const typeOnly = TYPE_ONLY_RE.test(line);
    for (const spec of extractSpecifiers(line)) {
      const target = resolveTarget(rel, spec);
      if (target === null || target.layer === sourceLayer) continue;

      const edgeKey = `${sourceLayer} → ${target.layer}`;
      let record = edges.get(edgeKey);
      if (!record) {
        record = { runtime: [], typeOnly: [] };
        edges.set(edgeKey, record);
      }
      const where = {
        file: relative(join(scriptDir, ".."), file),
        line: i + 1,
        specifier: spec,
        within: target.within,
      };
      (typeOnly ? record.typeOnly : record.runtime).push(where);

      const allowed = ALLOWED_EDGES[edgeKey];
      if (!allowed) {
        unlistedEdge.push({ edgeKey, ...where, typeOnly });
      } else if (allowed.mode === "type-only" && !typeOnly) {
        wrongMode.push({ edgeKey, ...where, allowed });
      } else {
        const sourceWithin = splitLayer(relative(srcRoot, file)).within;
        if (allowed.onlySources && !allowed.onlySources.includes(sourceWithin)) {
          unlistedEdge.push({
            edgeKey,
            ...where,
            typeOnly,
            restriction: `only these source files: ${allowed.onlySources.join(", ")}`,
          });
        } else if (allowed.onlyTargets && !allowed.onlyTargets.includes(target.within)) {
          unlistedEdge.push({
            edgeKey,
            ...where,
            typeOnly,
            restriction: `only these targets: ${allowed.onlyTargets.join(", ")}`,
          });
        }
      }
    }
  }
}

// A layer that never appears as a target or source in the table is an undeclared
// layer: this makes adding a directory a deliberate act.
const knownLayers = new Set([
  "env",
  "agent",
  "agent-session",
  "managers",
  "models",
  "provider",
  "runtime",
  "runtime-types",
  "utils",
]);
for (const file of walkTsFiles(srcRoot)) {
  if (file.endsWith(".d.ts")) continue;
  const layer = splitLayer(relative(srcRoot, file)).layer;
  if (EXEMPT_SOURCE_LAYERS.has(layer)) continue;
  if (!knownLayers.has(layer)) unlistedLayer.push(layer);
}

const problems = [...unlistedLayer, ...unlistedEdge, ...wrongMode];

if (problems.length > 0) {
  if (unlistedLayer.length > 0) {
    console.error("layer-boundary: undeclared layer(s):");
    for (const layer of [...new Set(unlistedLayer)]) console.error(`  ${layer}`);
    console.error("  Add the layer to ALLOWED_EDGES (with a reason) or exclude it deliberately.");
    console.error("");
  }

  if (unlistedEdge.length > 0) {
    console.error("layer-boundary: unlisted edge(s) — a source layer importing a target it must not:");
    for (const v of unlistedEdge) {
      const kind = v.typeOnly ? "type-only" : "RUNTIME VALUE";
      console.error(`  [unlisted] ${v.edgeKey}  (${kind})  ${v.file}:${v.line}  "${v.specifier}"`);
      if (v.restriction) console.error(`      ${v.restriction}`);
    }
    console.error("");
  }

  if (wrongMode.length > 0) {
    console.error("layer-boundary: edge(s) that must stay type-only but carry a runtime value:");
    for (const v of wrongMode) {
      console.error(`  [value-in-type-only-edge] ${v.edgeKey}  ${v.file}:${v.line}  "${v.specifier}"`);
      console.error(`      reason for the type-only restriction: ${v.allowed.reason}`);
    }
    console.error("");
  }

  console.error("Layer diagram (ARCHITECTURE.md §1.5): managers → agent → models → env, with");
  console.error("runtime-types as the shared leaf. Fix the import, or register the edge in");
  console.error("ALLOWED_EDGES with a reason. A type-only edge is still an edge.");
  process.exit(1);
}

// ============================================================================
// Report (always printed — the gate should be readable, not just silent)
// ============================================================================

console.log("layer boundaries validated. Edges in use:");
for (const [edgeKey, record] of [...edges.entries()].sort()) {
  const allowed = ALLOWED_EDGES[edgeKey];
  const count = record.runtime.length + record.typeOnly.length;
  const parts = [];
  if (record.runtime.length > 0) parts.push(`${record.runtime.length} value`);
  if (record.typeOnly.length > 0) parts.push(`${record.typeOnly.length} type-only`);
  const mode = allowed.mode === "type-only" ? "type-only" : "allow";
  console.log(`  ${edgeKey}  [${mode}]  ${count} import(s): ${parts.join(", ")}`);
}
