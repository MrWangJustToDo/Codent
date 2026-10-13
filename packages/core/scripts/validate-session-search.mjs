/**
 * Validation: session history retrieval (`session_search` / `session_read`).
 *
 * Past conversation is two on-disk shapes — `.agents/sessions/<id>.session.jsonl` (one JSON message
 * per line) and `.agents/transcripts/<sessionId>/compact-<N>.md` (plain text) — and the tools must
 * read both without the model touching raw JSON. This pins:
 *
 *   1. both shapes are searched, and a session hit is parsed (session id + role + snippet), not raw
 *   2. the current session is excluded by default and re-included by an explicit sessionId
 *   3. the role filter narrows results
 *   4. results are bounded (a limit withholds the rest, and says so)
 *   5. `session_read` renders a session, paginates, refuses an oversized log before folding it, and
 *      fails clearly on an unknown id
 *   6. the tools are read-only and root-only (absent from the subagent tool set)
 *   7. the retrieval guidance no longer describes the stale single-line `.session.json` format
 *
 * Run: pnpm --filter @codent/core run validate:session-search
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createSessionReadTool,
  createSessionSearchTool,
  createTanStackSubagentTools,
  listSessionIds,
  makeSnippet,
  readSessionMessages,
  getEnv,
  registerCoreEnv,
  clearCoreEnv,
  searchHistory,
  sessionExists,
  MAX_SESSION_FILE_BYTES,
} from "../dist/dev.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// ============================================================================
// In-memory CoreEnv with a small session history
// ============================================================================

const line = (message) => JSON.stringify({ t: "message", message, state: {} });
const text = (content) => ({ type: "text", content });
const toolCall = (name, args) => ({ type: "tool-call", name, arguments: args });

/** Path of the (logically) oversized log — its reported `stat.size` is forced below. */
const OVERSIZE_LOG = ".agents/sessions/ses_oversize.session.jsonl";

const FILES = {
  ".agents/sessions/ses_old.session.jsonl": [
    line({ id: "o1", role: "user", parts: [text("We deploy with a blue-green strategy for safety.")] }),
    line({
      id: "o2",
      role: "assistant",
      parts: [text("Understood — blue-green avoids downtime during the switch.")],
    }),
    line({
      id: "o3",
      role: "assistant",
      parts: [text("Rolling it out now."), toolCall("run_command", '{"command":"deploy --blue"}')],
    }),
  ].join("\n"),
  ".agents/sessions/ses_other.session.jsonl": [
    line({ id: "t1", role: "user", parts: [text("The cache layer uses Redis.")] }),
    line({ id: "t2", role: "assistant", parts: [text("The cache stays in Redis for sub-millisecond reads.")] }),
  ].join("\n"),
  ".agents/sessions/ses_current.session.jsonl": [
    line({ id: "c1", role: "user", parts: [text("The secret token rotates daily.")] }),
  ].join("\n"),
  // A large session: one over-long message (per-message cap) plus enough text to spill the page.
  ".agents/sessions/ses_big.session.jsonl": [
    line({ id: "b1", role: "user", parts: [text(`START ${"A".repeat(20000)} END`)] }),
    line({ id: "b2", role: "assistant", parts: [text("B".repeat(6000))] }),
    line({ id: "b3", role: "assistant", parts: [text("C".repeat(6000))] }),
  ].join("\n"),
  // A compact archive that duplicates session-log content — it must NOT be searched (the log is
  // the complete source; the archive is a derived, lower-fidelity copy).
  ".agents/transcripts/ses_old/compact-1.md": ["# Compaction", "ARCHIVE_ONLY_TOKEN blue-green."].join("\n"),
  // A compacted session: SURFACE_PROBE before the summary is `shadowed`, after is `current`.
  // Timestamps let the time-window filter be exercised.
  ".agents/sessions/ses_compacted.session.jsonl": [
    line({ id: "p1", role: "user", parts: [text("SURFACE_PROBE early note")], updatedAt: 1000 }),
    line({
      id: "p2",
      role: "user",
      parts: [text("[CONVERSATION SUMMARY]\nrolled up earlier turns")],
      updatedAt: 2000,
    }),
    line({ id: "p3", role: "user", parts: [text("SURFACE_PROBE recent note")], updatedAt: 3000 }),
  ].join("\n"),
  // An oversized log. The contents are SMALL on purpose: only `stat` reports it over the limit, so
  // the read gate is pinned without allocating megabytes — and the marker text proves the file was
  // never folded.
  [OVERSIZE_LOG]: [line({ id: "xo1", role: "user", parts: [text("SHOULD_NEVER_BE_FOLDED")] })].join("\n"),
};

function readdirOf(dir) {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  const seen = new Map();
  for (const path of Object.keys(FILES)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) seen.set(rest, "file");
    else seen.set(rest.slice(0, slash), "directory");
  }
  return [...seen.entries()].map(([name, type]) => ({ name, type }));
}

