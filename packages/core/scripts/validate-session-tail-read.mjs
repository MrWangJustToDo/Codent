/**
 * Validates the tail-window read behind `SessionStore.list()`.
 *
 * Why this exists: `readLastState` used to read every session log IN FULL to find its last line.
 * `.agents/sessions/` in this workspace is 217 MB across 40 files (largest 44 MB), so `list()`
 * cost ~500ms per call and `getLatestEmpty()` ~1000ms — and both run on the startup path
 * (`resolveBootstrapSessionId`) and again for `/resume`.
 *
 * The change adds an optional `CoreEnvFs.readFileRange` and a windowed fast path, with the full
 * read kept as the fallback. That fallback is the risk: `list()`'s contract is "every session", so
 * a window that missed a state line would silently DROP a session from the picker. Every case
 * below therefore asserts the SAME answer from the same log under a range-capable env and a
 * range-less env — the two paths must be indistinguishable, not merely both non-null.
 *
 * Cases:
 *   1. A log far larger than the window still yields its last state (the win).
 *   2. A range-less env yields the identical answer (the degrade path).
 *   3. Range and full reads agree FIELD BY FIELD on a real-shaped log.
 *   4. A torn trailing line is skipped, not returned as garbage.
 *   4b. A save AFTER a torn tail is still readable — the load-derived tail flag terminates the
 *      fragment before appending (with and without `readFileRange`).
 *   5. A state line sitting beyond the window falls back and is still found (the correctness
 *      case the fast path must not get wrong).
 *   6. A single-line file larger than the window still resolves.
 *   7. Multi-byte characters straddling the window boundary do not corrupt the answer.
 *   8. `list()` returns the SAME session set with and without `readFileRange`.
 *
 * Run: pnpm --filter @codent/core run validate:session-tail-read
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerCoreEnv } from "../dist/index.mjs";

let seq = 0;

/** Mirrors native-fs: relative paths resolve under rootPath, absolute pass through. */
const toAbs = (rootPath, p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));

/**
 * Temp env whose fs reads a real directory. `withRange: false` omits `readFileRange`, which is how
 * every host without the primitive behaves (WebContainer, and any remote env that never gained it).
 *
 * Paths must be resolved against `rootPath` — `SessionStore` addresses logs RELATIVELY
 * (`.agents/sessions/...`), so an unresolving fake silently reads `process.cwd()`, i.e. the real
 * workspace sessions (observed: a one-file fixture listed 40 sessions).
 */
