/**
 * Validation: every temp-tree removal carries the retries Windows needs.
 *
 * Why this exists: the Windows validator job failed with
 *
 *     [Error: ENOTEMPTY: directory not empty, rmdir '…\builtin-skills-bootstrap-N2UaOP\.agents']
 *
 * from `validate-local-agent-session.mjs`. A recursive removal hit a directory a writer had just
 * re-created — a session save, a log append or a job log landing after the removal enumerated the tree —
 * which POSIX does not care about (an unlinked directory is invisible to the walker) and Windows does.
 * `fs.rm`'s `maxRetries`/`retryDelay` are the documented answer, and they are a no-op on POSIX.
 *
 * Every validator now removes through `helpers/temp-cleanup.mjs` (`TEMP_RM_OPTIONS`), so the rule needs
 * one assertion: no script anywhere cleans a tree without them. The other half is asserted too — the
 * shared options must still HAVE the retries, or the rule would be satisfied by emptying it.
 *
 * Run: pnpm --filter @codent/core run validate:temp-cleanup
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const HELPER = "packages/core/scripts/helpers/temp-cleanup.mjs";
const BARE_OPTIONS = "{ recursive: true, force: true }";

/**
 * Files that NAME the pattern rather than use it: this guard, and the helper that defines the options.
 * An allowlist entry has to carry its reason, or a real call site could hide behind a blanket skip.
 */
const NAMES_THE_PATTERN = new Set([HELPER, "packages/core/scripts/validate-temp-cleanup.mjs"]);

const failures = [];

// 1. The shared options must still carry the retries this file exists for.
//
// Asserted on the exported VALUE, not on the file's text: the helper's own doc comment names
// `maxRetries`/`retryDelay`, so a text search passes even after the options have been emptied — the
// mutation test for this file is what caught that (the first version of this check was satisfied by its
// own documentation).
if (TEMP_RM_OPTIONS.recursive !== true || TEMP_RM_OPTIONS.force !== true) {
  failures.push(`${HELPER}: TEMP_RM_OPTIONS must stay an unconditional recursive removal`);
}
if (!(TEMP_RM_OPTIONS.maxRetries > 0) || !(TEMP_RM_OPTIONS.retryDelay > 0)) {
  failures.push(
    `${HELPER}: TEMP_RM_OPTIONS must keep maxRetries/retryDelay > 0 — that is the Windows retry this ` +
      "file exists for"
  );
}

// 2. No other script may spell the option object itself.
const packagesDir = join(repoRoot, "packages");
for (const pkg of readdirSync(packagesDir)) {
  const scriptsDir = join(packagesDir, pkg, "scripts");
  let files;
  try {
    files = readdirSync(scriptsDir);
  } catch {
    continue; // no scripts/ directory — not a validator-carrying package
  }
  for (const file of files) {
    if (!file.endsWith(".mjs")) continue;
    const full = join(scriptsDir, file);
    const rel = relative(repoRoot, full).split("\\").join("/");
    if (NAMES_THE_PATTERN.has(rel)) continue;
    readFileSync(full, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.includes(BARE_OPTIONS)) {
          failures.push(`${rel}:${i + 1} removes a tree without the Windows retries — use TEMP_RM_OPTIONS`);
        }
      });
  }
}

if (failures.length > 0) {
  console.error("validate-temp-cleanup: failed");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log("validate-temp-cleanup: ok — every temp-tree removal goes through TEMP_RM_OPTIONS");
