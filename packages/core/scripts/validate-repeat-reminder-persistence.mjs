/**
 * The repeat-tool reminder must actually reach DISK — not just the channel.
 *
 * `validate-repeat-reminder.mjs` owns the middleware's mechanism (counting, thresholds,
 * canonicalisation, reset rules) but stubs the persist seam with a counter:
 *
 *     persistMessages: () => persisted++
 *
 * That proves only that *something* was called. It cannot prove the reminder is durable,
 * and the whole point of routing through `injectSyntheticMessages` is durability: the
 * reminder is a synthetic `<ctx kind=repeat_tool_reminder>` UIMessage that must survive
 * a process boundary, exactly like `turn-context` and `background_notification`.
 *
 * The gap was real and observable. Across 45 recorded sessions and ~11.7k tool-call
 * parts, no session ever reached the first threshold (3) — the longest consecutive
 * identical run on record is 2 (`tmp/repeat-call-scan.mjs`) — and no session log
 * contains a `ctx-repeat_tool_reminder-` id. So "it works in production" had zero
 * evidence, and no automated check stood in for that evidence.
 *
 * This script drives the REAL middleware through the REAL `SessionService` +
 * `SessionStore` and asserts on the log bytes and the reload. The section that makes it
 * worth having is the last one: it proves the assertion is sensitive to the persist seam
 * (remove it and the reminder stops being durable), so a green run here cannot be green
 * for an unrelated reason.
 *
 * Run: pnpm --filter @codent/core run validate:repeat-reminder-persistence
 */

"use strict";

import assert from "node:assert/strict";

import {
  AgentUIChannel,
  DEFAULT_REPEAT_THRESHOLDS,
  REPEAT_REMINDER_KIND,
  SessionService,
  SessionStore,
  UsageTracker,
  clearCoreEnv,
  createRepeatReminderMiddleware,
  formatContextSectionUserContent,
  registerCoreEnv,
  syntheticMessageId,
} from "../dist/dev.mjs";

// ---------------------------------------------------------------------------
// In-memory CoreEnv: the persist path (dehydrate → media store → JSONL log)
// writes through it, so every byte the validator asserts on is a real write.
// ---------------------------------------------------------------------------

const files = new Map();

function setupEnv() {
  clearCoreEnv();
  files.clear();
  registerCoreEnv({
    rootPath: "/mock",
    async getPlatform() {
      return "linux";
    },
    async getArch() {
      return "arm64";
    },
    async getEnv() {
      return {};
    },
    async homedir() {
      return "/mock";
    },
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
      resolve: (...parts) => parts.join("/"),
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
        files.set(p, typeof content === "string" ? content : String(content));
      },
      async appendFile(p, content) {
        files.set(p, (files.get(p) ?? "") + (typeof content === "string" ? content : String(content)));
      },
      async mkdir() {},
      async exists(p) {
        if (files.has(p)) return true;
        const prefix = p.endsWith("/") ? p : `${p}/`;
        return [...files.keys()].some((key) => key === p || key.startsWith(prefix));
      },
      async readdir(p) {
        const prefix = p.endsWith("/") ? p : `${p}/`;
        const names = new Set();
        for (const key of files.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const name = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
          if (name) names.add(name);
        }
        return [...names].map((name) => ({ name, type: name.endsWith(".jsonl") ? "file" : "directory" }));
      },
      async remove(p) {
        files.delete(p);
      },
      async stat(p) {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        return { size: String(files.get(p)).length, isFile: true, isDirectory: false };
      },
    },
    runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    fetch: async () => new Response("", { status: 200 }),
  });
}

const noop = () => {};