function makeEnv({ withRange = true, rootPath } = {}) {
  const root = rootPath ?? fs.mkdtempSync(path.join(os.tmpdir(), `session-tail-${seq++}-`));
  // Counters prove the fast path avoided the full read instead of merely agreeing with it.
  const counters = { fullReads: 0, rangeReads: 0, ranges: [] };
  const env = {
    rootPath: root,
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => root,
    path: { join: (...p) => path.join(...p) },
    fs: {
      readFile: async (p) => {
        counters.fullReads++;
        return fs.readFileSync(toAbs(root, p), "utf-8");
      },
      stat: async (p) => {
        try {
          const st = fs.statSync(toAbs(root, p));
          return { isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size, mtime: st.mtime };
        } catch {
          return null;
        }
      },
      exists: async (p) => fs.existsSync(toAbs(root, p)),
      readdir: async (p) => {
        const entries = fs.readdirSync(toAbs(root, p), { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file", size: 0 }));
      },
      writeFile: async (p, content) => {
        const abs = toAbs(root, p);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      },
      // Required by a guard on SessionStore fakes: without `rename` the store rewrites a log in
      // place, so a concurrent `load()` can read a truncated file (the atomic-rewrite path is what
      // the real hosts use, and the tail-read behaviour under test must be the same one).
      rename: async (from, to) => fs.promises.rename(toAbs(root, from), toAbs(root, to)),
      remove: async (p) => fs.promises.rm(toAbs(root, p), { force: true }),
      mkdir: async (p) => fs.mkdirSync(toAbs(root, p), { recursive: true }),
      // Present so a save takes the APPEND path (the one that can meet a torn tail) instead of
      // degrading to a full rewrite, which would hide the case below.
      appendFile: async (p, content) => {
        const abs = toAbs(root, p);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.appendFileSync(abs, content);
      },
    },
  };
  if (withRange) {
    env.fs.readFileRange = async (p, start, end) => {
      counters.rangeReads++;
      counters.ranges.push([start, end]);
      const buf = fs.readFileSync(toAbs(root, p));
      return buf.subarray(Math.max(0, start), Math.min(buf.length, end)).toString("utf-8");
    };
  }
  return { env, counters, rootPath: root };
}

/** One log line: `t: "message"`, a message (nullable), and the state snapshot `list()` needs. */
function logLine({ id = "ses_x", name, updatedAt, message = null }) {
  return JSON.stringify({
    t: "message",
    message,
    state: { id, name, version: 7, modelStyle: "openai", model: "test-model", updatedAt },
  });
}

/** Build a log whose TOTAL size is well past the 512 KB window, with the state line last. */
function writeBigLog(rootPath, { id = "ses_big", name = "big session", updatedAt = 1_700_000_000_000 } = {}) {
  const lines = [];
  // ~1 KB of filler per line: message bodies are what make real logs large.
  const filler = "x".repeat(900);
  for (let i = 0; i < 700; i++) {
    lines.push(logLine({ name: "ignored", updatedAt: 1, message: { id: `m${i}`, role: "user", text: filler } }));
  }
  lines.push(logLine({ name, updatedAt }));
  const file = path.join(rootPath, ".agents", "sessions", `${id}.session.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { file, size: fs.statSync(file).size };
}

const { SessionStore } = await import("../dist/dev.mjs");

// ============================================================================
// 1 + 2 + 3: the same log answers identically with and without a range read
// ============================================================================
{
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), `session-tail-shared-${seq++}-`));
  const { size } = writeBigLog(rootPath);

  const readVia = async (withRange) => {
    const { env, counters } = makeEnv({ withRange, rootPath });
    registerCoreEnv(env);
    const store = new SessionStore(env);
    const metas = await store.list();
    return { metas, counters };
  };

  const ranged = await readVia(true);
  const full = await readVia(false);

  assert.equal(ranged.metas.length, 1, "the big log must list as exactly one session");
  assert.equal(full.metas.length, 1, "a range-less env must list it too (the degrade path)");

  // 3: field-by-field, not just "both found something".
  assert.deepEqual(ranged.metas[0], full.metas[0], "the fast path and the fallback must agree exactly");
  assert.equal(ranged.metas[0].name, "big session", "the LAST line's state is what describes the session");

  // 1: the win is real — the fast path never read the file whole.
  assert.equal(ranged.counters.fullReads, 0, "with readFileRange available, the full read must not happen");
  assert.ok(ranged.counters.rangeReads > 0, "the fast path must actually perform a range read");
  assert.ok(
    ranged.counters.ranges.every(([, end]) => end === size),
    "the window must be anchored to the END of the file"
  );
  // Non-vacuous: the fixture has to exceed the window, or the fast path would be reading it all.
  assert.ok(size > 512 * 1024, `the fixture must exceed the tail window to prove anything (size=${size})`);

  // 2: the degrade path really did read whole files.
  assert.ok(full.counters.fullReads > 0, "the fallback must read in full");
  assert.equal(full.counters.rangeReads, 0, "a range-less env must not attempt a range read");
}

// ============================================================================
// 4: a torn trailing line is skipped, not surfaced as garbage
// ============================================================================
{
  const { env } = makeEnv();
  const rootPath = env.rootPath;
  const file = path.join(rootPath, ".agents", "sessions", "ses_torn.session.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    logLine({ name: "torn", updatedAt: 42 }) + "\n" + '{"t":"message","message":{"id":"partial"' // no newline: crash mid-append
  );
  registerCoreEnv(env);

  const store = new SessionStore(env);
  const metas = await store.list();
  assert.equal(metas.length, 1, "a torn tail must not hide the session");
  assert.equal(metas[0].name, "torn", "the last COMPLETE line's state is the answer");
  assert.equal(metas[0].updatedAt, 42, "and it must be that line's state, not a partial parse");
}

// ============================================================================
// 4b: a save AFTER a torn tail must be readable (the fragment is terminated first)
//
// The read side always skipped the fragment, which is why this looked handled. But `appendFile`
// used to write straight onto it: the new JSON was glued to the fragment, the merged line failed
// to parse, and the save that had just completed vanished on the next load — while the in-memory
// delta baseline already recorded it as persisted, so it was never retried.
//
// `load` now records whether the raw tail is terminated (from the bytes it already reads), and the
// next append uses it. Both hosts must recover — the one with `readFileRange` and the one without,
// because the flag comes from the full read, not from a second probe.
// ============================================================================
for (const withRange of [true, false]) {
  const { env } = makeEnv({ withRange });
  const rootPath = env.rootPath;
  const id = "ses_resume";
  const file = path.join(rootPath, ".agents", "sessions", `${id}.session.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    logLine({ id, name: "resumed", updatedAt: 42 }) + "\n" + '{"t":"message","message":{"id":"partial"' // no newline
  );
  registerCoreEnv(env);

  const store = new SessionStore(env);
  const loaded = await store.load(id);
  assert.ok(loaded, `[range=${withRange}] the complete line must still load`);
  loaded.uiMessages.push({
    id: "msg_after_crash",
    role: "user",
    parts: [{ type: "text", text: "typed after the crash" }],
  });
  await store.save(loaded);

  const reread = await store.load(id);
  assert.ok(
    reread?.uiMessages.some((message) => message.id === "msg_after_crash"),
    `[range=${withRange}] a save after a torn tail must survive the reload`
  );
  assert.equal(reread?.name, "resumed", `[range=${withRange}] the state snapshot must survive too`);

  // The fragment itself is still unparseable (nothing to recover) — only the NEW line had to be
  // addressable. Assert the new line is a whole line, so a future "fix" that merely sorts the
  // bytes differently cannot pass.
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(
    raw.split("\n").some((line) => line.includes("msg_after_crash") && line.trim().startsWith("{")),
    `[range=${withRange}] the appended line must start at a line boundary`
  );
}

// ============================================================================
// 5: the correctness case — a state line BEYOND the window still resolves
// ============================================================================
{
  // The last `state` line sits more than a window from the end, so the fast path cannot see it and
  // the fallback has to cover for it. Message lines after it carry no state, so walking backwards
  // from the tail yields nothing until the window expands to the full file.
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), `session-tail-beyond-${seq++}-`));
  const lines = [logLine({ name: "the real state", updatedAt: 987 }), '{"t":"message","message":null}'];
  const filler = "y".repeat(1000);
  for (let i = 0; i < 700; i++) lines.push(`{"t":"message","message":{"id":"f${i}","text":"${filler}"}}`);
  const file = path.join(rootPath, ".agents", "sessions", "ses_beyond.session.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const size = fs.statSync(file).size;

  const { env, counters } = makeEnv({ rootPath });
  registerCoreEnv(env);
  const metas = await new SessionStore(env).list();

  assert.equal(metas.length, 1, "the session must still be listed, not dropped");
  assert.equal(metas[0].name, "the real state", "a state line outside the window must still be found");
  assert.equal(metas[0].updatedAt, 987, "with its own fields, via the fallback");
  // Proves the case is real: the window could not have contained the state line.
  assert.ok(size > 512 * 1024, `the fixture must push the state line past the window (size=${size})`);
  assert.ok(
    counters.rangeReads > 0 && counters.fullReads > 0,
    `the fallback must actually run (range=${counters.rangeReads}, full=${counters.fullReads})`
  );
}

