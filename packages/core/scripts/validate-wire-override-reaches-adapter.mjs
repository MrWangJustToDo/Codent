/* eslint-disable max-lines -- end-to-end recovery scenarios share one fixture; splitting the file would duplicate it */
/**
 * Wire overrides must survive the channel projection and reach the adapter.
 *
 * This is the guard for a regression that shipped silently: `compaction.onConfig`
 * rebuilds every wire call from `channel.getMessages()` and discards the incoming
 * `config.messages`. Anything that edited the messages handed to `runner.run()`
 * therefore applied to the first call of a run only and was overwritten from the
 * second call on. Three call sites assumed the old contract:
 *
 *   1. the pre-send capability strip (`messagesForModelCapabilities`)
 *   2. the widened strip retry after a multimodal API rejection
 *      (`tryCapabilitySanitizeRetry`)
 *   3. the `max_tokens` continuation prompt (`handleMaxTokensTruncation`)
 *
 * `validate-run-stream-recovery.mjs` asserted the *identity* behavior of the strip
 * helper (`messagesForModelCapabilities(managed, msgs) === msgs`, which is trivially
 * true when nothing is dropped) and never observed the adapter. The fix moved all
 * three onto per-run state applied by the `wire-recovery` middleware, which runs
 * after the projection.
 *
 * The assertions below go through a real `AgentRunner` + real `chat()` engine with a
 * real `AgentUIChannel`, and capture what the adapter is actually handed. They are
 * deliberately end-to-end: an assertion on the middleware's return value alone would
 * not notice a relocation that puts it back before `compaction`.
 *
 * Division of labour with `validate-middleware-order.mjs`: that script drives the REAL
 * `buildAgentRunner` assembly and owns *placement* (is the seam where it must be?);
 * this script owns *mechanism* (does the seam actually deliver?). Section 6 below is the
 * mutation control — the same pipeline with the seam moved before the projection, which
 * is the shape of the original regression.
 *
 * Sections 8-10 own the other half of the contract: the overrides are **wire-only**, so
 * they must not reach the persisted session. That is not implied by "the adapter saw
 * them" — a strip applied anywhere upstream of the channel would satisfy the first
 * three sections and still destroy the user's attachment on disk. The path from the
 * wire to the disk runs through shared nested objects: `getModelVisibleMessages`
 * builds fresh message objects but the content-part objects inside them are the SAME
 * references as the channel's, so one in-place part edit downstream of the projection
 * is silently durable. Sections 8-10 therefore persist through a real
 * `SessionService` + `SessionStore` and assert on the log bytes and the reload.
 *
 * Run: pnpm --filter @codent/core run validate:wire-override-reaches-adapter
 */

"use strict";

import assert from "node:assert/strict";

import {
  AgentRunner,
  AgentUIChannel,
  CONTINUATION_PROMPT,
  MULTIMODAL_OMITTED_PLACEHOLDER,
  SessionService,
  SessionStore,
  ToolCompactCache,
  UsageTracker,
  WireProjectionCache,
  armCapabilityStrip,
  createCompactionMiddleware,
  createReadFileTool,
  createToolCompactMiddleware,
  getToolMetadata,
  createTruncationState,
  createTurnContextMiddleware,
  createWireRecoveryMiddleware,
  MAX_TRUNCATION_CONTINUATIONS,
  handleMaxTokensTruncation,
  readTruncationProgress,
  registerCoreEnv,
  sortMiddlewaresByPhase,
} from "../dist/dev.mjs";

// The runner resolves a tool run context (and therefore the workspace env) before it
// builds the first wire call. A permissive in-memory stub is enough — nothing here
// touches the real fs — but it must record writes, because sections 8-10 assert on the
// bytes that reach the session log.
const files = new Map();

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

const noop = () => {};

/** Capture the exact messages array the adapter is asked to send. */
function makeCapturingAdapter() {
  const calls = [];
  return {
    calls,
    adapter: {
      kind: "text",
      name: "capturing",
      model: "capturing-model",
      "~types": {},
      chatStream(options) {
        calls.push(options.messages);
        return (async function* () {
          yield { type: "RUN_FINISHED", finishReason: "stop" };
        })();
      },
      async structuredOutput() {
        throw new Error("not implemented");
      },
    },
  };
}

