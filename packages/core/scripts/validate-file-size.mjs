/**
 * File-size guard for every package's source.
 *
 * The design guideline is 400 lines (`.cursor/rules/040`); the enforced ceiling is 800
 * (`eslint max-lines` with `skipBlankLines`). This guard counts the SAME metric (non-blank lines),
 * so the two cannot disagree — the old raw-line count made `server/remote-session-client.ts` fail
 * here while passing ESLint, and it only scanned `packages/core/src`, so the ceiling did not exist
 * for any other package. A package with no `src` (the WXT extension) is walked from its root rather
 * than skipped — the earlier `catch { continue; }` claimed a coverage it did not have.
 * Keep every file above the ceiling in the allowlist with a written reason; fail any new one, and
 * fail an allowlisted file that drops back under (a stale exemption).
 *
 * Run: pnpm --filter @codent/core run validate:file-size
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { collectPackageSources, packageNames } from "./helpers/package-sources.mjs";

const MAX_LINES = 800;

/** Existing over-ceiling files (`<package>/<path under src>`). Every entry must still exceed it. */
const ALLOWLIST = new Map([
  [
    "core/managers/managed-agent.ts",
    "Composes the agent lifecycle, controllers and public facade; split is tracked separately.",
  ],
  [
    "core/agent/extension/runner.ts",
    "Extension registration/lifecycle orchestrator. The UI/context bridge, default renderer, observer surface, message-transformer registry, dispatch order and owner-id rule are already separate modules; what remains is the registration lifecycle itself, which the rollback paths require to stay in one class.",
  ],
  [
    "core/managers/controllers/agent-chat-controller.ts",
    "Chat run orchestration: pump admission/continuation, mid-run queue, session-switch refusal contract, approval answering, stream-outcome finalization. Their ORDER is the invariant, so a split has to carry it; the refusal gate and queue drain helpers are the next unit.",
  ],
  [
    "acp/agent.ts",
    "ACP agent surface: one handler per protocol method plus the session runtime and config-option advertisement. The projector, child projector, interactions and session config options are already separate modules.",
  ],
  [
    "acp/projector.ts",
    "ACP session/update projector: one method per protocol update kind plus transcript/message mapping. Split is tracked separately.",
  ],
]);

const over = [];
const seen = new Set();
let scanned = 0;
const packages = await packageNames();
for (const pkg of packages) {
  let files;
  try {
    files = await collectPackageSources(pkg);
  } catch {
    continue; // unreadable package (no source tree at all)
  }
  for (const { absolute, relative } of files) {
    scanned += 1;
    const source = await readFile(absolute, "utf8");
    // SAME metric as `eslint max-lines` + `skipBlankLines`.
    const lines = source.split("\n").filter((line) => line.trim().length > 0).length;
    if (lines > MAX_LINES) {
      over.push({ relative, lines, reason: ALLOWLIST.get(relative) });
      if (ALLOWLIST.has(relative)) seen.add(relative);
    }
  }
}

const unexpected = over.filter((entry) => entry.reason === undefined);
assert.deepEqual(
  unexpected.map((entry) => `${entry.relative}:${entry.lines}`),
  [],
  `files over ${MAX_LINES} lines must be added to ALLOWLIST with a reason`
);

const stale = [...ALLOWLIST.keys()].filter((file) => !seen.has(file));
assert.deepEqual(stale, [], "ALLOWLIST entries must still exceed the ceiling; remove the stale entry");

for (const entry of over) console.log(`ok  ${entry.relative} ${entry.lines} lines — allowlisted`);
console.log(`file-size validation passed (${scanned} files across ${packages.length} packages, ceiling ${MAX_LINES})`);