/** A real `SessionService` over a real `SessionStore`, on the in-memory env. */
function makeSessionService() {
  const store = new SessionStore();
  const service = new SessionService();
  service.setStore(store, { modelStyle: "openai", model: "probe-model" });
  service.ensureSessionData();
  const usage = new UsageTracker({
    model: "probe-model",
    modelStyle: "openai",
    provider: "probe",
    getMessagesForLLM: () => [],
    log: undefined,
  });
  return {
    service,
    store,
    /**
     * The exact wiring `buildAgentRunner` installs for this middleware: the channel is
     * appended to first, then the persist seam is handed the full message array.
     */
    persistMessages(uiMessages) {
      pendingWrites.push(service.persistSession({ usage, todoManager: null, uiMessages, emitEvent: noop }));
    },
  };
}

let pendingWrites = [];

/**
 * Read back what a *later process* would see: the raw log bytes and the fold.
 *
 * The log path is discovered from the session id, and a missing log is the failure mode of
 * a persist seam that never ran (or ran with nothing to write) — so the message names that
 * contract rather than "logPath is undefined", which is what a bare `assert.ok` would say.
 */
async function readBack(store, service) {
  await Promise.all(pendingWrites);
  const wrote = pendingWrites.length > 0;
  pendingWrites = [];
  const sessionId = service.getSessionData().id;
  const logPath = [...files.keys()].find((key) => key.includes(sessionId));
  assert.ok(
    logPath,
    `the reminder must reach disk: the persist seam handed to the middleware is what writes the ` +
      `session log, and it ${wrote ? "ran but wrote no session file" : "was never called"}. A reminder ` +
      `that only reaches the channel is lost on /resume.`
  );
  const raw = files.get(logPath);
  const loaded = await store.load(sessionId);
  return { raw, loaded, sessionId, logPath };
}

/** The TanStack hook contract: `{ toolName, args, toolCallId }` (see compose.js `hookCtx`). */
function call(mw, toolName, args, toolCallId) {
  return mw.onBeforeToolCall({}, { toolName, args, toolCallId });
}

function config(mw, messages) {
  return mw.onConfig({}, { messages });
}

const userMessage = (content) => ({ role: "user", content });
const assistantMessage = (content) => ({ role: "assistant", content });

/** A channel with one genuine user turn (the wire baseline the middleware counts). */
function makeChannel(prompt) {
  const channel = new AgentUIChannel();
  channel.addUserMessage(prompt);
  return channel;
}

/** Drive `count` identical tracked calls. */
function repeat(mw, count, toolName, args, idPrefix) {
  return Promise.all(Array.from({ length: count }, (_, i) => call(mw, toolName, args, `${idPrefix}-${i}`)));
}

const REMINDER_PREFIX = `ctx-${REPEAT_REMINDER_KIND}-`;
const reminderIds = (messages) => messages.filter((m) => m.id?.startsWith(REMINDER_PREFIX)).map((m) => m.id);

// ============================================================================
// 1. The reminder is persisted to the session log (real SessionStore)
// ============================================================================

