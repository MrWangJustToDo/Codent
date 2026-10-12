/**
 * Validates that a media (dehydrate/hydrate) IO failure while persisting a
 * session never escapes as an unhandled rejection, and is surfaced through
 * `session:save-error` like any other save failure.
 *
 * Background: `dehydrateUIMessages` runs BEFORE `saveToStore`'s try/catch, and
 * `MediaStore.save` writes media files with no fallback. A disk-full media write
 * therefore used to reject `persistSession`, and the host fires it
 * fire-and-forget (`void …persist…`) — an unhandled rejection with no global
 * handler crashes the Node host.
 *
 * Run: pnpm --filter @codent/core run validate:session-persist-media-failure
 */

/* eslint-disable no-undef */

import assert from "node:assert/strict";

import { SessionService, SessionStore, UsageTracker, clearCoreEnv, registerCoreEnv } from "../dist/dev.mjs";

const MEDIA_DIR = ".agents/media";

// 1x1 red pixel PNG.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

const files = new Map();

function setupEnv({ failMediaWrites }) {
  clearCoreEnv();
  files.clear();

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
        if (failMediaWrites && p.includes(MEDIA_DIR)) {
          throw new Error("ENOSPC: mock disk full (media)");
        }
        files.set(p, content instanceof Uint8Array ? content : String(content));
      },
      async appendFile(p, content) {
        files.set(p, (files.get(p) ?? "") + String(content));
      },
      async mkdir() {},
      async exists(p) {
        if (files.has(p)) return true;
        const prefix = p.endsWith("/") ? p : `${p}/`;
        return [...files.keys()].some((k) => k === p || k.startsWith(prefix));
      },
      async readdir() {
        return [];
      },
      async remove(p) {
        files.delete(p);
      },
      async stat(p) {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        return { size: 0, isFile: true, isDirectory: false };
      },
    },
    runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    fetch: async () => new Response("", { status: 200 }),
  });
}

function imageMessage(id) {
  return {
    id,
    role: "user",
    parts: [{ type: "image", source: { type: "data", value: TINY_PNG_DATA_URL }, metadata: {} }],
    createdAt: new Date(),
  };
}

// --- persist: media write failure is caught, reported, and does not crash ----

setupEnv({ failMediaWrites: true });
{
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  const store = new SessionStore();
  const service = new SessionService();
  service.setStore(store, { modelStyle: "openai", model: "test-model" });
  const data = service.ensureSessionData();
  data.name = "keep"; // skip auto-title so this only exercises the dehydrate path
  data.uiMessages = [];

  const events = [];
  const input = {
    usage: new UsageTracker(),
    todoManager: null,
    emitEvent: (type, payload) => events.push({ type, payload }),
    uiMessages: [imageMessage("m1")],
  };

  // Awaited call resolves (does not reject on the media failure).
  await service.persistSession(input);

  const saveErrors = events.filter((e) => e.type === "session:save-error");
  assert.equal(saveErrors.length >= 1, true, "emits session:save-error on media failure");
  assert.equal(saveErrors[0].payload.target, "session+uiMessages");
  assert.match(saveErrors[0].payload.error, /ENOSPC/);

  // dehydrate failed → previous (empty) uiMessages are kept, and the rest of the
  // session still persisted.
  assert.deepEqual(data.uiMessages, [], "uiMessages left unchanged when dehydrate fails");
  const reloaded = await store.load(data.id);
  assert.ok(reloaded, "session still persisted despite the media failure");

  // Fire-and-forget, exactly like the host: must NOT produce an unhandled rejection.
  void service.persistSession({ ...input, usage: new UsageTracker() });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(unhandled.length, 0, "fire-and-forget persist does not raise an unhandled rejection");

  process.off("unhandledRejection", onUnhandled);
}

// --- restore: media write failure during canonicalize does not abort resume ---

setupEnv({ failMediaWrites: true });
{
  const store = new SessionStore();
  const service = new SessionService();
  service.setStore(store, { modelStyle: "openai", model: "test-model" });

  const id = "ses_restore_media";
  // A one-line message log (v6 shape: the line carries the write time). The
  // message carries raw base64 (not a media:// ref) so hydrate leaves it and the
  // canonicalize dehydrate tries to write the media file → fails.
  files.set(
    `.agents/sessions/${id}.session.jsonl`,
    JSON.stringify({
      t: "message",
      message: imageMessage("m1"),
      messageUpdatedAt: 2,
      state: {
        id,
        name: "restore",
        version: 6,
        modelStyle: "openai",
        model: "test-model",
        createdAt: 1,
        updatedAt: 2,
        usage: {},
        todos: [],
      },
    }) + "\n"
  );

  const restored = await service.restoreFromStore(id, { usage: new UsageTracker(), todoManager: null });
  assert.equal(restored.uiMessages.length, 1, "restore completes despite the media write failure");
}

console.log("session-persist-media-failure validation passed");
