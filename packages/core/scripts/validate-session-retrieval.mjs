/**
 * Validates the session-retrieval turn-context section.
 *
 * Guards the contract that makes this the single home for "how to search past
 * conversation" — the knowledge previously spread across the compaction summary,
 * the (removed) archive file header, `AGENTS.md`, and `ARCHITECTURE.md`, two of which
 * were frozen and had already drifted apart:
 *
 *   1. Gated on history existing; absent entirely on a fresh workspace
 *   2. The session-log shape described (JSONL, one message per line, complete) and
 *      the `session_search` / `session_read` tools named
 *   3. The current session's own files called out as redundant
 *   4. No volatile content (counts/versions), so the section hash is stable
 *   5. The body is fully static — no per-session paths — so one admission settles it
 *   6. The kind is NOT in SUBAGENT_ALLOWED_KINDS (root-agent decision)
 *
 * Run: pnpm --filter @codent/core run validate:session-retrieval
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SUBAGENT_ALLOWED_KINDS,
  SESSION_RETRIEVAL_KIND,
  formatSessionRetrievalSection,
  hasSessionHistory,
  registerCoreEnv,
  renderStaticRetrievalBody,
} from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

// ---------------------------------------------------------------------------
// Disk-backed CoreEnv over a temp workspace
// ---------------------------------------------------------------------------

let workspace = "";
let rootPath = join(tmpdir(), `instr-retrieval-${Date.now()}`);

registerCoreEnv({
  rootPath,
  getPlatform: async () => "test",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => "/home/test",
  fs: {
    readFile: async (p) => (await import("node:fs")).readFileSync(p, "utf-8"),
    stat: async (p) => {
      const s = (await import("node:fs")).statSync(p);
      return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, mtime: s.mtime };
    },
    readdir: async (p) =>
      (await import("node:fs")).readdirSync(p, { withFileTypes: true }).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : "file",
      })),
    writeFile: async (p, c) => writeFileSync(p, String(c)),
    mkdir: async (p) => mkdirSync(p, { recursive: true }),
    exists: async (p) => (await import("node:fs")).existsSync(p),
    remove: async (p) => (await import("node:fs")).rmSync(p, TEMP_RM_OPTIONS),
  },
  byteLength: (s) => Buffer.byteLength(s, "utf-8"),
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => ({ ok: true, status: 200 }),
});

function resetWorkspace() {
  rmSync(rootPath, TEMP_RM_OPTIONS);
  mkdirSync(rootPath, { recursive: true });
  workspace = rootPath;
}

// ---------------------------------------------------------------------------
// 1. Gating: no history → no section
// ---------------------------------------------------------------------------
await (async () => {
  resetWorkspace();
  assert.equal(await hasSessionHistory(), false, "empty workspace has no history");
  assert.equal(
    formatSessionRetrievalSection({ hasHistory: false }),
    undefined,
    "no history → no section (absent, not empty)"
  );

  // A sessions directory that exists but is empty is still not history.
  mkdirSync(join(workspace, ".agents", "sessions"), { recursive: true });
  assert.equal(await hasSessionHistory(), false, "empty sessions dir is not history");

  // A single session is history.
  writeFileSync(join(workspace, ".agents", "sessions", "ses_a.session.jsonl"), "{}");
  assert.equal(await hasSessionHistory(), true, "one session counts as history");
  // …including the live one: the section's third paragraph tells the model how to reach THIS session's
  // compacted-away turns, so its own log alone is a reason to emit the guidance.

  console.log("✓ the section is gated on history existing");
})();

// ---------------------------------------------------------------------------
// 2. Both shapes described, with the reading difference
// ---------------------------------------------------------------------------
await (async () => {
  resetWorkspace();
  const section = formatSessionRetrievalSection({ hasHistory: true });
  assert.ok(section, "section renders when history exists");
  assert.ok(section.startsWith("<session_retrieval>"), "opens with its tag");
  assert.ok(section.endsWith("</session_retrieval>"), "closes with its tag");

  assert.match(section, /\.session\.jsonl/, "names the session-log shape (JSONL, not the legacy .json)");
  assert.match(section, /one message per line/, "states the JSONL shape is one message per line");
  assert.match(section, /complete/i, "states the log is the complete conversation");
  assert.match(section, /session_search/, "names the retrieval tool as the primary path");
  assert.match(section, /session_read/, "names the read tool");

  console.log("✓ both on-disk shapes and their reading difference are stated");
})();

// ---------------------------------------------------------------------------
// 3. The current session's own earlier turns are reachable
// ---------------------------------------------------------------------------
await (async () => {
  const section = formatSessionRetrievalSection({ hasHistory: true });
  // The old "redundant / duplicates the live conversation" claim is gone: the current session's
  // compacted-away earlier turns are NOT in context, so the guidance must point at them.
  assert.doesNotMatch(section, /duplicates? (?:what|the live)/i, "no 'current session is redundant' claim");
  assert.match(section, /sessionId/, "tells the agent to pass its own session id to session_search");
  assert.match(section, /<session_id>/, "references the session-id context block");
  assert.match(section, /earlier turns/i, "names the current session's earlier turns as the target");

  console.log("✓ the current session's earlier turns are reachable via session_search");
})();

// ---------------------------------------------------------------------------
// 4. No volatile content
// ---------------------------------------------------------------------------
await (async () => {
  const first = formatSessionRetrievalSection({ hasHistory: true });
  const second = formatSessionRetrievalSection({ hasHistory: true });
  assert.equal(first, second, "identical inputs → byte-identical rendering (hash stable)");

  // Counts are the specific hazard: they change as sessions are created/pruned.
  assert.doesNotMatch(first, /\b\d+\s+sessions?\b/, "no session counts");
  assert.doesNotMatch(first, /\b\d+\s+files?\b/, "no file counts");
  assert.doesNotMatch(first, /\bas of\b|\bcurrently\b/i, "no time-relative wording");

  console.log("✓ the body carries no volatile content");
})();

// ---------------------------------------------------------------------------
// 5. The body is fully static — one admission settles it (no per-session paths)
// ---------------------------------------------------------------------------
await (async () => {
  // The section must not vary with the workspace's on-disk state: it names no concrete
  // session path, so creating one cannot change its hash and re-inject the whole block.
  const before = formatSessionRetrievalSection({ hasHistory: true });

  resetWorkspace();
  mkdirSync(join(workspace, ".agents", "sessions"), { recursive: true });
  writeFileSync(join(workspace, ".agents", "sessions", "ses_x.session.jsonl"), "{}");

  const after = formatSessionRetrievalSection({ hasHistory: true });
  assert.equal(after, before, "the section does not change as sessions appear (hash must settle)");
  assert.doesNotMatch(after, /\.agents\/sessions\/ses_/, "no concrete session path in the section");

  console.log("✓ the section is fully static");
})();

// ---------------------------------------------------------------------------
// 6. Root-agent only
// ---------------------------------------------------------------------------
{
  assert.equal(
    SUBAGENT_ALLOWED_KINDS.has(SESSION_RETRIEVAL_KIND),
    false,
    "subagents must not receive cross-session retrieval guidance"
  );
  console.log("✓ the kind is excluded from SUBAGENT_ALLOWED_KINDS");
}

// ---------------------------------------------------------------------------
// 7. The static body is the section minus paths (used by the drift guard)
// ---------------------------------------------------------------------------
await (async () => {
  const body = renderStaticRetrievalBody();
  assert.ok(body.length > 0, "static body is non-empty");
  assert.doesNotMatch(body, /transcripts\/ses_/, "static body names no concrete session path");

  console.log("✓ the static body is available and path-free");
})();

resetWorkspace();
rmSync(rootPath, TEMP_RM_OPTIONS);

console.log("session-retrieval validation passed");