setupEnv();
{
  const prompt = "please search the repository";
  const channel = makeChannel(prompt);
  const wire = [userMessage(prompt)];
  const { service, store, persistMessages } = makeSessionService();

  const mw = createRepeatReminderMiddleware({
    getUIChannel: () => channel,
    persistMessages,
  });

  // Turn start: establishes the genuine-user-message baseline.
  await config(mw, wire);

  // Below the threshold: nothing is written.
  await repeat(mw, DEFAULT_REPEAT_THRESHOLDS[0] - 1, "grep", { pattern: "foo", path: "src" }, "probe-a");
  await config(mw, wire);
  await Promise.all(pendingWrites);
  pendingWrites = [];
  assert.equal(
    [...files.values()].some((bytes) => String(bytes).includes(REMINDER_PREFIX)),
    false,
    "no reminder may be persisted below the first threshold"
  );

  // The threshold repeat: the gentle reminder is injected AND persisted.
  await repeat(mw, 1, "grep", { pattern: "foo", path: "src" }, "probe-b");
  await config(mw, wire);

  const { raw, loaded } = await readBack(store, service);

  assert.ok(
    raw.includes(REMINDER_PREFIX),
    `the reminder's stable id must be in the persisted session log — this is what makes it durable ` +
      `across a process boundary. Switch the persist seam off (section 4) and this assertion fails, ` +
      `which is how it is known not to be vacuous. Log:\n${String(raw).slice(0, 400)}`
  );
  assert.ok(raw.includes("repeating the exact same tool call"), "the reminder BODY must be on disk, not only its id");
  assert.ok(raw.includes("ctx kind=repeat_tool_reminder"), "the durable form carries the ctx shell");

  const persistedIds = reminderIds(loaded.uiMessages);
  assert.equal(
    persistedIds.length,
    1,
    `the reloaded session must carry exactly one reminder; got ${persistedIds.length} (${persistedIds.join(", ")})`
  );
  assert.ok(
    persistedIds[0].startsWith(REMINDER_PREFIX),
    `the persisted id must keep the readable ctx kind, so a host can classify it without re-parsing ` +
      `the body; got ${persistedIds[0]}`
  );

  // The id is the content-hash id the shared injection helper derives — the same
  // derivation `turn-context` and `background_notification` use, which is what makes
  // the injection idempotent across a restore.
  const expected = syntheticMessageId({
    kind: REPEAT_REMINDER_KIND,
    content: formatContextSectionUserContent({
      key: REPEAT_REMINDER_KIND,
      content:
        "You are repeating the exact same tool call with identical arguments. " +
        "Carefully analyze the previous result before calling again: if the task is not " +
        "complete, try a different approach or different arguments instead of repeating the call.",
    }),
    nonce: 1,
  });
  assert.equal(
    persistedIds[0],
    expected,
    "the persisted id must be the shared content-hash id, so a restore dedupes instead of re-injecting"
  );

  // The user's own turn is untouched: persisting a synthetic message must not rewrite history.
  assert.ok(
    loaded.uiMessages.some((m) => m.role === "user" && JSON.stringify(m.parts).includes(prompt)),
    "the user's prompt must survive the reminder write"
  );
}

// ============================================================================
// 2. A SECOND identical loop later in the session persists its own reminder
// ============================================================================
//
// This is the assertion the stub-counter test cannot make. The gentle reminder body is
// byte-identical between loops, so with the same stable id the second injection would be
// deduped away by `injectSyntheticMessages` — leaving the second loop un-nudged. The
// middleware's per-kind `nonce` is what breaks the tie, and it is only observable
// against a REAL channel + REAL log, where the dedupe actually happens.

setupEnv();
{
  const prompt = "please search the repository";
  const channel = makeChannel(prompt);
  const wire1 = [userMessage(prompt)];
  const { service, store, persistMessages } = makeSessionService();

  const mw = createRepeatReminderMiddleware({ getUIChannel: () => channel, persistMessages });

  await config(mw, wire1);
  await repeat(mw, DEFAULT_REPEAT_THRESHOLDS[0], "grep", { pattern: "foo" }, "loop1");
  await config(mw, wire1);

  // A genuine new prompt resets the chain: repetition across a fresh instruction is not a loop.
  const wire2 = [userMessage(prompt), assistantMessage("done"), userMessage("now search again")];
  await config(mw, wire2);
  await repeat(mw, DEFAULT_REPEAT_THRESHOLDS[0], "grep", { pattern: "foo" }, "loop2");
  await config(mw, wire2);

  const { raw, loaded } = await readBack(store, service);
  const persistedIds = reminderIds(loaded.uiMessages);

  assert.equal(
    persistedIds.length,
    2,
    `the second identical loop must persist its own reminder (per-kind nonce); got ${persistedIds.length} ` +
      `(${persistedIds.join(", ")}) — without the nonce the content-hash id collides with the first ` +
      `reminder, the injection is deduped, and the second loop gets no nudge on disk OR on the wire`
  );
  assert.equal(new Set(persistedIds).size, 2, "the two reminders must have distinct ids");
  // The log is append-only, so a message is re-serialized into every later snapshot:
  // count DISTINCT ids on disk, not occurrences.
  const distinctOnDisk = new Set(String(raw).match(/ctx-repeat_tool_reminder-[A-Za-z0-9_-]+/g) ?? []);
  assert.equal(
    distinctOnDisk.size,
    2,
    `both reminder ids must appear in the log bytes (the log is append-only, so occurrences exceed ids); ` +
      `got ${distinctOnDisk.size} distinct (${[...distinctOnDisk].join(", ")})`
  );
  assert.equal(
    channel.getMessages().filter((m) => m.id?.startsWith(REMINDER_PREFIX)).length,
    2,
    "the channel and the log must agree — a durable write that skips the channel would desync the transcript"
  );
}

