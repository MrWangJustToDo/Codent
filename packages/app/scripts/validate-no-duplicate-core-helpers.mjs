/**
 * Fail when `@codent/app` re-declares a helper that `@codent/core` already exports.
 *
 * The app carried its own `normalizeOutputNewlines` / `splitStreamingLines` — and the
 * line-window arithmetic around them — while core exported the same helpers publicly, so
 * two definitions stayed in agreement only by luck. Import from `@codent/core` instead.
 *
 * Run: pnpm --filter @codent/app run validate:no-duplicate-core-helpers
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(scriptDir, "../src");

/** Helpers whose single definition lives in `@codent/core`. */
const CORE_HELPERS = [
  "normalizeOutputNewlines",
  "splitStreamingLines",
  "takeLatestLines",
  "padLatestLines",
  "hiddenLinesIndicator",
  "buildLineWindow",
];

const declaration = (name) => new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b`);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const offenders = [];
for (const file of walk(srcRoot)) {
  const text = readFileSync(file, "utf8");
  const rel = relative(srcRoot, file).split("\\").join("/");
  text.split("\n").forEach((line, index) => {
    for (const name of CORE_HELPERS) {
      if (declaration(name).test(line)) offenders.push({ rel, line: index + 1, name });
    }
  });
}

if (offenders.length > 0) {
  process.stderr.write("validate-no-duplicate-core-helpers: helper(s) declared in app but owned by @codent/core:\n");
  for (const offender of offenders) {
    process.stderr.write(`  ${offender.rel}:${offender.line}  ${offender.name}\n`);
  }
  process.stderr.write("\nImport them from @codent/core instead of re-declaring them.\n");
  process.exit(1);
}

process.stdout.write("validate-no-duplicate-core-helpers: ok\n");
