/**
 * Module-organization gate.
 *
 * Three rules from `AGENTS.md` ("Core Naming Conventions") were honoured by hand and had
 * silently drifted, because nothing read the tree:
 *
 * 1. **A module name states its responsibility.** The placeholder list is small and
 *    deliberate (`helpers.ts` / `misc.ts` / `utils.ts` / `common.ts` / `shared.ts`).
 *    `tools/shared/helpers.ts` would be the shape that slips through.
 * 2. **A domain directory exposes `index.ts`, and its barrel is consumed.** A barrel that
 *    nothing imports is dead weight that reads as an API; `managers/index.ts` and
 *    `managers/stream-recovery/index.ts` were both exactly that.
 * 3. **A public symbol has one definition.** Two `isToolCallPart` copies (one `null`-safe,
 *    one not) and two different `TaskRunPhase` unions under one name is the failure this
 *    catches — a duplicate that compiles is one whose behaviour quietly diverges.
 * 4. **A path a document names exists.** A main spec listed `src/agent/run-helpers/` for a
 *    directory that had been deleted, and `AGENTS.md` still named
 *    `models/prompt-cache.ts` for a file at `models/cache/prompt-cache.ts`. Nothing read
 *    either, so both pointed at nothing for as long as they survived. See the rule-4
 *    section for why this checks existence only.
 *
 * Rule 3 is checked for a curated watch-list rather than every symbol: a *deliberate*
 * re-export (`export { x } from "./y.js"`) is the barrel pattern these rules encourage, so
 * a blanket scan would flag the design. The list names the symbols where two independent
 * definitions would be a bug; add to it when a duplicate is found, as one was for
 * `isToolCallPart`.
 *
 * Run: pnpm --filter @codent/core run validate:module-organization
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(scriptDir, "../src");
const coreRoot = join(scriptDir, "..");
const repoRoot = join(scriptDir, "../../..");

let failures = 0;
function check(label, fn) {
  const problems = fn();
  if (problems.length === 0) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += problems.length;
  console.log(`  FAIL ${label}`);
  for (const problem of problems) console.log(`         ${problem}`);
}

// ============================================================================
// Tree helpers
// ============================================================================

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** Every `.ts` file under `src/`, excluding generated trees. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = walk(srcRoot);
const rel = (file) => relative(srcRoot, file).split("\\").join("/");
/**
 * Last path segment, independent of the platform's separator.
 *
 * `lastIndexOf("/")` is -1 on a Windows checkout (the paths come from `readdirSync` with `\`), where
 * it silently returned the WHOLE path — the placeholder rule then matched nothing, and the tools-root
 * rule reported `D:\a\...\create-tools.ts` as a stray helper. Both rules were dead or wrong on the
 * Windows CI job and correct on Linux, which is the worst way for a gate to be wrong.
 */
const fileName = (file) => file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);

// ============================================================================
// Rule 1 — module names state their responsibility
// ============================================================================

/**
 * Names that say nothing about what the module does. `types.ts` is deliberately absent:
 * a single-purpose type module in a domain directory *does* state its responsibility, and
 * there are ~15 of them by design. `index.ts` is the barrel convention.
 */
const PLACEHOLDER_NAMES = new Set(["helpers.ts", "misc.ts", "utils.ts", "common.ts", "shared.ts"]);

check("no placeholder module names", () => {
  return files
    .filter((file) => PLACEHOLDER_NAMES.has(fileName(file)))
    .map((file) => `${rel(file)} — rename it after the responsibility it holds (see AGENTS.md "Files")`);
});

// ============================================================================
// Rule 1b — the tools root holds factories, not per-tool helpers
// ============================================================================
//
// `openspec/specs/core-tool-layout`: "Non-factory helpers that only support a single tool MUST NOT
// sit as peer files of `*-tool.ts` at the `tools/` root when they can live under `shared/` or a feature
// subfolder." The rule had no gate, and a client-tool result builder once landed at the tools root —
// reading like a tool factory beside its real factory. The root is a roster of tool definitions;
// anything else belongs under `shared/` or its feature directory.

const TOOLS_ROOT = join(srcRoot, "agent/tools");
/** Root files that are not `*-tool.ts` but still belong to the tool layer. */
const TOOLS_ROOT_ALLOWED = new Set(["tool-config.ts", "index.ts"]);

check("agent/tools root holds only tool factories and the assembler", () => {
  return files
    .filter((file) => dirname(file) === TOOLS_ROOT)
    .map((file) => fileName(file))
    .filter((name) => !name.endsWith("-tool.ts") && !TOOLS_ROOT_ALLOWED.has(name))
    .map(
      (name) =>
        `agent/tools/${name} — a single-tool helper belongs under tools/shared/ (or its domain), not beside the factories`
    );
});