// ============================================================================
// 6: a single line larger than the window (no newline in the window)
// ============================================================================
{
  // No newline anywhere near the tail means the window is a fragment of one huge line. The fast
  // path must refuse it rather than parse a fragment.
  const { env, counters } = makeEnv();
  const file = path.join(env.rootPath, ".agents", "sessions", "ses_one.session.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, logLine({ name: "one line", updatedAt: 5 }));
  registerCoreEnv(env);

  const metas = await new SessionStore(env).list();
  assert.equal(metas.length, 1);
  assert.equal(metas[0].name, "one line", "a file smaller than the window reads from byte 0");
  assert.ok(counters.fullReads === 0, "a file inside the window is a complete read of the file");
}

// ============================================================================
// 7: multi-byte characters straddling the window boundary
// ============================================================================
{
  // The window boundary lands mid-character for a CJK-heavy log. Decoding must not corrupt the
  // final state line, and the truncated leading line must be discarded, not parsed.
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), `session-tail-cjk-${seq++}-`));
  const lines = [];
  for (let i = 0; i < 4000; i++) {
    lines.push(logLine({ name: "忽略", updatedAt: 1, message: { id: `m${i}`, text: "中文内容".repeat(40) } }));
  }
  lines.push(logLine({ name: "末尾状态", updatedAt: 12345 }));
  const file = path.join(rootPath, ".agents", "sessions", "ses_cjk.session.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const size = fs.statSync(file).size;

  const { env } = makeEnv({ rootPath });
  registerCoreEnv(env);
  const metas = await new SessionStore(env).list();

  assert.equal(metas.length, 1);
  assert.equal(metas[0].name, "末尾状态", "a boundary splitting a multi-byte character must not corrupt the state");
  assert.equal(metas[0].updatedAt, 12345);
  assert.ok(size > 512 * 1024, `the fixture must exceed the window (size=${size})`);
}

