/**
 * Self-containment guard for the fully bundled release build.
 *
 * The whole point of `codent` is that its tarball installs on its own: no
 * `@codent/*` sibling on the registry, and no workspace package in the
 * published dependency graph. That property is invisible at build time —
 * tsdown happily leaves a bare specifier in the output and the build still
 * succeeds — so it needs its own assertion. Three checks:
 *
 *   1. `dist/index.mjs` and every emitted chunk reference no `@codent/*`
 *      specifier (static `from` or dynamic `import()`). Comments are stripped
 *      first: core/node ship dozens of JSDoc examples that quote
 *      `from "@codent/core"` and would otherwise read as false positives.
 *   2. `dependencies` is exactly the external allowlist. Each one is an import
 *      the emitted bundle still makes, so omitting it ships a package that
 *      crashes with ERR_MODULE_NOT_FOUND on the user's first invocation
 *      (verified by installing the tarball into an empty project).
 *   3. `optionalDependencies` is drawn from the (separate) optional allowlist.
 *      Those are the native addons, which cannot be inlined and must not be
 *      `required` either: npm installs them where a prebuilt binding exists and
 *      skips them elsewhere, which is the degrade-not-crash behaviour the host
 *      wants. Keeping them in the allowlist (rather than allowing the field
 *      wholesale) means a new entry has to state its reason. Moving one into
 *      `dependencies` is the failure this guards: it would turn "image
 *      resizing is unavailable" into "the install fails".
 *   4. No `@codent/*` workspace package is declared as a dependency — those
 *      are build inputs, and publishing one would defeat the point.
 *   5. The tree-sitter grammars the host parses with are present in `dist`. They
 *      are neither inlined (`.wasm`, not JS) nor declared (a 50 MB aggregate of
 *      which 18 grammars / 22.8 MB are used), so they are **copied in at build
 *      time** by `scripts/copy-tree-sitter-grammars.mjs`. Nothing in the bundle
 *      would reveal their absence — every tree-sitter tool would just return
 *      null for a user — so it is asserted here.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLanguageToGrammar } from "./resolve-workspace-deps.mjs";

const LANGUAGE_TO_GRAMMAR = await loadLanguageToGrammar();

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(pkgRoot, "dist");

/**
 * Packages that may stay external: the single-copy renderer, plus the packages
 * that read assets through their own on-disk layout (`import.meta.url` /
 * `require.resolve`). Everything else is inlined by tsdown.
 */
const ALLOWED_EXTERNALS = [
  "@my-react/react",
  "@my-react/react-terminal",
  "@anthropic-ai/sandbox-runtime",
  "web-tree-sitter",
];

/**
 * External packages that are **optional**: native addons whose prebuilt binding
 * may not exist on the consumer's platform. Nothing may `require` them, so they
 * cannot sit in `dependencies` — that is what makes the install itself fail —
 * and each one has to degrade on its own at the call site.
 *
 *   - `sharp`        → image downscaling behind CoreEnv `resizeImage`
 *   - `isolated-vm`  → the code-mode isolate; `@tanstack/ai-isolate-node` is
 *                      inlined and resolves this by path at call time
 *   - `@jitsi/robotjs` → native screen + input behind CoreEnv `computer`; it is
 *                      `createRequire`d by path (which the specifier scan cannot
 *                      see, same blind spot as isolated-vm) and its absence is
 *                      the documented "no computer-use tools" degradation
 */
const ALLOWED_OPTIONAL_EXTERNALS = ["sharp", "isolated-vm", "@jitsi/robotjs"];

const failures = [];

// ============================================================================
// package.json shape
// ============================================================================

const pkg = JSON.parse(await readFile(join(pkgRoot, "package.json"), "utf8"));
const dependencies = Object.keys(pkg.dependencies ?? {});
const optionalDependencies = Object.keys(pkg.optionalDependencies ?? {});

