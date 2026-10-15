/**
 * Regression gate for the persistence/session save bugs.
 *
 * Each block is written so it FAILS on the pre-fix code — a gate that only passes
 * on both the old and new implementation is not a gate. The comments name the old
 * behavior each assertion rules out.
 *
 * 1. **Persist is serialized per session, in call order.** `dehydrateUIMessages` is
 *    async, so two overlapping persists could finish in the opposite order and
 *    leave the *older* snapshot in `data.uiMessages` — which the store then wrote,
 *    rewinding the session on disk (and physically deleting lines the newer persist
 *    had just appended, via `rewriteLog`). Old code: the slow dehydrate of save A
 *    resolved after save B and clobbered B's messages.
 * 2. **A failed save does not mark the content persisted.** The fingerprint gate
 *    used to be updated unconditionally, so after one failed write every later
 *    persist of the same content was skipped as a no-op — the loss never converged.
 *    Old code: `persistSession` returned `void` and `markPersisted` always ran.
 * 3. **`/clear` reaches disk.** Clearing in memory left the log intact, so resuming
 *    resurrected the cleared conversation. Old code: `persistSession` refused an
 *    empty `uiMessages`.
 * 4. **An empty list is only written when the caller says so.** Every other caller
 *    omits `uiMessages` instead of passing `[]`; a stray empty array must not erase
 *    a real transcript.
 * 5. **Auto-title waits for a first user message.** A fresh ("New Session") session is
 *    persisted before its first turn by state-only writes, so the title path used to hand
 *    the side LLM an empty prompt — a title with no conversation behind it, and a wasted
 *    call (some providers 400 on the empty input, surfacing only as a `side-query` warn).
 *    Old code: the title resolver ran for a persist that carried no user message.
 *
 * Run: pnpm --filter @codent/core run validate:session-persist-integrity
 */

/* eslint-disable no-undef */

import assert from "node:assert/strict";

import {
  SessionService,
  SessionStore,
  UsageTracker,
  clearCoreEnv,
  createSessionSyncTracker,
  registerCoreEnv,
  saveSessionUIMessages,
} from "../dist/dev.mjs";

const files = new Map();

// 1x1 red pixel PNG.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * Media writes are *parked* rather than delayed: the env holds their resolvers so a
 * test can complete them in an explicit order. This is what makes the P0-1 race a
 * deterministic assertion instead of a timing coincidence — releasing them
 * newest-first forces the older snapshot to be the last one assigned, which is the
 * exact interleaving that used to rewind the session.
 */
let parkedMediaWrites = [];

/**
 * Await `promises` while releasing parked media writes newest-first.
 *
 * Polls instead of returning early: the first persist's dehydrate reaches its
 * parked write asynchronously, so a helper that gave up when nothing was parked
 * yet would deadlock the awaited persists. Whenever writes are parked they are
 * released newest-first, which is what discriminates the two orderings.
 */
async function settleReleasingNewestFirst(promises) {
  let settled = false;
  const all = Promise.all(promises).then((value) => {
    settled = true;
    return value;
  });
  while (!settled) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (parkedMediaWrites.length === 0) continue;
    const parked = parkedMediaWrites;
    parkedMediaWrites = [];
    for (let j = parked.length - 1; j >= 0; j--) parked[j]();
  }
  return all;
}