/** Real RunCoordinator (not a stub) — the override state is the thing under test. */
class TestRun {
  drop = null;
  continuation = false;
  maxOutputTokensOverride = undefined;
  resetWireOverride() {
    this.drop = null;
    this.continuation = false;
    this.maxOutputTokensOverride = undefined;
  }
  getMaxOutputTokensOverride() {
    return this.maxOutputTokensOverride;
  }
  setMaxOutputTokensOverride(value) {
    this.maxOutputTokensOverride = value;
  }
  getWireDropPartTypes() {
    return this.drop;
  }
  setWireDropPartTypes(next) {
    this.drop = next;
  }
  isWireContinuationArmed() {
    return this.continuation;
  }
  setWireContinuationArmed(next) {
    this.continuation = next;
  }
}

function makeChannel(content) {
  const channel = new AgentUIChannel();
  channel.addUserMessage(content);
  return channel;
}

/** A channel with one user turn, with the image fixture freshly built. */
function makeImageChannel(prompt = "what is in this image?") {
  return makeChannel([{ type: "text", content: prompt }, imagePart()]);
}

function makeCompactionDeps(channel, cache = new WireProjectionCache()) {
  return {
    agentId: "wire-override-agent",
    manager: { getAgent: () => undefined },
    getCompactionConfig: () => ({}),
    getContextWindow: () => undefined,
    getUIChannel: () => channel,
    getUsage: () => ({ getWindowUsage: () => ({ inputTokens: 1 }), getContextFillTokens: () => 1 }),
    getTodoManager: () => undefined,
    shouldTriggerAutoCompact: () => false,
    status: { beginCompaction: noop, endCompaction: noop },
    log: undefined,
    emitEvent: noop,
    getWireProjectionCache: () => cache,
  };
}

/**
 * Build the real head of the pipeline under test: the compaction projection, the
 * tool-output projection, then the wire-override seam — the order `buildAgentRunner`
 * assembles them, and the order the seam depends on (a tool result only becomes a real
 * content part at `tool-compact`, so a strip placed earlier cannot see its media).
 */
function makeRunner(channel, run, { parentId } = {}) {
  const { adapter, calls } = makeCapturingAdapter();
  const middleware = sortMiddlewaresByPhase([
    createCompactionMiddleware(makeCompactionDeps(channel)),
    createToolCompactMiddleware({
      getCompactionConfig: () => ({}),
      getToolCompactCache: () => new ToolCompactCache(),
      // `parentId` marks a CHILD run. Tool-compact projects for both root and child runs now, so
      // this option no longer selects a "no projection" path — the fixture below that needs the
      // raw string uses a tool with no registered `toModelOutput` instead.
      getManagedAgent: () => ({
        parentId,
        getToolModelOutput: (name) => (name === "read_file" ? getToolMetadata(readFileTool)?.toModelOutput : undefined),
      }),
    }),
    createWireRecoveryMiddleware({ getRun: () => run }),
  ]);
  const runner = new AgentRunner({
    adapter,
    model: "capturing-model",
    middleware,
    maxIterations: 1,
  });
  return { runner, calls };
}

/**
 * Like {@link makeRunner}, plus the real `turn-context` seam so the synthetic
 * `<ctx kind=...>` path (the one that must stay durable) is exercised end to end.
 */
function makeRunnerWithContext(
  channel,
  run,
  sections = [{ key: "current_date", content: "<current_date>2026-09-17</current_date>" }]
) {
  const { adapter, calls } = makeCapturingAdapter();
  const middleware = sortMiddlewaresByPhase([
    createCompactionMiddleware(makeCompactionDeps(channel)),
    createWireRecoveryMiddleware({ getRun: () => run }),
    createTurnContextMiddleware({
      getFrozenSystemPrompt: () => undefined,
      getSections: async () => sections,
      getUIChannel: () => channel,
      persistMessages: noop,
      getManagedAgent: () => undefined,
    }),
  ]);
  const runner = new AgentRunner({
    adapter,
    model: "capturing-model",
    middleware,
    maxIterations: 1,
  });
  return { runner, calls };
}

