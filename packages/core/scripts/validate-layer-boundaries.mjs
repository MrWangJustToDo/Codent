/**
 * Layer-boundary + module-graph gate.
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
 * ## Three properties, three checks
 *
 * 1. **Declared edges** — every used edge is in the table, with its mode and (where
 *    narrowed) its `onlySources` / `onlyTargets` restriction honoured.
 * 2. **No dead grants** — every edge in the table is exercised by at least one import.
 *    A grant nobody uses reads as a boundary that exists while nothing tests it, and
 *    the next module to cross it inherits an approval it never had to argue for.
 * 3. **Acyclic at MODULE granularity** — the graph of *runtime-value* imports between
 *    files has no cycle. This is the property the layer table cannot state: `models`
 *    and `provider` legitimately import each other (config entries construct providers,
 *    providers resolve connections from config), and `agent`/`models` share a pair of
 *    leaf helpers — the layer diagram is not a DAG. What must hold is that the
 *    underlying module graph is: a cycle between files means one module observes
 *    another half-initialized at import time. Type-only imports are erased and may
 *    cycle freely (the `runtime-types` ports do exactly that).
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
 * restriction. A listed pair that nothing exercises also fails (no dead grants).
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
  // depends only on env + TokenUsage). Neither imports `models/`, so the MODULE graph
  // stays acyclic even though the layer graph has an `agent ↔ models` pair — which is
  // exactly why the cycle check below runs at module granularity.
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
  // (`env → runtime-types` was an unused grant: env types itself. It is deliberately
  // NOT here — a declared edge with no importer is what the dead-grant check rejects.)
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
  "managers → runtime": { mode: "type-only", reason: "ManagedAgent / manager name the owning AgentRuntime" },

  // models (config + metadata) and provider (the LLM connection plane) are a coupled pair:
  // `provider→models` resolves a connection from config + models.dev types, and
  // `models→provider` lists an entry's provider / registers it. The dependency is a known,
  // bounded pair at LAYER granularity, not a module cycle; both edges are narrowed so it
  // cannot widen into a blanket.
  "provider → models": {
    mode: "allow",
    reason:
      "resolveModelConnection/resolveModelConfig + models.dev metadata types, the model-selection rule (whose choice wins) that the remote merge applies, and the public /api/provider/info payload shape (ModelsConfig) for the ProviderInfo alias",
    onlyTargets: ["config/model-config", "config/model-selection", "config/models-config", "types"],
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

// ============================================================================
// Import extraction (whole-file, so a multi-line import is an edge too)
// ============================================================================

/**
 * `import type { … } from "x"` / `import { … } from "x"` / `export type { … } from "x"` /
 * `import("x")` / `require("x")` / side-effect `import "x"`, across line breaks.
 *
 * Group 1 is the `type` marker, group 2 the imported binding list, group 3 the specifier.
 * The previous implementation matched one LINE at a time, so every import formatted across
 * lines (`import {\n  a,\n  b,\n} from "./x.js";`) was invisible to the gate: 14 of the
 * `managers → agent` imports were missing from its count while the gate printed a clean
 * pass. Reading the file as one text is what makes the count the real one.
 */
const IMPORT_RE =
  /(?:^|\s)(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s*["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)|(?:^|\s)import\s*["']([^"']+)["']/g;

/**
 * Side-effect `import "x"` on its own statement line.
 *
 * Extracted separately and blanked out before {@link IMPORT_RE} runs: that regex's first
 * alternative is allowed to span lines (`import {\n a\n} from`), so
 *
 *     import "./a.js";
 *     import { b } from "./b.js";
 *
 * matched as ONE import of `./b.js` starting at the first line — the side-effect edge vanished,
 * and a runtime value cycle through it was invisible. Blanking preserves newlines, so line
 * numbers stay correct.
 */
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)[ \t]*import\s*["']([^"']+)["'][ \t]*;?/g;

/** Every import specifier in `text`, with the side-effect statements kept as their own entries. */
function parseImportSpecifiers(text) {
  const entries = [];
  for (const match of text.matchAll(SIDE_EFFECT_IMPORT_RE)) {
    entries.push({ specifier: match[1], typeOnly: false, index: match.index ?? 0 });
  }
  const blanked = text.replace(SIDE_EFFECT_IMPORT_RE, (statement) => statement.replace(/[^\n]/g, " "));
  IMPORT_RE.lastIndex = 0;
  let match;
  while ((match = IMPORT_RE.exec(blanked)) !== null) {
    const specifier = match[3] ?? match[4] ?? match[5];
    if (specifier) entries.push({ specifier, typeOnly: Boolean(match[1]), index: match.index });
  }
  return entries;
}

// Canary: the core source has no bare side-effect imports today, so the split above would never
// be exercised. If the regexes drift back into swallowing one, fail here instead of silently
// losing an edge.
{
  const sample = 'import "./side.js";\nimport { a } from "./after.js";';
  const parsed = parseImportSpecifiers(sample).map((entry) => entry.specifier);
  if (!parsed.includes("./side.js") || !parsed.includes("./after.js")) {
    console.error("layer-boundaries: import parser dropped a side-effect import:", parsed);
    process.exit(1);
  }
}

function walkTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTsFiles(full));
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Resolve a relative specifier from `fromFile` to an on-disk module, or `null`. */
function resolveModule(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  let target = resolve(srcRoot, dirname(relative(srcRoot, fromFile)), specifier);
  if (target.endsWith(".js")) target = target.slice(0, -3) + ".ts";
  else if (!target.endsWith(".ts") && !target.endsWith(".tsx")) target += ".ts";
  try {
    statSync(target);
  } catch {
    target = target.replace(/\.tsx?$/, "/index.ts");
  }
  try {
    statSync(target);
  } catch {
    return null;
  }
  return target.startsWith(srcRoot) ? target : null;
}

/**
 * One file's imports.
 *
 * @returns `{ layerEdges, valueEdges }` — the layer edges this file exercises (with the
 *   value/type split restricted to that pair), and the runtime-value module targets.
 */
function readImports(file) {
  const text = readFileSync(file, "utf8");
  const rel = relative(srcRoot, file);
  const source = splitLayer(rel);
  const layerEdges = [];
  /** @type {Set<string>} absolute paths this module imports for its runtime values. */
  const valueEdges = new Set();

  for (const entry of parseImportSpecifiers(text)) {
    const targetFile = resolveModule(file, entry.specifier);
    if (!targetFile) continue;
    const typeOnly = entry.typeOnly;
    if (!typeOnly && targetFile !== file) valueEdges.add(targetFile);

    const target = splitLayer(relative(srcRoot, targetFile));
    if (target.layer === source.layer) continue;
    layerEdges.push({
      source,
      target,
      typeOnly,
      specifier: entry.specifier,
      line: text.slice(0, entry.index).split("\n").length,
    });
  }

  return { layerEdges, valueEdges };
}

// ============================================================================
// Rules
// ============================================================================

const unlistedLayer = [];
const unlistedEdge = [];
const wrongMode = [];
const deadEdges = [];
const valueCycles = [];
const edges = new Map();
const files = walkTsFiles(srcRoot);
const valueGraph = new Map();

for (const file of files) {
  const { layerEdges, valueEdges } = readImports(file);
  valueGraph.set(file, valueEdges);
  if (EXEMPT_SOURCE_LAYERS.has(splitLayer(relative(srcRoot, file)).layer)) continue;

  for (const edge of layerEdges) {
    const edgeKey = `${edge.source.layer} → ${edge.target.layer}`;
    let record = edges.get(edgeKey);
    if (!record) {
      record = { runtime: [], typeOnly: [] };
      edges.set(edgeKey, record);
    }
    const where = {
      file: relative(join(scriptDir, ".."), file),
      line: edge.line,
      specifier: edge.specifier,
      within: edge.target.within,
    };
    (edge.typeOnly ? record.typeOnly : record.runtime).push(where);

    const allowed = ALLOWED_EDGES[edgeKey];
    if (!allowed) {
      unlistedEdge.push({ edgeKey, ...where, typeOnly: edge.typeOnly });
    } else if (allowed.mode === "type-only" && !edge.typeOnly) {
      wrongMode.push({ edgeKey, ...where, allowed });
    } else if (allowed.onlySources && !allowed.onlySources.includes(edge.source.within)) {
      unlistedEdge.push({
        edgeKey,
        ...where,
        typeOnly: edge.typeOnly,
        restriction: `only these source files: ${allowed.onlySources.join(", ")}`,
      });
    } else if (allowed.onlyTargets && !allowed.onlyTargets.includes(edge.target.within)) {
      unlistedEdge.push({
        edgeKey,
        ...where,
        typeOnly: edge.typeOnly,
        restriction: `only these targets: ${allowed.onlyTargets.join(", ")}`,
      });
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
for (const file of files) {
  if (file.endsWith(".d.ts")) continue;
  const layer = splitLayer(relative(srcRoot, file)).layer;
  if (EXEMPT_SOURCE_LAYERS.has(layer)) continue;
  if (!knownLayers.has(layer)) unlistedLayer.push(layer);
}

// No dead grants: a table entry that no import exercises is an approval nobody uses.
for (const edgeKey of Object.keys(ALLOWED_EDGES)) {
  if (!edges.has(edgeKey)) deadEdges.push(edgeKey);
}

// No runtime-value module cycles (type-only imports are erased and exempt).
valueCycles.push(...findCycles(valueGraph));

/**
 * Tarjan's strongly-connected components over the runtime-value module graph; every
 * component with more than one member is a cycle.
 *
 * @param {Map<string, Set<string>>} graph
 * @returns {string[][]}
 */
function findCycles(graph) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  const visit = (node) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }

    if (low.get(node) === index.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) components.push(component);
    }
  };

  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return components;
}

const problems = [...unlistedLayer, ...unlistedEdge, ...wrongMode, ...deadEdges, ...valueCycles];

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

  if (deadEdges.length > 0) {
    console.error("layer-boundary: declared edge(s) that no import exercises (dead grant):");
    for (const edgeKey of deadEdges) {
      console.error(`  [dead-edge] ${edgeKey}  — ${ALLOWED_EDGES[edgeKey].reason}`);
    }
    console.error("  Delete the grant, or import through it. An edge nobody uses is not a boundary.");
    console.error("");
  }

  if (valueCycles.length > 0) {
    console.error("layer-boundary: runtime-value module cycle(s) — a module observes another half-initialized:");
    for (const component of valueCycles) {
      const members = component.map((f) => relative(srcRoot, f)).sort();
      console.error(`  [value-cycle] ${members.join("  <->  ")}`);
    }
    console.error("  Break the cycle (move the shared function down, or inject the dependency).");
    console.error("  A TYPE-ONLY cycle is fine — `import type` erases at compile time.");
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
console.log(`module graph: ${files.length} modules, 0 runtime-value cycles`);