// ============================================================================
// 3. The persist seam is what makes it durable (anti-false-green)
// ============================================================================
//
// The regression this guards: the middleware is wired WITHOUT the persist seam (or the
// channel is absent). The reminder then still reaches the WIRE — the model is nudged —
// but nothing is written, so `/resume` and the transcript lose it. Section 1 asserts the
// positive; this asserts the same fixture without the seam, proving section 1's assertion
// is sensitive to the seam rather than passing for an unrelated reason.

setupEnv();
{
  const prompt = "please search the repository";
  const channel = makeChannel(prompt);
  const wire = [userMessage(prompt)];
  const { service, store } = makeSessionService();

  // Deliberately the pre-fix wiring: channel append, no persist.
  const mw = createRepeatReminderMiddleware({ getUIChannel: () => channel, persistMessages: noop });

  await config(mw, wire);
  await repeat(mw, DEFAULT_REPEAT_THRESHOLDS[0], "grep", { pattern: "foo" }, "noseam");
  const out = await config(mw, wire);

  // The nudging still happened in memory...
  assert.equal(
    channel.getMessages().filter((m) => m.id?.startsWith(REMINDER_PREFIX)).length,
    1,
    "the in-memory channel still receives the reminder"
  );
  assert.ok(
    JSON.stringify(out.messages).includes(REPEAT_REMINDER_KIND),
    "the wire still receives the reminder — the model is nudged either way"
  );

  // ...but the session log is untouched. (The service is never asked to persist, so there
  // is nothing to read back; assert on the raw store contents.)
  assert.equal(
    [...files.values()].some((bytes) => String(bytes).includes(REMINDER_PREFIX)),
    false,
    "without the persist seam the reminder must NOT reach disk — this is the failure mode " +
      "section 1 exists to catch, so a green section 1 cannot be green by accident"
  );
  void service;
  void store;
}

// ============================================================================
// 4. With no channel the reminder is wire-only by contract (never persisted)
// ============================================================================
//
// A subagent has no session store, so `getUIChannel()` returns undefined. The middleware
// documents a transient wire-only injection for that case. Assert it stays transient —
// otherwise a subagent's nudge could surface in the parent's transcript.

setupEnv();
{
  const { service, store, persistMessages } = makeSessionService();
  const mw = createRepeatReminderMiddleware({ getUIChannel: () => undefined, persistMessages });

  const input = [userMessage("go")];
  await config(mw, input);
  await repeat(mw, DEFAULT_REPEAT_THRESHOLDS[0], "grep", { pattern: "foo" }, "nochannel");
  const out = await config(mw, input);

  assert.equal(out.messages.length, input.length + 1, "no channel → append to the wire");
  assert.equal(input.length, 1, "the input wire must not be mutated");
  assert.equal(
    [...files.values()].some((bytes) => String(bytes).includes(REMINDER_PREFIX)),
    false,
    "a channel-less run must not persist the reminder"
  );
  void service;
  void store;
}

console.log("repeat-reminder persistence validation passed");
