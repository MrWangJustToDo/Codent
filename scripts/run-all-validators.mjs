/**
 * Validator suite runner — one package's `scripts/validate-*.mjs`, against the build
 * that is already on disk.
 *
 * Why a runner instead of `pnpm run validate:*` per script: **151 of the 156** core
 * `validate:*` entries embed `pnpm run build &&`, so driving them through npm pays a
 * 3.2 s rebuild per validator (151 × 3.2 s ≈ 483 s). The files themselves take 34 s for
 * the whole core suite. The expense is an artifact of how the scripts are written, not
 * of what they test — so this runs the files directly with `node` and leaves those
 * definitions untouched (each still builds correctly when run standalone).
 *
 * Discovery is a **glob, not a list**. A new `validate-*.mjs` is covered by existing, and
 * a script with no `validate:*` npm entry still runs — which is how
 * `validate-format-read-file-result.mjs` had gone unrun while looking like coverage.
 *
 * Two behaviours exist to keep a green run honest:
 *
 * - **Skipped is not passed.** A validator whose prerequisite is missing exits 0, which is
 *   indistinguishable from a validator that verified everything. Skipping is signalled
 *   explicitly ({@link SKIP_MARKER}) and reported separately. Without this, a Windows run
 *   where every language-server validator silently skipped would read as a full pass.
 * - **Untracked paths are a failure.** A validator reading the repo's gitignored `.agents/`
 *   passes only on a machine where that directory happens to be populated, and fails on a
 *   fresh clone — i.e. in CI and only in CI. That is a real incident, not a hypothetical.
 *
 * Usage (root is the workspace root; run from anywhere):
 *   node scripts/run-all-validators.mjs [--dir packages/core] [--concurrency N] [--timeout-ms N] [--quiet]
 *
 *   --dir <path>   run one package's validators (repeatable); default is every package
 *   --quiet        suppress the per-validator `ok` lines (summaries and skips still print)
 *
 * The guard helpers are exported so they can be unit-tested without running the suite.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// Contract with the validators
// ============================================================================

/**
 * Printed by a validator that is skipping work rather than verifying it. Any validator
 * that cannot exercise its assertions MUST print this, so the suite reports a skip
 * instead of counting an `exit 0` as a pass.
 */
export const SKIP_MARKER = "[validator-skip]";

/** Emit a skip notice in the shared format. */
export function reportSkip(reason) {
  console.log(`${SKIP_MARKER} ${reason}`);
}

// ============================================================================
// Config
// ============================================================================

const DEFAULT_TIMEOUT_MS = 90_000;
// Memory is the binding constraint, not CPU: the core build peaks at ~4 GB and runners
// carry ~8 GB, so a deeper window risks an OOM kill that looks like a validator failure.
const DEFAULT_CONCURRENCY = 4;

function parseArgs(argv) {
  const opts = { dirs: [], concurrency: DEFAULT_CONCURRENCY, timeoutMs: DEFAULT_TIMEOUT_MS, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") opts.dirs.push(argv[++i]);
    else if (arg === "--concurrency") opts.concurrency = Number(argv[++i]);
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (arg === "--quiet") opts.quiet = true;
  }
  return opts;
}

// ============================================================================
// Untracked-path guard
// ============================================================================

/**
 * Paths a validator must never read from the repository: gitignored runtime state.
 *
 * `.agents/` is where the agent writes logs, sessions, plans and memory — and where a
 * developer's own skills live. It is covered by a `.gitignore` entry, so it is absent on
 * a fresh clone.
 */
const UNTRACKED_REPO_PREFIXES = [".agents/", "tmp/"];

/**
 * True for expressions that resolve against the repository checkout rather than a temp dir.
 *
 * This is what makes the guard precise. `join(rootPath, ".agents", ...)` is *not* a bug when
 * `rootPath` is a `mkdtemp` directory — and several validators do exactly that, legitimately.
 * The repository root has a specific signature: it comes from the module URL (`import.meta.url`)
 * or is walked up from the script directory. A temp root comes from `mkdtemp`/`tmpdir`.
 */
const REPO_ROOT_EXPR =
  /import\.meta\.url|fileURLToPath|__dirname|process\.cwd\(\)|\.\.\/\s*\.\.\/|\.\.\s*,\s*import\.meta/;

/**
 * Identifiers bound to an expression that resolves against the repository checkout.
 *
 * Empty for a validator that only builds temp fixtures, which is why a violation here is a
 * positive signal rather than a heuristic.
 */