// ============================================================================
// Rule 2 — a barrel that exists is consumed
// ============================================================================
//
// Deliberately *not* "every domain directory exposes index.ts". AGENTS.md says the opposite
// for the domain tree: "The top-level `src/agent/` namespace is intentionally barrel-free —
// cross-domain imports use direct module paths there." A rule that requires a barrel
// everywhere contradicts that policy and would have flagged a documented decision. What is
// worth catching is the other half: an aggregation file that nothing imports. It reads as
// an API, so its exports look supported while being unreachable by any consumer — dead
// weight with a misleading shape. (`agent/compaction/index.ts` and
// `agent/persistence/index.ts`, by contrast, are consumed from `managers/` and stay.)

/**
 * A barrel is "consumed" when some other module imports the *directory* it backs — i.e. a
 * relative specifier that resolves to the barrel's directory (`"./foo"`, `"../foo"`), not a
 * deep path inside it (`"./foo/bar.js"`).
 *
 * Resolution is done on the real path rather than by string-matching the specifier: matching
 * text alone flags a barrel whenever a same-named directory appears at any depth.
 */
check("every barrel is imported as a directory (no dead barrels)", () => {
  const problems = [];
  // The package entry (`src/index.ts`) is the published surface, not an internal barrel.
  const barrels = files.filter((file) => file.endsWith("/index.ts") && file !== join(srcRoot, "index.ts"));

  const SPECIFIER = /from\s+"([^"]+)"/g;

  for (const barrel of barrels) {
    const targetDir = dirname(barrel);

    const consumed = files.some((file) => {
      if (file === barrel) return false;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(SPECIFIER)) {
        const specifier = match[1];
        if (!specifier.startsWith(".")) continue;
        // Resolve the specifier the way the bundler would: relative to the importer. A
        // directory specifier (`"./foo"`) resolves to the barrel's directory; strip an
        // emitted `.js`/`.ts` so a deep path maps back to its source file.
        const bare = specifier.replace(/\.(js|ts)$/, "");
        const resolved = join(dirname(file), bare);
        if (resolved === targetDir || resolved === barrel.replace(/\.ts$/, "")) return true;
      }
      return false;
    });

    if (!consumed) {
      problems.push(`${rel(barrel)} — nothing imports its directory; delete the barrel or point consumers at it`);
    }
  }

  return problems;
});

// ============================================================================
// Rule 3 — watched public symbols have one definition
// ============================================================================

/**
 * Symbols where two independent definitions would be a bug (not a re-export). The check
 * counts *definitions*, so `export { x } from "./y.js"` is transparent and only real
 * `export function x` / `export type x = …` bodies count.
 */
const SINGLE_DEFINITION_SYMBOLS = [
  "isToolCallPart",
  "TaskRunPhase",
  // Cross-cutting utility primitives — one definition each (see `converge-core-utility-logic`).
  // A second `export function` body for any of these is the divergence the dedicated
  // `validate-no-inline-*` guards cannot see (they catch re-derivations, not re-declarations).
  "utf8ByteLength",
  "truncateToUtf8Bytes",
  "truncateText",
  "formatByteSize",
  "splitDisplayLines",
  "normalizeOutputNewlines",
  "toError",
  "errorMessage",
  "isBinaryMediaPartType",
  "isExpiredMemory",
  "slugifyName",
  // The line-window family (`utils/line-window.ts`): a second definition of a display window is exactly
  // the divergence this list is for, and the `validate-no-inline-*` guards cannot see a re-declaration.
  "takeLatestLines",
  "padLatestLines",
  "hiddenLinesIndicator",
  "buildLineWindow",
];

function countDefinitions(symbol) {
  const defining = [
    new RegExp(`^export\\s+(async\\s+)?function\\s+${symbol}\\b`, "m"),
    new RegExp(`^export\\s+(const|class|interface|type)\\s+${symbol}\\b`, "m"),
  ];
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (defining.some((pattern) => pattern.test(text))) hits.push(rel(file));
  }
  return hits;
}

check("watched public symbols have a single definition", () => {
  const problems = [];
  for (const symbol of SINGLE_DEFINITION_SYMBOLS) {
    const definitions = countDefinitions(symbol);
    if (definitions.length > 1) {
      problems.push(
        `${symbol} — defined in ${definitions.length} modules (${definitions.join(", ")}); keep one and re-export it`
      );
    }
  }
  return problems;
});