registerCoreEnv({
  rootPath: "/tmp/session-search-ws",
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => "/tmp",
  fs: {
    exists: async (path) => path in FILES || readdirOf(path).length > 0,
    readdir: async (path) => readdirOf(path),
    stat: async (path) => ({
      isDirectory: readdirOf(path).length > 0,
      isFile: path in FILES,
      // `OVERSIZE_LOG` reports over the read limit despite its small contents — see FILES.
      size: path === OVERSIZE_LOG ? MAX_SESSION_FILE_BYTES + 1 : path in FILES ? FILES[path].length : 0,
      mtime: new Date(0),
    }),
    readFile: async (path) => {
      if (!(path in FILES)) throw new Error(`no such file: ${path}`);
      return FILES[path];
    },
    // Writes are only expected for the tool-output spill (.agents/cache/tool-output/); the
    // session logs and transcripts are never written (asserted structurally in section 7).
    writeFile: async (path, content) => {
      FILES[path] = String(content);
    },
    mkdir: async () => {},
    remove: async (path) => {
      delete FILES[path];
    },
  },
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => new Response(""),
});

try {
  // ==========================================================================
  // 1. Enumeration + parsing
  // ==========================================================================
  {
    const ids = await listSessionIds(getEnv());
    assert.deepEqual(
      ids.sort(),
      ["ses_big", "ses_compacted", "ses_current", "ses_old", "ses_other", "ses_oversize"],
      "all session logs enumerated"
    );

    const messages = await readSessionMessages(getEnv(), "ses_old");
    assert.equal(messages.length, 3, "every message of the session is read");
    assert.equal(messages[0].role, "user");
    assert.match(messages[0].text, /blue-green/, "user message text is extracted from its parts");
    assert.equal(messages[2].toolSummary, 'run_command({"command":"deploy --blue"})', "tool calls render as a summary");
    assert.equal(await sessionExists(getEnv(), "ses_old"), true);
    assert.equal(await sessionExists(getEnv(), "nope"), false);
  }

  // ==========================================================================
  // 2. Search reads the session log (the complete conversation); hits are parsed
  // ==========================================================================
  {
    const result = await searchHistory(getEnv(), { query: "blue-green", limit: 10 });
    assert.ok(result.matches.length >= 1, "a session-log match is returned");
    const match = result.matches[0];
    assert.equal(match.sessionId, "ses_old");
    assert.equal(typeof match.role, "string");
    assert.equal(typeof match.messageIndex, "number");
    assert.match(match.snippet, /blue-green/);
    assert.ok(!match.snippet.includes('"parts"'), "a session hit is parsed, never raw JSON");

    // The compact archive (a derived duplicate) is NOT a search source: a token only it carries
    // must not surface — the session log is the single, complete source.
    const archiveOnly = await searchHistory(getEnv(), { query: "ARCHIVE_ONLY_TOKEN", limit: 10 });
    assert.equal(archiveOnly.total, 0, "compact archives are not searched (the session log is complete)");
  }

  // ==========================================================================
  // 2b. Surface: shadowed (before the summary) vs current (after)
  // ==========================================================================
  {
    const result = await searchHistory(getEnv(), { query: "SURFACE_PROBE", limit: 10, sessionId: "ses_compacted" });
    assert.deepEqual(
      result.matches.map((m) => m.surface).sort(),
      ["current", "shadowed"],
      "a match before the summary is shadowed, after it is current"
    );

    // A session that never compacted is all-current.
    const noSummary = await searchHistory(getEnv(), { query: "blue-green", limit: 10, sessionId: "ses_old" });
    assert.ok(noSummary.matches.length > 0);
    assert.ok(
      noSummary.matches.every((m) => m.surface === "current"),
      "without a compaction summary every match is current"
    );

    // Time window: only the recent note (updatedAt 3000) survives `since: 2500`.
    const windowed = await searchHistory(getEnv(), {
      query: "SURFACE_PROBE",
      limit: 10,
      sessionId: "ses_compacted",
      since: 2500,
    });
    assert.equal(windowed.total, 1, "the time window narrows matches");
    assert.equal(windowed.matches[0].timestamp, 3000);

    const until = await searchHistory(getEnv(), {
      query: "SURFACE_PROBE",
      limit: 10,
      sessionId: "ses_compacted",
      until: 1500,
    });
    assert.equal(until.total, 1, "until keeps only earlier matches");
    assert.equal(until.matches[0].surface, "shadowed");
  }

  // ==========================================================================
  // 3. Current session excluded by default, re-included explicitly
  // ==========================================================================
  {
    const excluded = await searchHistory(getEnv(), {
      query: "secret token",
      limit: 10,
      excludeSessionId: "ses_current",
    });
    assert.equal(excluded.total, 0, "the current session is not searched by default");

    const included = await searchHistory(getEnv(), { query: "secret token", limit: 10, sessionId: "ses_current" });
    assert.equal(included.total, 1, "an explicit sessionId searches the current session");
    assert.equal(included.matches[0].sessionId, "ses_current");
  }

  // ==========================================================================
  // 4. Role filter
  // ==========================================================================
  {
    const both = await searchHistory(getEnv(), { query: "redis", limit: 10 });
    assert.equal(both.total, 2, "both user and assistant messages match by default");
    const userOnly = await searchHistory(getEnv(), { query: "redis", limit: 10, role: "user" });
    assert.equal(userOnly.total, 1, "the role filter narrows to user messages");
    assert.equal(userOnly.matches[0].role, "user");
  }

  // ==========================================================================
  // 5. Bounding: a limit withholds the rest
  // ==========================================================================
  {
    const result = await searchHistory(getEnv(), { query: "cache", limit: 1 });
    assert.equal(result.matches.length, 1, "at most `limit` matches are returned");
    assert.ok(result.total >= 2, "the total counts matches beyond the limit");
  }
  assert.match(
    makeSnippet(`${"x".repeat(200)} needle ${"y".repeat(200)}`, "needle", 100),
    /^….*needle.*…$/s,
    "a long snippet is windowed around the match"
  );

  // ==========================================================================
  // 6. The tools: exclusion, pagination, unknown id
  // ==========================================================================
  {
    const searchTool = createSessionSearchTool({ managed: { getSessionData: () => ({ id: "ses_current" }) } });
    const managedResult = await searchTool.execute(
      { query: "secret token", limit: 10 },
      { toolCallId: "s1", context: {} }
    );
    assert.equal(managedResult.total, 0, "the tool excludes the live session (from `managed`)");
    assert.equal(managedResult.returned, 0);

    const bounded = await searchTool.execute({ query: "cache", limit: 1 }, { toolCallId: "s2", context: {} });
    assert.equal(bounded.returned, 1);
    assert.ok(bounded.withheld >= 1, "withheld is reported when the limit cuts results");

    const readTool = createSessionReadTool();
    const page = await readTool.execute({ sessionId: "ses_old", offset: 0, limit: 2 }, { toolCallId: "r1" });
    assert.equal(page.returned, 2);
    assert.equal(page.total, 3);
    assert.equal(page.hasMore, true, "a partial page reports more messages");
    const lastPage = await readTool.execute({ sessionId: "ses_old", offset: 2, limit: 2 }, { toolCallId: "r2" });
    assert.equal(lastPage.returned, 1);
    assert.equal(lastPage.hasMore, false);

    // A large session: an over-long message is truncated, and the rendered page spills to disk so
    // the model gets a bounded preview + a path (the `cachedOutputPath` contract).
    const big = await readTool.execute({ sessionId: "ses_big" }, { toolCallId: "r3" });
    assert.ok(big.messages[0].text.length < 20000, "an over-long message is truncated");
    assert.match(big.messages[0].text, /\[truncated/, "the truncation is marked");
    assert.equal(typeof big.cachedOutputPath, "string", "a large page spills to a cache file");
    assert.match(big.cachedOutputPath, /\.agents\/cache\/tool-output\//);
    assert.match(big.content, /Full output saved to:/, "the model gets a preview naming the cached file");

    await assert.rejects(
      () => readTool.execute({ sessionId: "nope" }, { toolCallId: "r3" }),
      (error) => error.name === "FileError" && /nope/.test(error.message),
      "an unknown session id fails with a clear error"
    );

    // The READ is gated, not only the rendered page: `session_read` folds the whole log, so an
    // oversized one is refused before it is materialized (the same pre-read `stat.size` gate
    // `read_file` uses), and the message names the alternative. Search skips it rather than failing,
    // so the session is not lost.
    await assert.rejects(
      () => readTool.execute({ sessionId: "ses_oversize" }, { toolCallId: "r4" }),
      (error) => /too large to read/.test(error.message) && /session_search/.test(error.message),
      "an oversized session log is refused before it is folded, naming the alternative"
    );
    const skipped = await searchHistory(getEnv(), { query: "SHOULD_NEVER_BE_FOLDED", limit: 10 });
    assert.equal(skipped.matches.length, 0, "search skips an oversized log instead of failing");
  }

  // ==========================================================================
  // 7. Root-only + read-only
  // ==========================================================================
  {
    const subagentNames = createTanStackSubagentTools().map((tool) => tool.name);
    assert.ok(!subagentNames.includes("session_search"), "subagents do not get session_search");
    assert.ok(!subagentNames.includes("session_read"), "subagents do not get session_read");

    for (const file of ["session-search-tool.ts", "session-read-tool.ts", "session-search/session-reader.ts"]) {
      const source = readFileSync(`${SRC}/agent/tools/${file}`, "utf8");
      assert.ok(!/\.writeFile\(|\.mkdir\(|\.remove\(/.test(source), `${file} performs no filesystem write`);
    }
  }

  // ==========================================================================
  // 8. Guidance no longer describes the stale format
  // ==========================================================================
  {
    const guidance = readFileSync(`${SRC}/agent/turn-context/session-retrieval.ts`, "utf8");
    assert.ok(!/single long JSON line/.test(guidance), "the stale 'single long JSON line' claim is gone");
    assert.ok(!/\*\.session\.json`/.test(guidance), "the legacy `.session.json` glob is gone");
    assert.ok(/SESSION_LOG_SUFFIX/.test(guidance), "the guidance reads the real suffix from the persistence module");
    assert.ok(/session_search/.test(guidance), "the guidance names the retrieval tool");
  }
} finally {
  clearCoreEnv();
}

console.log("session-search validation passed");