function setupEnv(options = {}) {
  clearCoreEnv();
  files.clear();
  parkedMediaWrites = [];

  const parkMedia = options.parkMediaWrites ?? false;
  const failWrites = options.failWrites ?? false;

  registerCoreEnv({
    rootPath: "/mock",
    getPlatform: async () => "linux",
    getArch: async () => "arm64",
    getEnv: async () => ({}),
    homedir: async () => "/mock",
    base64Decode: (b64) => new TextEncoder().encode(Buffer.from(b64, "base64").toString("binary")),
    base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
    path: {
      join: (...parts) => parts.join("/"),
      dirname: (p) => {
        const i = p.lastIndexOf("/");
        return i <= 0 ? "/" : p.slice(0, i);
      },
      basename: (p, ext) => {
        const base = p.split("/").pop() ?? p;
        return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
      },
      extname: (p) => {
        const base = p.split("/").pop() ?? p;
        const i = base.lastIndexOf(".");
        return i < 0 ? "" : base.slice(i);
      },
      resolve: (...parts) => `/${parts.join("/")}`,
      normalize: (p) => p.replace(/\/+/g, "/"),
      isAbsolute: (p) => p.startsWith("/"),
      getSep: () => "/",
      parse: (p) => {
        const base = p.split("/").pop() ?? p;
        const i = base.lastIndexOf(".");
        return {
          root: "/",
          dir: p.slice(0, p.lastIndexOf("/")) || "/",
          base,
          ext: i < 0 ? "" : base.slice(i),
          name: i < 0 ? base : base.slice(0, i),
        };
      },
    },
    fs: {
      async readFile(p) {
        const content = files.get(p);
        if (content === undefined) throw new Error(`ENOENT: ${p}`);
        return content;
      },
      async writeFile(p, content) {
        if (p.includes(".agents/media/") && parkMedia) {
          await new Promise((resolve) => parkedMediaWrites.push(resolve));
        }
        if (failWrites && p.includes(".agents/sessions/")) {
          throw new Error("ENOSPC: mock disk full");
        }
        files.set(p, content instanceof Uint8Array ? content : String(content));
      },
      async appendFile(p, content) {
        const prev = files.get(p);
        files.set(p, (prev ?? "") + String(content));
      },
      async mkdir() {},
      async exists(p) {
        if (files.has(p)) return true;
        const prefix = p.endsWith("/") ? p : `${p}/`;
        return [...files.keys()].some((k) => k === p || k.startsWith(prefix));
      },
      async readdir() {
        const names = new Set();
        for (const key of files.keys()) {
          const rest = key.slice(".agents/sessions/".length);
          if (!key.startsWith(".agents/sessions/") || rest.includes("/")) continue;
          names.add(rest);
        }
        return [...names].map((name) => ({ name, type: "file" }));
      },
      async remove(p) {
        files.delete(p);
      },
      async stat(p) {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        return { size: String(files.get(p) ?? "").length, isFile: true, isDirectory: false };
      },
    },
    runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    fetch: async () => new Response("", { status: 200 }),
  });
}

function textMessage(id, text) {
  return { id, role: "user", parts: [{ type: "text", content: text }], createdAt: new Date(1) };
}

/** A message whose persist must extract a base64 image → an awaited media write. */
function imageMessage(id) {
  return {
    id,
    role: "user",
    parts: [
      { type: "image", source: { type: "data", value: `data:image/png;base64,${TINY_PNG_BASE64}` }, metadata: {} },
    ],
    createdAt: new Date(1),
  };
}

function newService() {
  const store = new SessionStore();
  const service = new SessionService();
  service.setStore(store, { modelStyle: "openai", model: "test-model" });
  const data = service.ensureSessionData();
  data.name = "gate"; // skip auto-title so only the persist path is exercised
  return { store, service, data };
}

// ---------------------------------------------------------------------------
// 1. Persists are serialized in call order (P0-1)
// ---------------------------------------------------------------------------
{
  setupEnv({ parkMediaWrites: true });
  const { store, service } = newService();

  // Save A carries an image, so its dehydrate awaits a parked media write. Save B
  // is dispatched immediately after with a longer, plain transcript. Releasing the
  // parked writes newest-first makes the *older* snapshot land last — the exact
  // interleaving that used to leave A's shorter list in `data.uiMessages` and make
  // the store rewrite the log, physically dropping B's appended tail.
  const a = service.persistSession({
    usage: new UsageTracker(),
    getTodoManager: () => null,
    uiMessages: [imageMessage("m1")],
  });
  const b = service.persistSession({
    usage: new UsageTracker(),
    getTodoManager: () => null,
    uiMessages: [imageMessage("m1"), textMessage("m2", "mid"), textMessage("m3", "later")],
  });

  const results = await settleReleasingNewestFirst([a, b]);
  assert.deepEqual(results, [true, true], "both serialized persists report success");

  const data = service.getSessionData();
  assert.deepEqual(
    data.uiMessages.map((m) => m.id),
    ["m1", "m2", "m3"],
    "the newest snapshot wins — an out-of-order older persist must not clobber it"
  );

  const reloaded = await store.load(data.id);
  assert.deepEqual(
    reloaded.uiMessages.map((m) => m.id),
    ["m1", "m2", "m3"],
    "disk matches the newest snapshot (no rewind, no deleted tail)"
  );
}

