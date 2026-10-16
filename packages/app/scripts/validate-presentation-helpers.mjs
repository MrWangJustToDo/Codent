/**
 * Ensure the app's compaction-summary surface stays aligned with core's.
 *
 * Run: pnpm --filter @codent/app run validate:presentation-helpers
 *
 * This used to read the marker STRINGS out of both source files and compare them. That assumed
 * `app/src/utils/compaction-summary.ts` holds the literals, and it stopped being true when that file
 * became a re-export of `@codent/core` — the regex matched nothing, `constString` threw, and the
 * failure looked like a marker mismatch rather than "the file this checks no longer has literals".
 *
 * The property that actually matters is stronger than equal strings, so assert it directly: the app
 * has no copy at all, and the names it publishes resolve to core's definitions. A copy reappearing
 * (or the re-export drifting to a different module) fails here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appSummaryPath = join(here, "../src/utils/compaction-summary.ts");
const coreSummaryPath = join(here, "../../core/src/agent/compaction/compaction-summary.ts");
const appSummary = readFileSync(appSummaryPath, "utf8");
const coreSummary = readFileSync(coreSummaryPath, "utf8");

/** The literal a `export const NAME = "…"` declares, or fail. */
function constString(src, name, where) {
  const match = src.match(new RegExp(`export const ${name} = "([^"]+)"`));
  assert.ok(match, `${name} is not declared as a literal in ${where}`);
  return match[1];
}

// Core is the source of truth: the markers are written by its compaction, so they are declared there.
const start = constString(coreSummary, "CONVERSATION_SUMMARY_START", "core");
const end = constString(coreSummary, "CONVERSATION_SUMMARY_END", "core");
assert.notEqual(start, end, "the two markers must differ, or every body would match either");

// The app must not re-declare them. This is the regression the old assertion was too weak to catch:
// it compared two literals, so a copy that happened to agree passed — and a copy that drifted was
// caught only until someone edited one side. Structurally absent is the only stable form.
assert.ok(
  !/export const (CONVERSATION_SUMMARY_START|CONVERSATION_SUMMARY_END)\s*=/.test(appSummary),
  "app/utils/compaction-summary.ts must re-export the markers, not declare its own copy"
);

// And the names it publishes must come from core (a re-export from anywhere else is the same drift,
// one module further away).
const REEXPORTED = [
  "CONVERSATION_SUMMARY_START",
  "CONVERSATION_SUMMARY_END",
  "extractCompactionSummaryBody",
  "formatCompactionSummaryContent",
];
const block = appSummary.match(/export\s*\{([^}]*)\}\s*from\s*"([^"]+)"/);
assert.ok(block, "app/utils/compaction-summary.ts is not a re-export");
assert.equal(block[2], "@codent/core", `re-exported from ${block[2]}, expected @codent/core`);
for (const name of REEXPORTED) {
  assert.ok(block[1].includes(name), `${name} is no longer re-exported by the app`);
}

// The app's own public surface (`src/index.ts`) publishes the same names. That is what "the app still
// exposes these" means, and dropping one is silent at build time.
const consumer = readFileSync(join(here, "../src/index.ts"), "utf8");
for (const name of REEXPORTED) {
  assert.ok(consumer.includes(name), `${name} is no longer published by app src/index.ts`);
}

console.log(
  `presentation-helpers: ok (core declares ${JSON.stringify(start)} / ${JSON.stringify(end)}; app re-exports them)`
);