async function drain(stream) {
  for await (const _chunk of stream) {
    void _chunk;
  }
}

/**
 * A fresh image part per use. A shared constant would let any section that replaces a
 * part object corrupt every later section, so a real fault would surface as an
 * unrelated assertion several sections down from the mutation.
 */
function imagePart() {
  return {
    type: "image",
    source: { type: "url", value: "data:image/png;base64,AAAA" },
    metadata: { mediaType: "image/png" },
  };
}

function wireHasImage(messages) {
  return JSON.stringify(messages).includes('"image"');
}

// ============================================================================
// 1. Capability strip reaches the adapter (and only then)
// ============================================================================

{
  const channel = makeImageChannel();
  const run = new TestRun();
  run.setWireDropPartTypes(new Set(["image"]));

  const { runner, calls } = makeRunner(channel, run);
  await drain(runner.run({ agentId: "wire-override-agent", messages: channel.getMessages(), detached: true }));

  assert.ok(calls.length > 0, "the adapter must be called");
  const wire = calls[0];
  assert.equal(
    wireHasImage(wire),
    false,
    "the capability strip must reach the adapter: a stripped image must not be present on the wire"
  );
  assert.ok(
    JSON.stringify(wire).includes(MULTIMODAL_OMITTED_PLACEHOLDER),
    "the stripped part must be replaced by the placeholder the model is told about"
  );
  assert.ok(wireHasImage(channel.getMessages()), "the channel must keep the original image — the strip is wire-only");
}

// ============================================================================
// 1b. The strip must also reach media that comes from a TOOL result
// ============================================================================
//
// The attachment above was the only fixture, and it is the easy half: its part is in the
// channel, so it reaches the wire whole. A tool result is different — the channel stores
// the RESULT OBJECT, so the wire carries it as JSON text until `tool-compact` projects it
// through the tool's `toModelOutput`, and only then does an image part exist. With the
// seam placed before that stage, this fixture went out with `"type":"image"` intact: a
// model without vision was sent the image, and the widened retry could not recover
// because the projection re-materializes it on every wire build.

/** The raw `ReadFileOutput` a `read_file` call leaves in the channel for an image. */
function rawImageReadOutput() {
  return {
    type: "image",
    path: "shot.png",
    mimeType: "image/png",
    size: 4,
    base64: "AAAA",
  };
}

/** Register the real `read_file` tool so `tool-compact` resolves its live `toModelOutput`. */
const readFileTool = createReadFileTool();

/** The projected form of that same result, as text — what a string `tool` content looks like. */
function stringifiedPartsImage() {
  return JSON.stringify([
    { type: "text", content: "Image read: shot.png (4 B)" },
    { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
  ]);
}

/**
 * A tool with no registered `toModelOutput`, i.e. the only way a string result still reaches the
 * strip unparsed now that projection runs for child runs too.
 */
const UNPROJECTED_TOOL = "render_widget";

/**
 * A channel with one user turn plus a `read_file` tool turn that returned an image.
 *
 * `content` defaults to the raw result object (what the projection consumes). Pass
 * {@link stringifiedPartsImage} plus `toolName: UNPROJECTED_TOOL` for the string form — the one that
 * survives to the wire when nothing re-parses it, which is the only form whose media the strip has
 * to reach itself.
 */
function makeToolMediaChannel(content = JSON.stringify(rawImageReadOutput()), { toolName = "read_file" } = {}) {
  const channel = new AgentUIChannel();
  channel.addUserMessage("read the screenshot");
  channel.setMessages([
    ...channel.getMessages(),
    {
      id: "assistant-tool-turn",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "call-img",
          name: toolName,
          arguments: JSON.stringify({ path: "shot.png" }),
          state: "complete",
          output: rawImageReadOutput(),
        },
        {
          type: "tool-result",
          toolCallId: "call-img",
          content,
          state: "complete",
        },
      ],
    },
  ]);
  return channel;
}

