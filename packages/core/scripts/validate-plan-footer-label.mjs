/**
 * Validation for plan Footer phase labels.
 *
 * Run: pnpm --filter @codent/core run validate:plan-footer-label
 *
 * The label is a pure projection of the phase machine, so it has ONE definition — the public core
 * entry `@codent/core`, which is what hosts import. It used to be two byte-identical files: core's
 * (exported from the plan barrel, consumed by nobody) and the app's copy (consumed by the footer).
 * This guard pinned the dead one, so the observable label had no coverage at all.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The PUBLIC entry, not `dev.mjs`: this is the surface a host may reach.
import { formatPlanModeFooterLabel, todoProgressFromItems } from "../dist/index.mjs";

assert.equal(formatPlanModeFooterLabel({ phase: "off" }), null);
assert.equal(formatPlanModeFooterLabel({ phase: "planning" }), "planning");
assert.equal(formatPlanModeFooterLabel({ phase: "ready" }), "review · /mode execute");
assert.equal(formatPlanModeFooterLabel({ phase: "executing" }), "building");
assert.equal(formatPlanModeFooterLabel({ phase: "executing" }, { completed: 2, total: 5 }), "building 2/5");
assert.equal(formatPlanModeFooterLabel({ phase: "retro" }), "retro");

assert.deepEqual(
  todoProgressFromItems([
    { status: "completed" },
    { status: "pending" },
    { status: "in_progress" },
    { status: "completed" },
  ]),
  { completed: 2, total: 4 }
);

// ONE definition: the app must consume the core export, not keep a copy. A local file would make
// the label above irrelevant to what the user actually sees (that is exactly how it drifted before).
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const appUtils = join(REPO, "packages", "app", "src", "utils");
assert.equal(
  existsSync(join(appUtils, "plan-footer-label.ts")),
  false,
  "the app must not keep its own plan-footer-label copy — import it from @codent/core"
);

console.log("validate:plan-footer-label OK");