export function repoRootIdentifiers(source) {
  const names = new Set();
  for (const line of source.split("\n")) {
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
    // `const root = fileURLToPath(new URL("../../..", import.meta.url))`
    // `const ROOT = new URL("..", import.meta.url).pathname`
    const decl = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);?/);
    if (!decl) continue;
    const [, name, expr] = decl;
    if (REPO_ROOT_EXPR.test(expr)) names.add(name);
  }
  return names;
}

/**
 * Files allowed to read the workspace's optional corpora, with the reason the read is safe.
 *
 * The guard exists because a validator that reads `.agents/` breaks on a fresh clone. These two
 * read the models.dev cache as an *optional* corpus for real-metadata invariants: absence is
 * handled (the corpus section prints its own notice and the rest of the file still runs), and a
 * fixture cannot substitute — the assertion is about the shipped dataset. They are not allowed to
 * become the model for new fixtures.
 */
const OPTIONAL_CORPUS_READERS = new Map([
  [
    "packages/core/scripts/validate-model-capabilities.mjs",
    "optional models.dev corpus; absence is announced and the mapping assertions still run",
  ],
  [
    "packages/core/scripts/validate-models-dev-lookup.mjs",
    "optional models.dev corpus; the synthetic fixture stands alone when it is absent",
  ],
]);

/**
 * Whether a validator actually *reads* a repo-relative untracked path.
 *
 * Deliberately conservative, because a guard that cries wolf gets switched off. A bare
 * mention is not a bug — three validators legitimately carry `.agents/...` as an opaque
 * string value (asserting a returned `planSave.data.path`). The signal is a path built from
 * an identifier that {@link repoRootIdentifiers} proved resolves to the repository root.
 */
export function readsUntrackedRepoPath(source) {
  const repoRoots = repoRootIdentifiers(source);

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    // Comments and docs describe the pattern without performing the read.
    if (line.startsWith("*") || line.startsWith("//") || line.startsWith("/*")) continue;

    for (const prefix of UNTRACKED_REPO_PREFIXES) {
      const segment = prefix.replace(/\/$/, "");
      for (const name of repoRoots) {
        // join/resolve(root, ".agents", ...) — with the id matching a repo-root binding.
        const joined = new RegExp(`(?:join|resolve)\\s*\\(\\s*${name}\\s*,\\s*["'\`]${segment}["'\`]`);
        // `${root}/.agents/` inside a template literal.
        const interpolated = new RegExp(`\\$\\{\\s*${name}\\s*\\}[\\/\\\\]${segment}[\\/\\\\]`);
        if (joined.test(line) || interpolated.test(line)) return prefix;
      }

      // A repo-root expression used DIRECTLY, with no binding to match: this is the shape
      // `path.resolve(process.cwd(), "../../.agents/cache/…")` has, and the two patterns above
      // cannot see it because there is no identifier to look up. Without this branch the guard
      // passed a validator that read the workspace cache and silently skipped assertions when it
      // was absent (`validate-capability-unknown-vs-none`).
      const mentionsRepoRoot = line.includes("process.cwd()") || [...repoRoots].some((name) => line.includes(name));
      if (mentionsRepoRoot && new RegExp(`["'\`][^"'\`]*${segment}[/\\\\]`).test(line)) return prefix;
    }
  }
  return null;
}

// ============================================================================
// Running a package's validators
// ============================================================================

function runOne(file, scriptsDir, timeoutMs) {
  const start = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(scriptsDir, file)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      cwd: dirname(scriptsDir),
    });

    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));

    child.on("close", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - start;
      const skipped = output.includes(SKIP_MARKER);
      let status;
      if (timedOut) status = "timeout";
      else if (code !== 0) status = "fail";
      else if (skipped) status = "skip";
      else status = "pass";
      resolvePromise({ file, status, ms, output, code });
    });
  });
}

// ============================================================================
// Report
// ============================================================================

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function tail(text, lines = 12) {
  return text.split("\n").filter(Boolean).slice(-lines).join("\n");
}

/**
 * Whether a validator drives `SessionStore` with an fs mock that cannot replace the log atomically.
 *
 * `SessionStore.writeLog` writes a temp file and renames it onto the log so a concurrent reader
 * sees the old file or the new one, never a truncated one. A mock that omits `rename` silently
 * falls back to an in-place `writeFile`, which truncates the log to zero bytes first — and since
 * the window is microseconds wide, the resulting `load() === null` surfaces only on a slow,
 * load-contended runner, as an intermittent `Cannot read properties of null` in a polling
 * validator. That is a property of the mock, not of the product, and it is decidable from the
 * source before anything runs.
 *
 * Scoped to `SessionStore` because it is the only writer that needs `rename` for correctness: a
 * real `writeFile` mock no store uses is not a hazard, and an in-memory mock
 * (`writeFile: async () => {}`) never truncates a file at all.
 */