{
  const channel = makeToolMediaChannel();
  const run = new TestRun();
  run.setWireDropPartTypes(new Set(["image"]));

  const { runner, calls } = makeRunner(channel, run);
  await drain(runner.run({ agentId: "wire-override-agent", messages: channel.getMessages(), detached: true }));

  assert.ok(calls.length > 0, "the adapter must be called");
  const wire = calls[0];
  assert.equal(
    wireHasImage(wire),
    false,
    "a tool result's image must not reach a model without vision — it only becomes a part at " +
      "`tool-compact`, so the strip has to run after that stage"
  );
  assert.ok(
    JSON.stringify(wire).includes(MULTIMODAL_OMITTED_PLACEHOLDER),
    "the dropped tool media must be replaced by the placeholder, not silently vanish"
  );
  assert.ok(
    JSON.stringify(channel.getMessages()).includes("AAAA"),
    "the channel must keep the tool result — the strip is wire-only"
  );
}

// The same end-to-end rule for a CHILD run: `tool-compact` projects there too, so the media is an
// image part and only the strip can remove it. Before that projection reached children this block
// passed vacuously — the raw JSON text carried no media part for the strip to drop.
{
  const channel = makeToolMediaChannel();
  const run = new TestRun();
  run.setWireDropPartTypes(new Set(["image"]));

  const { runner, calls } = makeRunner(channel, run, { parentId: "parent-agent" });
  await drain(runner.run({ agentId: "wire-override-agent", messages: channel.getMessages(), detached: true }));

  assert.ok(calls.length > 0, "the adapter must be called for a child run");
  assert.equal(wireHasImage(calls[0]), false, "a CHILD run's projected tool image is stripped for a blind model");
  assert.ok(JSON.stringify(calls[0]).includes(MULTIMODAL_OMITTED_PLACEHOLDER), "…and replaced by the placeholder");
}

// The other half of that rule: a capable model still receives the projected tool media.
// A fix that dropped it unconditionally would read as correct in the block above.
{
  const channel = makeToolMediaChannel();
  const run = new TestRun();

  const { runner, calls } = makeRunner(channel, run);
  await drain(runner.run({ agentId: "wire-override-agent", messages: channel.getMessages(), detached: true }));

  assert.equal(wireHasImage(calls[0]), true, "a capable model must still receive a tool result's image part");
}

// ============================================================================
// 1c. ...and when the tool result arrives as STRING content
// ============================================================================
//
// Chat Completions accepts only string `tool` content, so TanStack stringifies an array result —
// and that string is what the adapter's lift re-parses, after every middleware, without consulting
// the drop set. This fixture drives the case where nothing upstream turns it into a part: its tool
// has NO registered `toModelOutput`, so `tool-compact` leaves the string alone and the media is only
// reachable here. (A projected result — every built-in tool, on root AND child runs — arrives as a
// parts array instead; that shape is covered by 1a/1b and by `validate:tool-compact`.) The rewrite
// must stay a STRING: that is the only thing this wire format accepts.

{
  const channel = makeToolMediaChannel(stringifiedPartsImage(), { toolName: UNPROJECTED_TOOL });
  const run = new TestRun();
  run.setWireDropPartTypes(new Set(["image"]));

  const { runner, calls } = makeRunner(channel, run, { parentId: "parent-agent" });
  await drain(runner.run({ agentId: "wire-override-agent", messages: channel.getMessages(), detached: true }));

  const wire = calls[0];
  assert.equal(wireHasImage(wire), false, "an unprojected tool image must not reach a model without vision");
  assert.ok(
    JSON.stringify(wire).includes(MULTIMODAL_OMITTED_PLACEHOLDER),
    "the stringified tool result must be rewritten with the placeholder, not passed through"
  );
  assert.ok(
    !JSON.stringify(wire).includes("AAAA"),
    "the base64 must be gone from the wire, not merely ignored by the lift"
  );
  const toolMessage = wire.find((message) => message.role === "tool");
  assert.equal(
    typeof toolMessage?.content,
    "string",
    "Chat Completions accepts only string tool content, so the rewrite must re-serialize"
  );
}