// ---------------------------------------------------------------------------
// 2. A failed save is not marked persisted (P0-2)
// ---------------------------------------------------------------------------
{
  setupEnv({ failWrites: true });
  const { service } = newService();
  const messages = [textMessage("m1", "hello")];

  const failed = await service.persistSession({
    usage: new UsageTracker(),
    getTodoManager: () => null,
    uiMessages: messages,
  });
  assert.equal(failed, false, "a failed write reports failure to the caller");

  // Retry with the same content: it must be attempted again, not skipped. The gate
  // is that the retry succeeds once IO recovers.
  setupEnv({ failWrites: false });
  const { store, service: service2, data: data2 } = newService();
  data2.name = "gate";
  const ok = await service2.persistSession({
    usage: new UsageTracker(),
    getTodoManager: () => null,
    uiMessages: messages,
  });
  assert.equal(ok, true, "same content persists again after a failure (not deduped away)");
  const reloaded = await store.load(data2.id);
  assert.deepEqual(
    reloaded.uiMessages.map((m) => m.id),
    ["m1"],
    "retry converged on disk"
  );
}

// ---------------------------------------------------------------------------
// 3. /clear reaches disk (P1-9)
// ---------------------------------------------------------------------------
{
  setupEnv();
  const { store, service, data } = newService();

  await service.persistSession({
    usage: new UsageTracker(),
    getTodoManager: () => null,
    uiMessages: [textMessage("m1", "first"), textMessage("m2", "second")],
  });
  assert.deepEqual(
    (await store.load(data.id)).uiMessages.map((m) => m.id),
    ["m1", "m2"],
    "baseline written"
  );

  const cleared = await service.persistSession({
    usage: new UsageTracker(),
    getTodoManager: () => null,
    uiMessages: [],
    forceEmptyMessages: true,
  });
  assert.equal(cleared, true, "forced empty persist reports success");

  const after = await store.load(data.id);
  assert.deepEqual(after.uiMessages, [], "cleared transcript is empty on disk (resume cannot resurrect it)");
  assert.equal(after.name, "gate", "state survives the empty write");
}

// ---------------------------------------------------------------------------
// 4. A stray empty list is NOT written (needs forceEmptyMessages)
// ---------------------------------------------------------------------------
{
  setupEnv();
  const { store, service, data } = newService();

  await service.persistSession({
    usage: new UsageTracker(),
    getTodoManager: () => null,
    uiMessages: [textMessage("m1", "keep me")],
  });

  const stray = await service.persistSession({ usage: new UsageTracker(), getTodoManager: () => null, uiMessages: [] });
  assert.equal(stray, false, "an unforced empty persist reports failure");
  assert.deepEqual(
    (await store.load(data.id)).uiMessages.map((m) => m.id),
    ["m1"],
    "an unforced empty array must not erase the transcript"
  );
}

// ---------------------------------------------------------------------------
// 5. The sync tracker is only marked on a write that landed (P0-2, host level)
// ---------------------------------------------------------------------------
{
  setupEnv({ failWrites: true });
  const store = new SessionStore();
  const service = new SessionService();
  service.setStore(store, { modelStyle: "openai", model: "test-model" });
  const data = service.ensureSessionData();
  data.name = "gate";

  const tracker = createSessionSyncTracker();
  const host = {
    usage: new UsageTracker(),
    getTodoManager: () => null,
    planMode: { getPhase: () => "off", getState: () => null },
    isAutoModeEnabled: () => false,
    setAutoModeEnabled: () => {},
    getReasoningEffort: () => undefined,
    session: service,
    sessionSyncTracker: tracker,
    emitEvent: () => {},
    clearQueuedMessages: () => {},
    syncInteractionStateFromUIMessages: () => {},
  };

  const messages = [textMessage("m1", "hello")];
  await saveSessionUIMessages(host, messages);
  assert.equal(
    tracker.getSnapshot(),
    null,
    "a failed write must not be recorded as persisted (otherwise the retry is suppressed)"
  );
  assert.equal(tracker.shouldPersist(messages, { reason: "pump-complete" }), true, "retry is not deduped away");
}