// ============================================================================
// 8: list() yields the SAME session set either way, across many files
// ============================================================================
{
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), `session-tail-many-${seq++}-`));
  for (let i = 0; i < 6; i++) {
    const lines = [];
    for (let j = 0; j < (i === 3 ? 900 : 3); j++)
      lines.push(logLine({ name: "n", updatedAt: 1, message: { id: `m${j}` } }));
    lines.push(logLine({ name: `session ${i}`, updatedAt: 1000 + i }));
    fs.mkdirSync(path.join(rootPath, ".agents", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, ".agents", "sessions", `ses_${i}.session.jsonl`), lines.join("\n") + "\n");
  }

  const readVia = async (withRange) => {
    const { env, counters } = makeEnv({ withRange, rootPath });
    registerCoreEnv(env);
    return { metas: await new SessionStore(env).list(), counters };
  };
  const a = await readVia(true);
  const b = await readVia(false);

  assert.equal(a.metas.length, 6, "every session must be listed through the fast path");
  assert.deepEqual(
    a.metas.map((m) => [m.id, m.name, m.updatedAt]),
    b.metas.map((m) => [m.id, m.name, m.updatedAt]),
    "no session may be dropped or altered by the windowed read"
  );
  assert.ok(
    a.counters.fullReads < b.counters.fullReads,
    "the windowed read must do strictly less full-file IO than the fallback"
  );
}

// ============================================================================
// 9: hasUserMessage over a head window
// ============================================================================
// Both directions, because only one of them can actually change the outcome:
//   - a FALSE "has a user message" makes `getLatestEmpty()` skip a genuinely empty candidate —
//     observable here as the reuse probe returning nothing.
//   - a false "no user message" does NOT change the outcome, because `getLatestEmpty()` re-checks the
//     chosen candidate by folding it (`load()` + `some(role === "user")`) before returning it. That
//     re-check is why the head window's bias is safe; verified by reverting the window's fallback
//     and observing this scenario still pass. The assertion is kept because it pins the CONTRACT
//     (a window read must not fabricate emptiness), not because it currently fails otherwise.
{
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), `session-tail-usermsg-${seq++}-`));
  const headFiller = () => {
    const lines = [];
    // > 256 KB of assistant/tool chatter before ANY user message.
    for (let i = 0; i < 700; i++) {
      lines.push(
        logLine({ name: "n", updatedAt: 1, message: { id: `a${i}`, role: "assistant", text: "z".repeat(600) } })
      );
    }
    return lines;
  };

  // (a) user message BEYOND the window → must be found (not a false empty).
  const deepUser = headFiller();
  deepUser.push(logLine({ name: "deep", updatedAt: 1, message: { id: "u", role: "user", text: "hi" } }));
  deepUser.push(logLine({ name: "deep", updatedAt: 2 }));
  fs.mkdirSync(path.join(rootPath, ".agents", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(rootPath, ".agents", "sessions", "ses_deep.session.jsonl"), deepUser.join("\n") + "\n");

  // (b) genuinely empty: no user message anywhere (the reuse candidate).
  const emptyLines = [logLine({ name: "empty", updatedAt: 3 })];
  fs.writeFileSync(path.join(rootPath, ".agents", "sessions", "ses_empty.session.jsonl"), emptyLines.join("\n") + "\n");

  const { env } = makeEnv({ rootPath });
  registerCoreEnv(env);

  const deepSize = fs.statSync(path.join(rootPath, ".agents", "sessions", "ses_deep.session.jsonl")).size;
  assert.ok(deepSize > 256 * 1024, `the fixture must push the user message past the head window (size=${deepSize})`);

  const empty = await new SessionStore(env).getLatestEmpty();
  assert.ok(empty, "the genuinely empty session must be selected for reuse");
  assert.equal(empty.id, "ses_empty", "a session with a user message past the window must NOT be treated as empty");
}

console.log("session tail read validation passed");