for (const name of ALLOWED_EXTERNALS) {
  if (!dependencies.includes(name)) {
    failures.push(`external "${name}" is missing from dependencies — npm would not install it`);
  }
}
for (const name of dependencies) {
  if (!ALLOWED_EXTERNALS.includes(name)) {
    failures.push(`runtime dependency "${name}" is not in the external allowlist — inline it instead`);
  }
  if (name.startsWith("@codent/")) {
    failures.push(`workspace package "${name}" must not be published as a dependency`);
  }
}

for (const name of ALLOWED_OPTIONAL_EXTERNALS) {
  if (!optionalDependencies.includes(name)) {
    failures.push(`optional external "${name}" is missing from optionalDependencies — npm would never install it`);
  }
}
for (const name of optionalDependencies) {
  if (!ALLOWED_OPTIONAL_EXTERNALS.includes(name)) {
    failures.push(`optional dependency "${name}" is not in the optional allowlist — inline it instead`);
  }
  if (dependencies.includes(name)) {
    failures.push(`"${name}" is both a dependency and an optional dependency — a native addon must stay optional`);
  }
}

// ============================================================================
// dist has no @codent/* specifier left
// ============================================================================

/** Strip block and line comments so JSDoc examples are not read as imports. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// `from "@codent/app"` / `import("@codent/server/client")`. The `[^"']`
// body plus the `@codent/` prefix keeps relative chunk imports out.
const SPECIFIER_PATTERN = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](@codent\/[^"']*)["']/g;

const entries = await readdir(distDir);
const jsFiles = entries.filter((name) => name.endsWith(".mjs") || name.endsWith(".js"));

if (jsFiles.length === 0) {
  failures.push(`no JS output found in ${distDir} — run "pnpm build" first`);
}

const found = new Map();
for (const file of jsFiles) {
  const text = stripComments(await readFile(join(distDir, file), "utf8"));
  for (const match of text.matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (!found.has(specifier)) found.set(specifier, new Set());
    found.get(specifier).add(file);
  }
}

for (const [specifier, files] of found) {
  failures.push(`bare specifier "${specifier}" left in ${[...files].slice(0, 3).join(", ")}`);
}

// ============================================================================
// tree-sitter grammars shipped alongside dist
// ============================================================================

// Same manifest the copy script uses, so the two cannot disagree about which
// languages exist. A grammar listed in core but missing here means the tarball
// would ship a language whose tools silently return nothing.
const grammarDir = join(distDir, "tree-sitter");
const expectedGrammars = [...new Set(Object.values(LANGUAGE_TO_GRAMMAR))].sort();

if (expectedGrammars.length === 0) {
  failures.push("LANGUAGE_TO_GRAMMAR is empty — the tree-sitter grammar list cannot be verified");
}

let shippedGrammars = [];
try {
  shippedGrammars = (await readdir(grammarDir)).filter((name) => name.endsWith(".wasm"));
} catch {
  failures.push(
    `no tree-sitter grammars in ${grammarDir} — run "pnpm build" ` +
      `(scripts/copy-tree-sitter-grammars.mjs populates it)`
  );
}

const shipped = new Set(shippedGrammars);
for (const grammar of expectedGrammars) {
  if (!shipped.has(grammar)) {
    failures.push(
      `tree-sitter grammar "${grammar}" is missing from dist/tree-sitter — the host cannot parse that language`
    );
  }
}

// A grammar that is present but empty would load as a corrupt module.
for (const grammar of shippedGrammars) {
  const { size } = await stat(join(grammarDir, grammar));
  if (size === 0) failures.push(`tree-sitter grammar "${grammar}" is empty`);
}

// ============================================================================
// Report
// ============================================================================

if (failures.length > 0) {
  console.error("[codent] validate:self-contained FAILED\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("\nThe published package would not be self-contained.");
  process.exit(1);
}

const maps = entries.filter((name) => name.endsWith(".map"));
console.log(
  `[codent] validate:self-contained OK — ${jsFiles.length} JS files (${maps.length} maps), ` +
    `0 @codent/* specifiers, ${dependencies.length} externals + ${optionalDependencies.length} optional externals, ` +
    `${shippedGrammars.length} tree-sitter grammars`
);