// ---------------------------------------------------------------------------
// 6. A successful host-level save marks the snapshot
// ---------------------------------------------------------------------------
{
  setupEnv({});
  const store = new SessionStore();
  const service = new SessionService();
  service.setStore(store, { modelStyle: "openai", model: "test-model" });
  const data = service.ensureSessionData();
  data.name = "gate";

  const tracker = createSessionSyncTracker();
  const host = {
    usage: new UsageTracker(),
    getTodoManager: () => null,
    planMode: { getPhase: () => "off", getState: () => null },
    isAutoModeEnabled: () => false,
    setAutoModeEnabled: () => {},
    getReasoningEffort: () => undefined,
    session: service,
    sessionSyncTracker: tracker,
    emitEvent: () => {},
    clearQueuedMessages: () => {},
    syncInteractionStateFromUIMessages: () => {},
  };

  const messages = [textMessage("m1", "hello")];
  await saveSessionUIMessages(host, messages);
  assert.notEqual(tracker.getSnapshot(), null, "a landed write marks the snapshot");
  assert.equal(
    tracker.shouldPersist(messages, { reason: "pump-complete" }),
    false,
    "same content after a successful save is a no-op"
  );
  assert.deepEqual(
    (await store.load(data.id)).uiMessages.map((m) => m.id),
    ["m1"],
    "content on disk"
  );
}

// ---------------------------------------------------------------------------
// 7. Auto-title waits for a first user message (no empty-prompt side call)
// ---------------------------------------------------------------------------
{
  setupEnv();
  const store = new SessionStore();
  const service = new SessionService();
  service.setStore(store, { modelStyle: "openai", model: "test-model" });
  // Deliberately keep the default "New Session" name: that is the state `/clear` leaves
  // a fresh session in, and what arms the auto-title path.
  const data = service.ensureSessionData();
  assert.equal(data.name, "New Session", "a fresh session starts on the placeholder name");

  // A null adapter keeps the LLM out of the test: the fallback title is the first 50 chars
  // of the user text, so the *name* proves the path ran, and the call count proves whether
  // it ran at all. On the pre-fix code the state-only persists below each invoked this
  // resolver — the title call was made with an empty prompt.
  let adapterCalls = 0;
  const resolveTextAdapter = async () => {
    adapterCalls += 1;
    return null;
  };
  const persist = (uiMessages) =>
    service.persistSession({
      usage: new UsageTracker(),
      getTodoManager: () => null,
      resolveTextAdapter,
      uiMessages,
    });
  // The title write is fire-and-forget inside a `.then`, so give it a turn to land.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  // `persistSessionModelState` carries no `uiMessages` at all (this is what `/clear`'s mode
  // resets queue); a stray empty list is the same "nothing to title" case. Neither may reach
  // the side LLM.
  await persist(undefined);
  await persist([]);
  await settle();
  assert.equal(adapterCalls, 0, "no title call without a first user message");
  assert.equal(data.name, "New Session", "the empty session keeps its placeholder name");

  // The same fresh session, now carrying a first user message: the title path runs once.
  await persist([textMessage("m1", "hello there")]);
  await settle();
  assert.equal(adapterCalls, 1, "a first user message triggers exactly one title call");
  assert.equal(data.name, "hello there", "the adapter-less fallback names the session");
  assert.equal((await store.load(data.id)).name, "hello there", "the fallback title reached disk");
}

console.log("session-persist-integrity validation passed");
