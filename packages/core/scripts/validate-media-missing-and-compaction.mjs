/**
 * Validates the read-side media diagnostics + compaction terminal-channel fixes:
 * 1. `hydrateUIMessages` reports every un-hydratable `media://` ref via `onMissing`
 *    (missing file or malformed ref), for both content parts and tool results.
 * 2. `restoreManagedSession` forwards those reports into the `session:restore`
 *    payload as `mediaMissing` (read-side dual of `session:save-error`).
 * 3. Terminal compaction results (auto-complete/error, reactive-complete/error/
 *    max-retries) project onto the `lifecycle` channel so the numbers / give-up
 *    state stop being log-only.
 *
 * Run: pnpm --filter @codent/core run validate:media-missing-and-compaction
 */

import assert from "node:assert/strict";
import path from "node:path";

import {
  AGENT_EVENT_META,
  clearCoreEnv,
  hydrateUIMessages,
  registerCoreEnv,
  getEnv,
  restoreManagedSession,
} from "../dist/dev.mjs";

// ============================================================================
// Mock CoreEnv (in-memory file system)
// ============================================================================

const inMemoryFs = new Map();

function setupMockEnv() {
  clearCoreEnv();
  inMemoryFs.clear();
  registerCoreEnv({
    rootPath: "/mock",
    getPlatform: () => Promise.resolve("linux"),
    getArch: () => Promise.resolve("arm64"),
    getEnv: () => Promise.resolve({}),
    homedir: () => Promise.resolve("/mock"),
    path: {
      join: (...parts) => parts.join("/"),
      dirname: (p) => path.dirname(p),
      basename: (p, ext) => path.basename(p, ext),
      extname: (p) => path.extname(p),
      resolve: (...parts) => path.posix.resolve(...parts),
      normalize: (p) => path.posix.normalize(p),
      isAbsolute: (p) => path.posix.isAbsolute(p),
      getSep: () => "/",
      parse: (p) => path.posix.parse(p),
    },
    fs: {
      async readFile(p) {
        const content = inMemoryFs.get(p);
        if (content === undefined) throw new Error(`ENOENT: ${p}`);
        return content;
      },
      async writeFile(p, content) {
        inMemoryFs.set(p, content);
      },
      async mkdir(p) {
        inMemoryFs.set(p, "__dir__");
      },
      async exists(p) {
        return inMemoryFs.has(p);
      },
      async stat(p) {
        const entry = inMemoryFs.get(p);
        if (entry === undefined) throw new Error(`ENOENT: ${p}`);
        return { isDirectory: entry === "__dir__", isFile: entry !== "__dir__", size: 0, mtime: new Date() };
      },
      async readdir() {
        return [];
      },
      async remove(p) {
        inMemoryFs.delete(p);
      },
    },
    runCommand: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    exec: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    fetch: () => Promise.resolve(new Response()),
  });
}

function makeMessage(parts) {
  return { id: "m1", role: "user", parts, content: "", createdAt: new Date() };
}

function fakeUsage() {
  return {
    reset: () => {},
    addTotal: () => {},
    updateWindowUsage: () => {},
    setTotalCostUsd: () => {},
    getTotal: () => ({ inputTokens: 0, outputTokens: 0 }),
    getTotalCostUsd: () => 0,
    getWindowUsage: () => ({ inputTokens: 0 }),
    getContextFillTokens: () => 0,
  };
}

// ============================================================================
// 1. Compaction terminal events project onto `lifecycle`
// ============================================================================

for (const type of [
  "compaction:auto-complete",
  "compaction:auto-error",
  "compaction:reactive-complete",
  "compaction:reactive-error",
  "compaction:reactive-max-retries",
]) {
  assert.equal(AGENT_EVENT_META[type]?.channel, "lifecycle", `${type} must project onto lifecycle`);
}
// In-flight starts stay channel-less (status "compacting" already covers them).
for (const type of ["compaction:auto-start", "compaction:reactive-start"]) {
  assert.equal(AGENT_EVENT_META[type]?.channel, undefined, `${type} must stay channel-less`);
}

// ============================================================================
// 2. hydrateUIMessages reports missing / malformed refs
// ============================================================================

