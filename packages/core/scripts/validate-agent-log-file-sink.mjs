/**
 * Validates AgentLog.attachFileSink: JSONL writes, retention of pre-attach
 * entries (bounded, drained on attach), the cap's overflow behavior,
 * size-based rotation, silent degradation when the env fs has no appendFile,
 * detach semantics, and serializer failures contained on the sync exit path.
 *
 * Run: pnpm --filter @codent/core run validate:agent-log-file-sink
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentLog, createLogExtension, MAX_PENDING_LOG_ENTRIES, clearCoreEnv, registerCoreEnv } from "../dist/dev.mjs";

import { waitFor } from "./helpers/log-capture.mjs";
import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Real-fs CoreEnv (stat returns true sizes so rotation is observable). */
function createEnv(rootPath, { withAppendFile }) {
  const fsImpl = {
    readFile: async (p, encoding) => fs.promises.readFile(p, encoding),
    writeFile: async (p, content) => fs.promises.writeFile(p, content),
    mkdir: async (p) => fs.promises.mkdir(p, { recursive: true }),
    exists: async (p) =>
      fs.promises.access(p).then(
        () => true,
        () => false
      ),
    readdir: async (p) => {
      try {
        const entries = await fs.promises.readdir(p, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
      } catch {
        return [];
      }
    },
    stat: async (p) => {
      const st = await fs.promises.stat(p);
      return { isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size, mtime: st.mtime };
    },
    remove: async (p) => fs.promises.rm(p, TEMP_RM_OPTIONS),
  };
  if (withAppendFile) {
    fsImpl.appendFile = async (p, content) => fs.promises.appendFile(p, content, "utf8");
    // The sync primitives are what the exit path uses; a host that has them must be modelled with
    // them, or `flushSync()` silently degrades to the async path and a sync assertion tests nothing.
    fsImpl.appendFileSync = (p, content) => fs.appendFileSync(p, content, "utf8");
    fsImpl.mkdirSync = (p) => fs.mkdirSync(p, { recursive: true });
    fsImpl.existsSync = (p) => fs.existsSync(p);
  }
  return {
    rootPath,
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => rootPath,
    fs: fsImpl,
    runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    fetch: async () => new Response(),
  };
}

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-log-file-sink-"));
registerCoreEnv(createEnv(rootPath, { withAppendFile: true }));

const logDir = path.join(rootPath, ".agents/logs/ses_test");
const filePath = path.join(logDir, "agent.log");

// ----------------------------------------------------------------------------
// 1. Pre-attach entries are retained (bounded) and drained into the first sink,
//    in emission order, exactly once. Post-attach entries persist with data +
//    error fields.
//    Regression guard: bootstrap emits before `bindSessionLogSink` attaches, so
//    dropping pre-attach entries silently lost every extension-load failure.
// ----------------------------------------------------------------------------
const log = new AgentLog();
log.info("system", "pre-attach-kept");
log.error("agent", "boom-3", new Error("test error"));

const detach = log.attachFileSink({
  dir: logDir,
  filename: "agent.log",
  maxBytes: 400,
  maxFiles: 3,
  flushIntervalMs: 20,
});

log.info("system", "hello-1");
log.warn("agent", "warn-2", { n: 2 });
log.error("agent", "boom-3", new Error("test error"));
// Poll for the flush instead of sleeping a fixed 80ms: the interval-based flush had not run
// yet on a loaded runner, which surfaced as an ENOENT reading a file that was about to exist.
const flushedLines = await waitFor(
  async () => {
    try {
      return (await fs.promises.readFile(filePath, "utf-8")).trim().split("\n");
    } catch {
      return [];
    }
  },
  (l) => l.filter(Boolean).length >= 5
);
const lines = flushedLines.filter(Boolean);
assert.equal(lines.length, 5, `pre-attach entries retained + drained, expected 5 lines, got ${lines.length}`);

// The drain precedes anything emitted after attach, so the retained bootstrap lines
// are the first thing in the file — never interleaved or reordered behind live entries.
assert.equal(JSON.parse(lines[0]).message, "pre-attach-kept", "retained entry drained first, in emission order");
assert.equal(JSON.parse(lines[0]).category, "system");
assert.equal(JSON.parse(lines[1]).message, "boom-3", "retained entries keep emission order");
assert.equal(JSON.parse(lines[1]).error?.message, "test error", "retained entry keeps its error field");
assert.equal(JSON.parse(lines[2]).message, "hello-1", "post-attach entry follows the drained ones");

const boom = JSON.parse(lines.find((l) => l.includes("boom-3") && l.includes("error")) ?? lines[1]);
assert.ok(boom.error?.message === "test error", "error field serialized as JSONL");

const warn = JSON.parse(lines.find((l) => l.includes("warn-2")));
assert.equal(warn.data.n, 2, "data object serialized");
console.log("pre-attach retention + JSONL OK:", lines.length, "lines");

// ----------------------------------------------------------------------------
// 1b. Retention is bounded and drains exactly once.
//    - Overflow past the cap keeps the newest entries and stays finite.
//    - Re-attaching must not replay already-drained entries.
// ----------------------------------------------------------------------------
{
  const capRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-log-pending-cap-"));
  const capDir = path.join(capRoot, ".agents/logs/ses_cap");
  const capFile = path.join(capDir, "agent.log");

  const capLog = new AgentLog();
  const overflow = MAX_PENDING_LOG_ENTRIES + 25;
  for (let i = 0; i < overflow; i++) capLog.info("system", `pending-${i}`);

  const capDetach = capLog.attachFileSink({ dir: capDir, filename: "agent.log", flushIntervalMs: 10 });
  const capLines = (
    await waitFor(
      async () => {
        try {
          return (await fs.promises.readFile(capFile, "utf-8")).trim().split("\n");
        } catch {
          return [];
        }
      },
      (l) => l.filter(Boolean).length >= MAX_PENDING_LOG_ENTRIES
    )
  ).filter(Boolean);

  assert.equal(
    capLines.length,
    MAX_PENDING_LOG_ENTRIES,
    `cap must bound retention to ${MAX_PENDING_LOG_ENTRIES}, got ${capLines.length}`
  );
  const first = JSON.parse(capLines[0]).message;
  const last = JSON.parse(capLines[capLines.length - 1]).message;
  assert.equal(last, `pending-${overflow - 1}`, "newest entry is retained (oldest dropped at the cap)");
  assert.equal(first, `pending-${overflow - MAX_PENDING_LOG_ENTRIES}`, "the oldest entries are the ones dropped");

  // Drain is one-shot: a second sink must not replay the first sink's entries.
  capDetach();
  const secondDetach = capLog.attachFileSink({ dir: capDir, filename: "agent.log", flushIntervalMs: 10 });
  capLog.info("system", "after-reattach");
  await capLog.flush();
  const afterReattach = (await fs.promises.readFile(capFile, "utf-8")).split("\n").filter(Boolean);
  const replayed = afterReattach.filter((l) => l.includes('pending-0"') || l.includes('pending-1"')).length;
  assert.equal(replayed, 0, "drained entries are not replayed by a later attach");
  assert.equal(afterReattach.filter((l) => l.includes("after-reattach")).length, 1, "post-reattach entry written once");
  secondDetach();

  // A *late* call on a superseded handle must not unbind the live sink. Both handles come from
  // `attachFileSink`, whose detach is conditional on the sink still being the active one — without
  // that guard the stale call clears the seam and every later entry is neither written nor
  // retained (verified by unguarding `detachSink` and watching this assertion fail).
  const staleHandle = capLog.attachFileSink({ dir: capDir, filename: "agent.log", flushIntervalMs: 10 });
  const liveHandle = capLog.attachFileSink({ dir: capDir, filename: "agent.log", flushIntervalMs: 10 });
  staleHandle(); // A's handle, called after B replaced it — the late/superseded call
  capLog.info("system", "after-stale-detach");
  capLog.flushSync();
  // The exit path writes synchronously, but it yields to a batch already in the chain; drain that
  // too or the read below races the queued write on a slow runner.
  await capLog.flush();
  const afterStale = await fs.promises.readFile(capFile, "utf-8");
  assert.ok(afterStale.includes("after-stale-detach"), "a superseded detach handle must not unbind the live sink");
  liveHandle();
  console.log("pending-buffer cap + one-shot drain OK:", capLines.length, "retained of", overflow);
}

// ----------------------------------------------------------------------------
// 2. Rotation: small batches push the file past maxBytes → segment files.
// ----------------------------------------------------------------------------
for (let batch = 0; batch < 6; batch++) {
  for (let i = 0; i < 3; i++) {
    log.info("system", `padding-${batch}-${i}-` + "x".repeat(60));
  }
  // Drain the batch instead of sleeping past the flush interval: rotation is decided from the
  // active file's size, so a fixed sleep both raced the flush and left the chain behind for the
  // assertions below.
  await log.flush();
}

const entries = (await fs.promises.readdir(logDir)).sort();
assert.ok(entries.includes("agent.log"), `active file present, got ${entries}`);
const rotated = entries.filter((e) => /^agent\.log\.\d+$/.test(e));
assert.ok(rotated.length >= 1, `expected >=1 rotated segment, got ${entries.join(", ")}`);
console.log("rotation OK:", entries.join(", "));

// ----------------------------------------------------------------------------
// 3. Silent degradation: fs without appendFile must not write nor throw.
// ----------------------------------------------------------------------------
{
  const noAppendRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-log-no-append-"));
  clearCoreEnv();
  registerCoreEnv(createEnv(noAppendRoot, { withAppendFile: false }));

  const noAppendLog = new AgentLog();
  const noAppendDetach = noAppendLog.attachFileSink({
    dir: path.join(noAppendRoot, ".agents/logs/ses_quiet"),
  });
  noAppendLog.info("system", "should-not-crash");
  await sleep(30);
  noAppendDetach();

  assert.equal(noAppendLog.getFileSinkDir(), null, "no sink dir recorded when degraded");
  const written = await fs.promises.readdir(noAppendRoot);
  assert.deepEqual(written, [], "no files written without appendFile");
  console.log("silent degradation OK (no appendFile → no write, no throw)");

  // Restore the real-fs env for the detach test below.
  clearCoreEnv();
  registerCoreEnv(createEnv(rootPath, { withAppendFile: true }));
}

// ----------------------------------------------------------------------------
// 4. Detach stops writes.
// ----------------------------------------------------------------------------
// Drain BEFORE detaching. `detach()` lands the pending buffer but queues whatever batch is already
// in the flush chain (`void flush()`), and those lines are entries emitted *before* the detach — not
// writes that outlived it. Sleeping a fixed 40ms here assumed the chain was always caught up: true
// on a fast runner, false on Windows, where the queued batches landed between the snapshot and the
// comparison and the assertion read as "writes after detach" (this is the flake that failed CI).
await log.flush();
detach();
const afterDetach = await fs.promises.readFile(filePath, "utf-8");
log.info("system", "post-detach");
// Still wait, so a genuine write-after-detach has a chance to appear — that is what gives the
// assertion teeth.
await sleep(40);
assert.equal(await fs.promises.readFile(filePath, "utf-8"), afterDetach, "no writes after detach");
console.log("detach OK");

// ----------------------------------------------------------------------------
// 5. Reused log file: re-attaching to an existing file writes a session
//    divider so a new launch does not blend into the previous one.
// ----------------------------------------------------------------------------
const log2 = new AgentLog();
const detach2 = log2.attachFileSink({
  dir: logDir,
  filename: "agent.log",
  flushIntervalMs: 20,
});
log2.info("system", "launch-2");
await log2.flush();

const content2 = await fs.promises.readFile(filePath, "utf-8");
const markerMatch = content2.match(/---------- [^\n]+ new session ----------/);
assert.ok(markerMatch, `reused file must contain a session divider, got:\n${content2.slice(0, 300)}`);
const beforeMarker = content2.slice(0, markerMatch.index).trim();
assert.ok(beforeMarker.length > 0, "previous launch entries precede the divider");
const afterMarker = content2.slice(markerMatch.index + markerMatch[0].length);
assert.ok(afterMarker.includes("launch-2"), "new launch entries follow the divider");
detach2();
console.log("reused-file divider OK");

await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);
// ----------------------------------------------------------------------------
// 6. An entry the serializer cannot handle is contained.
//    `handleEntry` runs *synchronously* from `AgentLog.log()`, on the agent's own execution path,
//    so a `JSON.stringify` throw (circular reference, BigInt, a throwing `toJSON`) would turn a
//    diagnostic into a run failure. Asserted on the sync path too (`flushSync`), because that is
//    the exit path where a throw would escape into a process-exit handler.
// ----------------------------------------------------------------------------
{
  const badRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-log-unserializable-"));
  const badDir = path.join(badRoot, ".agents/logs/ses_bad");
  const badFile = path.join(badDir, "agent.log");

  const badLog = new AgentLog();
  badLog.attachFileSink({ dir: badDir, filename: "agent.log", flushIntervalMs: 10_000 });

  const circular = { name: "loop" };
  circular.self = circular;
  assert.doesNotThrow(
    () => badLog.info("system", "circular", { data: circular }),
    "an unserializable entry must not throw into the caller (the agent's own path)"
  );

  badLog.info("system", "still-alive");
  badLog.flushSync(); // the exit path — a throw here would escape into `process.on("exit")`

  const written = fs
    .readFileSync(badFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(written.length, 1, `only the serializable entry is persisted, got ${written.length}`);
  assert.equal(written[0].message, "still-alive", "the sink keeps working after a rejected entry");
  assert.equal(
    written.filter((e) => e.message === "circular").length,
    0,
    "the unserializable entry is dropped, never written as a placeholder"
  );
  console.log("unserializable entry is contained OK:", written.length, "of 2 persisted");
}

// ----------------------------------------------------------------------------
// 7. AGENT_LOG_LEVEL filters what reaches disk (the seam defaults to `debug`)
// ----------------------------------------------------------------------------
{
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-log-level-"));
  const levelEnv = createEnv(root, { withAppendFile: true });
  registerCoreEnv(levelEnv);
  const previous = process.env.AGENT_LOG_LEVEL;
  process.env.AGENT_LOG_LEVEL = "warn";
  try {
    const levelLog = new AgentLog();
    const extension = createLogExtension({});
    // Absolute: this fixture's mock fs does not resolve relative paths (the sink passes `dir`
    // straight through to `appendFile`).
    const levelDir = path.join(root, "level");
    const detachLevel = extension.attachSink(levelLog, {
      dir: levelDir,
      filename: "agent.log",
      flushIntervalMs: 10,
      env: levelEnv,
    });
    levelLog.debug("system", "debug-dropped");
    levelLog.info("system", "info-dropped");
    levelLog.warn("system", "warn-kept");
    levelLog.error("system", "error-kept");

    const file = path.join(levelDir, "agent.log");
    const kept = await waitFor(
      async () => {
        try {
          return (await fs.promises.readFile(file, "utf-8")).trim().split("\n").filter(Boolean);
        } catch {
          return [];
        }
      },
      (rows) => rows.length >= 2
    );
    assert.deepEqual(
      kept.map((line) => JSON.parse(line).message),
      ["warn-kept", "error-kept"],
      "AGENT_LOG_LEVEL drops the noisier rows and keeps warn/error"
    );
    detachLevel();
    extension.dispose();
  } finally {
    if (previous === undefined) delete process.env.AGENT_LOG_LEVEL;
    else process.env.AGENT_LOG_LEVEL = previous;
    await fs.promises.rm(root, TEMP_RM_OPTIONS);
    clearCoreEnv();
  }
  console.log("AGENT_LOG_LEVEL filters the persisted timeline OK");
}

// ----------------------------------------------------------------------------
// 7b. The level also filters the bootstrap PENDING buffer
//
// Entries are accepted by the seam while it still defaults to `debug`; the sink is bound later,
// and the drain used to hand them over without re-checking the level the extension just applied.
// That made `AGENT_LOG_LEVEL` ineffective for exactly the bootstrap rows it exists to quiet.
// ----------------------------------------------------------------------------
{
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-log-pending-level-"));
  const levelEnv = createEnv(root, { withAppendFile: true });
  registerCoreEnv(levelEnv);
  const previous = process.env.AGENT_LOG_LEVEL;
  process.env.AGENT_LOG_LEVEL = "warn";
  try {
    const pendingLog = new AgentLog();
    pendingLog.debug("system", "bootstrap-debug");
    pendingLog.info("system", "bootstrap-info");
    pendingLog.warn("system", "bootstrap-warn");

    const extension = createLogExtension({});
    const dir = path.join(root, "pending-level");
    const detach = extension.attachSink(pendingLog, {
      dir,
      filename: "agent.log",
      flushIntervalMs: 10,
      env: levelEnv,
    });
    pendingLog.error("system", "after-attach-error");

    const file = path.join(dir, "agent.log");
    const kept = await waitFor(
      async () => {
        try {
          return (await fs.promises.readFile(file, "utf-8")).trim().split("\n").filter(Boolean);
        } catch {
          return [];
        }
      },
      (rows) => rows.length >= 2
    );
    assert.deepEqual(
      kept.map((line) => JSON.parse(line).message),
      ["bootstrap-warn", "after-attach-error"],
      "the pending drain honours the level, so bootstrap debug/info never reach disk"
    );
    detach();
    extension.dispose();
  } finally {
    if (previous === undefined) delete process.env.AGENT_LOG_LEVEL;
    else process.env.AGENT_LOG_LEVEL = previous;
    await fs.promises.rm(root, TEMP_RM_OPTIONS);
    clearCoreEnv();
  }
  console.log("AGENT_LOG_LEVEL filters the pending bootstrap buffer OK");
}

console.log("agent-log-file-sink validation passed");