// ============================================================================
// Rule 4 — a path a document names exists
// ============================================================================
//
// A main spec required barrels in `src/agent/run-helpers/` long after that directory was
// deleted, and `AGENTS.md` named `packages/core/src/models/prompt-cache.ts` for a file that
// lives at `models/cache/prompt-cache.ts`. Both are the same failure — a document asserting a
// location that is not there — and neither was visible because nothing read the documents.
//
// Scope is documentation and specs, not source comments. A comment naming a path is read next
// to the code it describes and is often a deliberate generalisation ("the way
// `runtime-types/middleware-phase.ts` does"); scanning every comment for path-shaped tokens
// yields prose, not claims. Docs and specs exist to be accurate about the tree, they are few
// (32 references as written), and both known-stale references live in them.
//
// **Existence only — deliberately not the stronger rule.** A tempting form is "an importer
// taking 2+ symbols from one directory must use its barrel root" (`AGENTS.md`: "import from the
// directory root when consuming 2+ symbols"). Measured against the tree that rule fails **81
// import sites across 26 directories**, because the convention is aspirational everywhere and
// enforced nowhere. A gate that fails 81 legitimate sites gets disabled, which is worse than no
// gate — it teaches that the *other* rules here are negotiable. So rule 4 checks what is binary
// and what actually broke: does the path resolve.

/** Documents whose path claims are checked. */
function documentationFiles() {
  const docs = [join(repoRoot, "AGENTS.md"), join(repoRoot, "CLAUDE.md")];
  const specRoot = join(repoRoot, "openspec/specs");
  if (existsSync(specRoot)) {
    const stack = [specRoot];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) stack.push(full);
        else if (entry.endsWith(".md")) docs.push(full);
      }
    }
  }
  return docs.filter((file) => existsSync(file));
}

/**
 * A path token in a document. Two spellings are in use and both are checked:
 *
 * - fully qualified — `` `packages/core/src/models/types.ts` ``;
 * - package-relative — `` `agent/compaction/wire-projection.ts` ``, which every core
 *   doc section uses because the section is already about core
 *
 * A bare word, a package name, or a URL is not a location claim and does not match.
 * `src/…` is likewise treated as a claim: every such reference in this repo means a
 * file under a package's `src/`.
 */
const CORE_TOP_LEVEL = [
  "agent",
  "agent-session",
  "dev",
  "env",
  "managers",
  "models",
  "provider",
  "runtime",
  "runtime-types",
  "utils",
];
const DOC_PATH = new RegExp(
  "`((?:packages/|src/)[A-Za-z0-9_\\-./]+|(?:" + CORE_TOP_LEVEL.join("|") + ")/[A-Za-z0-9_\\-./]+\\.ts)`",
  "g"
);

/**
 * Lines that *name* a path in order to forbid or contrast it — "not as `agent/tools/webfetch-html.ts`".
 * The path is not a claim that the file exists; `core-tool-layout`'s scenario is the case, and
 * resolving it would demand recreating the layout that requirement exists to prevent.
 *
 * Deliberately line-scoped and noun-phrase-explicit: a bare "no" or "not" elsewhere in a
 * paragraph must not suppress a real claim, so the marker has to be adjacent ("not as",
 * "never as", "instead of", "rather than") — within 24 characters before the token.
 */
const NEGATIVE_CONTEXT = /(?:not as|never as|instead of|rather than)\s*$/;

/** Every package's `src/` root, so a package-relative token resolves against each. */
function packageSrcRoots() {
  const roots = [join(coreRoot, "src")];
  for (const entry of readdirSync(join(repoRoot, "packages"))) {
    const src = join(repoRoot, "packages", entry, "src");
    if (existsSync(src) && statSync(src).isDirectory()) roots.push(src);
  }
  return roots;
}

check("every path named by a document resolves", () => {
  const problems = [];
  const bases = [repoRoot, coreRoot, ...packageSrcRoots()];
  for (const doc of documentationFiles()) {
    const text = readFileSync(doc, "utf8");
    for (const match of text.matchAll(DOC_PATH)) {
      const named = match[1];
      if (named.includes("*")) continue;
      if (NEGATIVE_CONTEXT.test(text.slice(Math.max(0, match.index - 24), match.index))) continue;
      // A trailing slash is a directory reference; strip it so `packages/codent/scripts/`
      // resolves to the directory it plainly means.
      const cleaned = named.replace(/\/$/, "");
      if (bases.some((base) => existsSync(join(base, cleaned)))) continue;
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(
        `${relative(repoRoot, doc)}:${line} names \`${named}\` — no such file or directory (see AGENTS.md "Documentation Style"); if this is an example rather than a claim, mark it with \`not as …\``
      );
    }
  }
  return problems;
});

// ============================================================================

if (failures > 0) {
  console.log(`\nmodule-organization validation FAILED (${failures} problem(s))`);
  process.exit(1);
}
console.log("\nmodule-organization validation passed");