// The capable-model half again: with nothing armed the stringified result is untouched, so the
// adapter's lift can still revive it.
{
  const channel = makeToolMediaChannel(stringifiedPartsImage(), { toolName: UNPROJECTED_TOOL });
  const run = new TestRun();

  const { runner, calls } = makeRunner(channel, run, { parentId: "parent-agent" });
  await drain(runner.run({ agentId: "wire-override-agent", messages: channel.getMessages(), detached: true }));

  assert.equal(
    JSON.stringify(calls[0]).includes("AAAA"),
    true,
    "a capable model's tool result must keep its media for the lift to revive"
  );
}

// ============================================================================
// 2. Without an armed strip the image reaches the adapter untouched
//    (guards against the seam over-reaching into a capable model's wire)
// ============================================================================

{
  const channel = makeImageChannel();
  const run = new TestRun();

  const { runner, calls } = makeRunner(channel, run);
  await drain(runner.run({ agentId: "wire-override-agent", messages: channel.getMessages(), detached: true }));

  assert.equal(wireHasImage(calls[0]), true, "a capable model must still receive the image part");
  assert.equal(
    JSON.stringify(calls[0]).includes(MULTIMODAL_OMITTED_PLACEHOLDER),
    false,
    "no placeholder may appear when no strip is armed"
  );
}

// ============================================================================
// 3. The continuation prompt reaches the adapter
// ============================================================================

{
  const channel = makeChannel("please write a long essay");
  const run = new TestRun();
  run.setWireContinuationArmed(true);

  const { runner, calls } = makeRunner(channel, run);
  await drain(runner.run({ agentId: "wire-override-agent", messages: channel.getMessages(), detached: true }));

  assert.ok(
    JSON.stringify(calls[0]).includes(CONTINUATION_PROMPT),
    "the max_tokens continuation prompt must reach the adapter, not just the array passed to run()"
  );
  assert.equal(
    JSON.stringify(channel.getMessages()).includes(CONTINUATION_PROMPT),
    false,
    "the continuation prompt must stay wire-only — never written to the channel"
  );
}

// ============================================================================
// 4. Both overrides compose (a truncated turn on a model without vision)
// ============================================================================

{
  const channel = makeImageChannel("describe this");
  const run = new TestRun();
  run.setWireDropPartTypes(new Set(["image"]));
  run.setWireContinuationArmed(true);

  const { runner, calls } = makeRunner(channel, run);
  await drain(runner.run({ agentId: "wire-override-agent", messages: channel.getMessages(), detached: true }));

  assert.equal(wireHasImage(calls[0]), false, "the strip still applies on a truncated turn");
  assert.ok(JSON.stringify(calls[0]).includes(CONTINUATION_PROMPT), "the continuation still applies");
}

// ============================================================================
// 5. The seam returns {} when nothing is armed (zero-overhead contract)
// ============================================================================