async function testHydrateReportsMisses() {
  setupMockEnv();
  const missingFileRef = { type: "image", source: { type: "url", value: "media://gone.png" }, metadata: {} };
  const malformedRef = { type: "image", source: { type: "url", value: "media://nope" }, metadata: {} };
  const toolResult = {
    type: "tool-result",
    content: JSON.stringify([{ type: "image", source: { type: "url", value: "media://tool-gone.png" }, metadata: {} }]),
  };

  const misses = [];
  await hydrateUIMessages([makeMessage([missingFileRef, malformedRef, toolResult])], {
    env: getEnv(),
    onMissing: (miss) => misses.push(miss),
  });

  assert.deepEqual(
    misses.map((m) => [m.path, m.reason]),
    [
      ["content", "not-found"],
      ["content", "invalid-ref"],
      ["tool-result", "not-found"],
    ]
  );
  assert.equal(misses[0].ref, "media://gone.png");

  // Hydration must stay non-throwing even when every ref is gone.
  const again = [];
  await hydrateUIMessages([makeMessage([missingFileRef])], {
    env: getEnv(),
    onMissing: (miss) => again.push(miss),
  });
  assert.equal(again.length, 1);

  // No hook → no crash (back-compat for existing callers).
  await hydrateUIMessages([makeMessage([missingFileRef])], { env: getEnv() });

  console.log("  ✓ hydrateUIMessages reports missing / malformed media refs");
}

// ============================================================================
// 3. restoreManagedSession surfaces the miss count on `session:restore`
// ============================================================================

async function testRestoreReportsMediaMissing() {
  const events = [];
  const missCounts = [];
  const restored = { id: "ses_m", name: "Media Session", uiMessages: [], approvals: [] };

  await restoreManagedSession(
    {
      toolCompactCache: { clear: () => {} },
      session: {
        restoreFromStore: async (_id, input) => {
          input.onMissingMedia?.({ ref: "media://a.png", reason: "not-found", path: "content" });
          input.onMissingMedia?.({ ref: "media://b.png", reason: "not-found", path: "tool-result" });
          return restored;
        },
      },
      usage: fakeUsage(),
      getTodoManager: () => null,
      planMode: { restoreState: () => {}, getPhase: () => "off", getState: () => null },
      setAutoModeEnabled: () => {},
      isAutoModeEnabled: () => false,
      approvals: { restore: () => {} },
      getUI: () => ({ setMessages: () => {} }),
      clearQueuedMessages: () => {},
      syncInteractionStateFromUIMessages: () => {},
      emitEvent: (type, payload) => events.push({ type, payload }),
      setDisplayName: () => {},
      setMediaHydrationMisses: (count) => missCounts.push(count),
    },
    "ses_m"
  );

  const restore = events.find((e) => e.type === "session:restore");
  assert.ok(restore, "session:restore must be emitted");
  assert.equal(restore.payload.mediaMissing, 2, "miss count must surface on the payload");
  // The count is not only a diagnostic: it arms the wire seam that substitutes a text placeholder
  // for a `media://` ref no provider can fetch (`wire-recovery` + `hasUnhydratedMedia`).
  assert.deepEqual(missCounts, [2], "the restore must arm the wire fallback with the miss count");

  // No misses → field omitted (keeps the common log line unchanged).
  const clean = [];
  const cleanMissCounts = [];
  await restoreManagedSession(
    {
      toolCompactCache: { clear: () => {} },
      session: { restoreFromStore: async () => restored },
      usage: fakeUsage(),
      getTodoManager: () => null,
      planMode: { restoreState: () => {}, getPhase: () => "off", getState: () => null },
      setAutoModeEnabled: () => {},
      isAutoModeEnabled: () => false,
      approvals: { restore: () => {} },
      getUI: () => ({ setMessages: () => {} }),
      clearQueuedMessages: () => {},
      syncInteractionStateFromUIMessages: () => {},
      emitEvent: (type, payload) => clean.push({ type, payload }),
      setDisplayName: () => {},
      setMediaHydrationMisses: (count) => cleanMissCounts.push(count),
    },
    "ses_m"
  );
  const cleanRestore = clean.find((e) => e.type === "session:restore");
  assert.equal("mediaMissing" in cleanRestore.payload, false);
  // A clean restore clears the flag, so the wire seam keeps its zero-overhead path.
  assert.deepEqual(cleanMissCounts, [0], "a clean restore must clear the wire fallback");

  console.log("  ✓ restoreManagedSession surfaces mediaMissing on session:restore");
}

async function main() {
  await testHydrateReportsMisses();
  await testRestoreReportsMediaMissing();
  clearCoreEnv();
  console.log("media-missing-and-compaction validation passed");
}

await main();