export function mutatesWritableFsWithoutRename(source) {
  // Only validators that drive `SessionStore` are exposed: it is the one writer that relies on
  // `rename` for atomic replace. Another writer with a real `writeFile` mock is out of scope.
  const drivesStore = /getSessionStore\(|new SessionStore\(|store\.load\(|SessionService/.test(source);
  if (!drivesStore) return false;
  // A real write (`writeFile: async (p, c) => …`), not the in-memory no-op `writeFile: async () => {}`.
  const writable = /writeFile:\s*(?:async\s*)?\(\s*[A-Za-z_$][\w$]*/.test(source);
  if (!writable) return false;
  // A two-parameter `rename(from, to)` — the shape every env uses (`createNodeEnv` and the
  // validators that already mock it). Comments are skipped so a docblock naming `rename:`
  // does not count as providing it.
  const providesRename = source
    .split("\n")
    .some(
      (line) =>
        !line.trim().startsWith("//") &&
        !line.trim().startsWith("*") &&
        /rename:\s*(?:async\s*)?\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*/.test(line)
    );
  return !providesRename;
}

/**
 * Run every `validate-*.mjs` in one package's `scripts/` directory.
 *
 * Returns counts so the dispatcher can aggregate; the per-package report is printed here,
 * next to the results it describes.
 */
async function runPackageValidators({ scriptsDir, concurrency, timeoutMs, quiet }) {
  const packageRoot = resolve(scriptsDir, "..");
  const packageName = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).name;

  const files = (await readdir(scriptsDir))
    .filter((name) => name.startsWith("validate-") && name.endsWith(".mjs"))
    .sort();

  const summary = { passed: 0, failed: 0, skipped: 0, timeout: 0, guardViolations: [] };

  if (files.length === 0) {
    return summary;
  }

  // Guards reject before running, so a violation is attributed to the source rather than
  // surfacing as a confusing runtime failure on a fresh clone (or as a flake on a slow runner).
  const repoRoot = resolve(scriptsDir, "../../..");
  for (const file of files) {
    const source = await readFile(join(scriptsDir, file), "utf8");
    const repoRelative = relative(repoRoot, join(scriptsDir, file)).split(sep).join("/");
    const allowed = OPTIONAL_CORPUS_READERS.has(repoRelative);
    const prefix = allowed ? null : readsUntrackedRepoPath(source);
    if (prefix) summary.guardViolations.push({ file, kind: "untracked", detail: prefix });
    if (mutatesWritableFsWithoutRename(source)) {
      summary.guardViolations.push({ file, kind: "fs-mock", detail: "SessionStore fs mock lacks `rename`" });
    }
  }

  const results = [];
  let next = 0;

  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      const result = await runOne(file, scriptsDir, timeoutMs);
      results.push(result);
      if (!quiet) {
        const label = { pass: "ok  ", fail: "FAIL", skip: "SKIP", timeout: "TIME" }[result.status];
        console.log(`${label} ${fmtMs(result.ms).padStart(7)}  ${file}`);
      }
    }
  }

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  const wall = Date.now() - startedAt;

  const passed = results.filter((r) => r.status === "pass");
  const failed = results.filter((r) => r.status === "fail");
  const timedOut = results.filter((r) => r.status === "timeout");
  const skipped = results.filter((r) => r.status === "skip");

  summary.passed = passed.length;
  summary.failed = failed.length;
  summary.skipped = skipped.length;
  summary.timeout = timedOut.length;

  console.log(`\n${"=".repeat(72)}`);
  console.log(`[validators] ${packageName} (${files.length} scripts, ${fmtMs(wall)}, concurrency ${concurrency})`);
  console.log(`[validators]   passed:  ${passed.length}`);
  console.log(`[validators]   failed:  ${failed.length}`);
  console.log(`[validators]   skipped: ${skipped.length}`);
  console.log(`[validators]   timeout: ${timedOut.length}`);

  for (const r of skipped) {
    const reason = r.output.split("\n").find((l) => l.includes(SKIP_MARKER)) ?? "";
    console.log(`[validators]   SKIP ${r.file}: ${reason.replace(SKIP_MARKER, "").trim()}`);
  }

  for (const r of [...failed, ...timedOut]) {
    console.log(`\n${"-".repeat(72)}`);
    console.log(`[validators] ${r.status.toUpperCase()}: ${r.file}`);
    console.log(tail(r.output));
  }

  // A validator that reads a gitignored path passes locally and fails in CI; an incomplete fs
  // mock passes on a fast machine and fails on a slow, load-contended one. Both are reported as
  // failures of this suite, attributed to the source, so they are fixed before they reach CI.
  if (summary.guardViolations.length > 0) {
    console.log(`\n${"-".repeat(72)}`);
    console.log(`[validators] FAILED: ${summary.guardViolations.length} guard violation(s)`);
    for (const v of summary.guardViolations) {
      if (v.kind === "untracked") {
        console.log(
          `[validators]   ${v.file} reads "${v.detail}" relative to the repo — absent on a fresh clone.\n` +
            `[validators]   Build the fixture at run time (os.tmpdir()) instead.`
        );
      } else {
        console.log(
          `[validators]   ${v.file}: ${v.detail} — ` +
            "the store then rewrites the log in place, so a concurrent `load()` can read a truncated file.\n" +
            "[validators]   Add `rename: async (from, to) => fs.promises.rename(from, to)` to the fs mock."
        );
      }
    }
  }

  return summary;
}

// ============================================================================
// Dispatcher
// ============================================================================

/**
 * Packages whose validators are deliberately NOT run by this suite.
 *
 * `packages/codent`'s two validators assert the *published tarball* contract
 * (`validate:self-contained`, `validate:runtime-specifiers`). CI runs them at a specific
 * point — after `build:app:release` — because what they check depends on which app build the
 * bundle consumed. Running them here as well would either duplicate that gate or, worse,
 * assert it against the wrong build and fail for a reason that is not a regression.
 */
const SUITE_EXCLUDED_PACKAGES = new Set(["codent"]);

/**
 * Every workspace package that has a `scripts/` directory. Discovered rather than listed,
 * for the same reason the validators are: a new package is covered by existing.
 */
async function discoverPackageDirs(workspaceRoot) {
  const packagesDir = join(workspaceRoot, "packages");
  const dirs = [];
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SUITE_EXCLUDED_PACKAGES.has(entry.name)) continue;
    const scripts = join(packagesDir, entry.name, "scripts");
    try {
      const files = await readdir(scripts);
      if (files.some((f) => f.startsWith("validate-") && f.endsWith(".mjs"))) dirs.push(scripts);
    } catch {
      // No scripts/ directory — not a validator-carrying package.
    }
  }
  return dirs.sort();
}