{
  const run = new TestRun();
  const seam = createWireRecoveryMiddleware({ getRun: () => run });
  const result = await seam.onConfig({ phase: "init" }, { messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(result, {}, "an unarmed seam must not touch the config at all");
}

// ============================================================================
// 6. The producers arm the run instead of editing messages
//    (unit-level: a producer regression would otherwise only surface as a run that
//    silently never continues, with no wiring-level symptom in section 3)
// ============================================================================

{
  // max_tokens continuation: arming the run, never appending to the handed-in array.
  const run = new TestRun();
  const managed = { run, log: { debug: noop, warn: noop, error: noop }, getMessagesForLLM: () => [] };
  const truncation = createTruncationState();
  truncation.maxTokensEscalated = true; // skip the escalation branch

  const handedIn = [{ role: "user", content: "hi" }];
  const first = handleMaxTokensTruncation({ managed, truncation });
  assert.equal(first.shouldRetry, true, "a truncation with budget left must retry");
  assert.equal(
    first.countsAsRecoveryAttempt,
    true,
    "a continuation is a real model call — it must spend a recovery attempt"
  );
  assert.equal(run.isWireContinuationArmed(), true, "the continuation must be armed on the run");
  assert.equal(
    JSON.stringify(handedIn).includes(CONTINUATION_PROMPT),
    false,
    "the producer must not edit the messages it was handed — the projection would discard that"
  );

  // The escalation is a config change, not a retry attempt, so it must not spend
  // the error-recovery budget (a run that truncated a few times would otherwise
  // lose its only transient backoff).
  const escalationRun = new TestRun();
  const escalation = handleMaxTokensTruncation({
    managed: { run: escalationRun, log: { debug: noop, warn: noop, error: noop }, getMessagesForLLM: () => [] },
    runner: {},
    truncation: createTruncationState(),
  });
  assert.equal(escalation.shouldRetry, true, "the escalation retries");
  assert.equal(escalation.countsAsRecoveryAttempt, false, "the escalation must not spend a recovery attempt");
  assert.equal(escalationRun.isWireContinuationArmed(), false, "the escalation does not arm the continuation prompt");
  assert.ok(
    escalationRun.getMaxOutputTokensOverride() > 0,
    "the escalation lands on the run scope, not the cached runner"
  );

  // Budget exhausted → stop retrying, and the labelled attempt never exceeds the cap.
  // (Re-assign rather than reuse the state above: `handleMaxTokensTruncation`
  // mutates the escalation flag / continuation count it is handed.)
  truncation.continuationCount = 3;
  assert.equal(handleMaxTokensTruncation({ managed, truncation }).shouldRetry, false, "no retry past the cap");
  assert.deepEqual(
    readTruncationProgress({ maxTokensEscalated: true, continuationCount: 0 }),
    { attempt: 1, maxAttempts: MAX_TRUNCATION_CONTINUATIONS + 1 },
    "the escalation is attempt 1"
  );
  for (let n = 0; n <= MAX_TRUNCATION_CONTINUATIONS; n++) {
    const progress = readTruncationProgress({ maxTokensEscalated: true, continuationCount: n });
    assert.ok(
      progress.attempt <= progress.maxAttempts,
      `truncation attempt ${progress.attempt} must not exceed ${progress.maxAttempts}`
    );
  }

  // Capability strip: armed on the run, with the drop set the probe reports.
  const stripRun = new TestRun();
  const stripManaged = {
    run: stripRun,
    usage: { hasCapability: (cap) => cap !== "vision" },
    log: { debug: noop, warn: noop, error: noop },
  };
  assert.equal(armCapabilityStrip(stripManaged), true, "a model without vision arms a strip");
  const armedDrop = stripRun.getWireDropPartTypes();
  assert.ok(armedDrop, "the capability strip must actually be stored on the run, not discarded");
  assert.deepEqual([...armedDrop], ["image"], "only the unsupported modality is dropped");

  const fullRun = new TestRun();
  assert.equal(
    armCapabilityStrip({
      run: fullRun,
      usage: { hasCapability: () => true },
      log: { warn: noop, debug: noop, error: noop },
    }),
    false,
    "a fully capable model arms no strip"
  );
  assert.equal(fullRun.getWireDropPartTypes(), null, "no drop set is stored when nothing is unsupported");
}

// ============================================================================
// 7. Placement: the seam must sit after the channel projection
// ============================================================================

{
  const channel = makeImageChannel("hi");
  const { calls, adapter } = makeCapturingAdapter();
  const run = new TestRun();
  run.setWireDropPartTypes(new Set(["image"]));

  // Deliberately reversed: recovery seam BEFORE compaction. The projection then
  // discards the strip, which is the regression this guard exists to catch.
  const reversed = sortMiddlewaresByPhase([
    createWireRecoveryMiddleware({ getRun: () => run }),
    createCompactionMiddleware(makeCompactionDeps(channel)),
  ]);
  const runner = new AgentRunner({ adapter, model: "capturing-model", middleware: reversed, maxIterations: 1 });
  await drain(runner.run({ agentId: "wire-override-agent", messages: channel.getMessages(), detached: true }));

  assert.equal(
    wireHasImage(calls[0]),
    true,
    "this assertion documents the failure mode: with the seam before compaction the strip is " +
      "discarded by the projection and the image reaches the adapter anyway"
  );
}

// ============================================================================
// 8. The overrides are wire-only: the persisted session keeps the original media
//    (the shared nested-object path is the only way a strip could become durable)
// ============================================================================

/**
 * Persist through the real `SessionService` (dehydrate → media store → log) and
 * return both the raw log bytes and the reloaded session, so assertions can be
 * made on what a *later process* would actually see.
 */
async function persistAndReload(channel) {
  const store = new SessionStore();
  const service = new SessionService();
  service.setStore(store, { modelStyle: "openai", model: "capturing-model" });
  service.ensureSessionData();
  const usage = new UsageTracker({
    model: "capturing-model",
    modelStyle: "openai",
    provider: "test",
    getMessagesForLLM: () => [],
    log: undefined,
  });
  await service.persistSession({ usage, todoManager: null, uiMessages: channel.getMessages(), emitEvent: noop });
  const sessionId = service.getSessionData().id;
  const logPath = [...files.keys()].find((key) => key.includes(sessionId));
  assert.ok(logPath, "the persist must write a session log");
  const raw = files.get(logPath);
  const loaded = await store.load(sessionId);
  return { raw, loaded, sessionId };
}

{
  const channel = makeImageChannel();
  const run = new TestRun();
  run.setWireDropPartTypes(new Set(["image"]));
  run.setWireContinuationArmed(true);

  const { runner } = makeRunner(channel, run);
  await drain(runner.run({ agentId: "wire-override-agent", messages: channel.getMessages(), detached: true }));

  const { raw, loaded } = await persistAndReload(channel);

  assert.equal(
    raw.includes(MULTIMODAL_OMITTED_PLACEHOLDER),
    false,
    "the capability strip must not be durable: the strip is wire-only, so the persisted session " +
      "must not carry the placeholder that replaced the user's image"
  );
  assert.equal(
    JSON.stringify(loaded.uiMessages).includes(MULTIMODAL_OMITTED_PLACEHOLDER),
    false,
    "the capability strip must not come back after a reload"
  );
  assert.equal(
    raw.includes(CONTINUATION_PROMPT),
    false,
    "the max_tokens continuation prompt must not be durable: it is wire-only, so it must never " +
      "appear in the persisted session log"
  );
  assert.ok(
    loaded.uiMessages.some((message) => JSON.stringify(message).includes('"type":"image"')),
    "the user's image must survive the run: a wire-only strip left the channel, and therefore the " +
      "persisted session, intact"
  );
  assert.equal(
    loaded.uiMessages.some((message) => message.parts?.some((part) => part.type === "tool-call")),
    false,
    "sanity: this fixture has no tool calls"
  );
}

// ============================================================================
// 9. The synthetic turn-context message IS durable (the wire-only rule is not
//    "nothing the middleware touches may persist" — this one must)
// ============================================================================

{
  const channel = makeChannel("hello");
  const run = new TestRun();
  const { runner } = makeRunnerWithContext(channel, run);
  await drain(runner.run({ agentId: "wire-override-agent", messages: channel.getMessages(), detached: true }));

  const { raw, loaded } = await persistAndReload(channel);

  const ctxCount = loaded.uiMessages.filter((message) => message.id?.startsWith("ctx-")).length;
  assert.equal(ctxCount, 1, `the synthetic ctx must be persisted exactly once (got ${ctxCount})`);
  assert.ok(raw.includes("ctx kind=current_date"), "the synthetic ctx content must be on disk");
}

// ============================================================================
// 10. The round trip: restore the persisted session, then run again.
//     The ctx must not be re-injected, the strip must still reach the wire, and
//     the media must come back (dehydrate → media:// → hydrate).
// ============================================================================

{
  const channel = makeImageChannel("describe this");
  const run = new TestRun();
  run.setWireDropPartTypes(new Set(["image"]));
  const { runner } = makeRunnerWithContext(channel, run);
  await drain(runner.run({ agentId: "wire-override-agent", messages: channel.getMessages(), detached: true }));

  const { raw, loaded } = await persistAndReload(channel);
  assert.ok(raw.includes("media://"), "the base64 must be extracted to a media:// reference on disk");
  assert.equal(raw.includes("base64"), false, "raw base64 must not be left inline in the session log");

  // Restore into a fresh channel, exactly as `restoreManagedSession` does.
  const restored = new AgentUIChannel();
  restored.setMessages(loaded.uiMessages);
  assert.ok(
    JSON.stringify(restored.getMessages()).includes('"type":"image"'),
    "the restored channel must carry the image part back"
  );

  const run2 = new TestRun();
  run2.setWireDropPartTypes(new Set(["image"]));
  const { runner: runner2, calls: calls2 } = makeRunnerWithContext(restored, run2);
  await drain(runner2.run({ agentId: "wire-override-agent", messages: restored.getMessages(), detached: true }));

  const wire = JSON.stringify(calls2[0]);
  assert.equal(wire.includes('"image"'), false, "the strip must still apply after a restore");
  assert.equal(
    calls2[0].filter((message) => JSON.stringify(message).includes("<ctx kind=current_date>")).length,
    1,
    "the synthetic ctx must not be re-injected after a restore — its stable content-hash id makes " +
      "the injection idempotent across restore, which is what keeps the prefix cache stable"
  );
  assert.equal(
    restored.getMessages().filter((message) => message.id?.startsWith("ctx-")).length,
    1,
    "a second run must not re-append the ctx to the channel"
  );
}

// ============================================================================
// 11. Ordering: each omitted attachment keeps its own identity on the wire
//     The placeholder exists so the model can tell WHICH attachment of a session
//     was dropped. Merging them into one trailing constant (the old behaviour)
//     lost the count and the position, so the pairing with the `[Image #N]` text
//     ref was unrecoverable.
// ============================================================================

{
  const attachment = (base64, imageIndex, filename) => ({
    type: "image",
    source: { type: "url", value: `data:image/png;base64,${base64}` },
    metadata: { imageIndex, filename },
  });
  const channel = new AgentUIChannel();
  channel.addUserMessage([
    { type: "text", content: "[Image #1: a.png] first" },
    attachment("aaa", 1, "a.png"),
    { type: "text", content: "then" },
    attachment("bbb", 2, "b.png"),
    { type: "document", source: { type: "data", value: "JVBERi0x", mimeType: "application/pdf" } },
  ]);

  const run = new TestRun();
  run.setWireDropPartTypes(new Set(["image", "document"]));
  const { runner, calls } = makeRunner(channel, run);
  await drain(runner.run({ agentId: "wire-override-agent", messages: channel.getMessages(), detached: true }));

  const wire = JSON.stringify(calls[0]);
  assert.equal(wire.includes('"image"'), false, "no image part may reach a vision-less adapter");

  // Each placeholder must sit where its media was, naming the same index/file as the text ref.
  const first = wire.indexOf("[Image #1: a.png omitted");
  const middle = wire.indexOf("then");
  const second = wire.indexOf("[Image #2: b.png omitted");
  assert.ok(first >= 0 && second >= 0, "each dropped image must name its index and file");
  assert.ok(
    first < middle && middle < second,
    "a merged trailing placeholder would lose the ordering the [Image #N] refs describe: " + wire
  );
  assert.ok(
    wire.indexOf(MULTIMODAL_OMITTED_PLACEHOLDER) > second,
    "a part without identity keeps the generic placeholder, after the named ones"
  );
  assert.equal(
    channel.getMessages()[0].parts.filter((part) => part.type === "image").length,
    2,
    "the channel must still carry both images — the placeholder is wire-only"
  );
}

console.log("wire-override-reaches-adapter validation passed");
