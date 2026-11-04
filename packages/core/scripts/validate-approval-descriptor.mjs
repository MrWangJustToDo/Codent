/**
 * Approval descriptor gate.
 *
 * A tool's approval requirement is a descriptor composed at registration
 * (`ApprovalRequirement`); policy reads it through the tool registry. Re-reading the raw
 * `needsApproval` flag in a policy path is how two gates start to disagree about one call.
 *
 * The remaining allowed reads are definitions/composition and transcript/UI projections.
 *
 * Run: node scripts/validate-approval-descriptor.mjs
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "../src");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

function sourceFiles(dir = srcRoot, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
}

const ALLOWED = new Map([
  ["agent/tools/runtime/define-tool.ts", "tool declaration → metadata composition"],
  ["agent/approval/approval-requirement.ts", "the descriptor composer itself"],
  ["agent/mcp/extension.ts", "MCP annotations → registration flag"],
  ["managers/services/agent-tool-service.ts", "registration passes the declaration through"],
  ["agent/approval/tool-approval-table.ts", "transcript part → approval row projection"],
  ["agent/approval/tool-authorization.ts", "transcript approval state (gated? denied?), not the tool declaration"],
  ["agent/tools/presentation/state.ts", "UI projection"],
  ["agent/stream/apply-tool-denial-reason.ts", "message projection equality"],
  ["agent/stream/incomplete-tool-calls.ts", "transcript projection"],
  ["agent/stream/tool-phase-utils.ts", "transcript projection"],
  ["managers/middleware/status-middleware.ts", "status projection"],
]);

const violations = [];
const seen = new Set();
for (const file of sourceFiles()) {
  const rel = relative(srcRoot, file).replaceAll("\\", "/");
  const text = stripComments(readFileSync(file, "utf8"));
  const matches = [...text.matchAll(/\.needsApproval\b/g)];
  if (matches.length === 0) continue;
  if (!ALLOWED.has(rel)) {
    for (const match of matches) {
      const line = text.slice(0, match.index).split("\n").length;
      violations.push(
        `${rel}:${line} — raw needsApproval policy read; use the registered ApprovalRequirement (AgentToolService.getApprovalRequirement)`
      );
    }
  } else {
    seen.add(rel);
  }
}

const stale = [...ALLOWED]
  .filter(([rel]) => !seen.has(rel))
  .map(([rel, why]) => `${rel}: stale allowlist entry — ${why}`);

assert.deepEqual(violations, []);
assert.deepEqual(stale, []);
console.log("approval descriptor validation passed");