async function main() {
  const { dirs, concurrency, timeoutMs, quiet } = parseArgs(process.argv.slice(2));
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  // `--dir` names a *package* directory (`packages/core`) for readability; the runner works
  // on the `scripts/` directory inside it. Accept either form.
  const targets =
    dirs.length > 0
      ? dirs.map((d) => {
          const abs = resolve(workspaceRoot, d);
          return abs.endsWith("scripts") ? abs : join(abs, "scripts");
        })
      : await discoverPackageDirs(workspaceRoot);

  if (targets.length === 0) {
    console.log("[validators] no package scripts directories found");
    process.exit(0);
  }

  let anyBad = false;
  const grand = { passed: 0, failed: 0, skipped: 0, timeout: 0 };

  // An allowlist entry that no longer matches a file is a silent exemption for a file that was
  // renamed or deleted — the reason has to be re-examined, so it fails instead of rotting.
  for (const [repoRelative, reason] of OPTIONAL_CORPUS_READERS) {
    if (!existsSync(resolve(workspaceRoot, repoRelative))) {
      console.log(`[validators] STALE allowlist entry: ${repoRelative} does not exist`);
      anyBad = true;
    } else if (!reason.trim()) {
      console.log(`[validators] allowlist entry ${repoRelative} has no reason`);
      anyBad = true;
    }
  }

  for (const scriptsDir of targets) {
    const summary = await runPackageValidators({ scriptsDir, concurrency, timeoutMs, quiet });
    grand.passed += summary.passed;
    grand.failed += summary.failed;
    grand.skipped += summary.skipped;
    grand.timeout += summary.timeout;
    if (summary.passed + summary.failed + summary.skipped + summary.timeout === 0) continue;
    if (summary.failed + summary.timeout + summary.guardViolations.length > 0) anyBad = true;
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(
    `[validators] ALL PACKAGES: ${grand.passed} passed, ${grand.failed} failed, ` +
      `${grand.skipped} skipped, ${grand.timeout} timeout`
  );
  process.exit(anyBad ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
