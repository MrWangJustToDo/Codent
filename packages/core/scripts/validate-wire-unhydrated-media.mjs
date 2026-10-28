/**
 * Unhydrated media must never reach a provider.
 *
 * A restored session whose media file is gone keeps `source.value = "media://<hash>.<ext>"` in the
 * runtime transcript (`hydrateUIMessages` reports the miss and degrades to the stored form). That
 * value is not a URL any provider can fetch, so sending it fails the request — and
 * `isMultimodalUnsupportedError` does not recognise a loader failure, so the widened capability
 * retry cannot rescue it: every later turn fails identically.
 *
 * The wire seam therefore replaces those parts with identity-carrying text placeholders, gated on a
 * boolean the restore reports. This script pins five things:
 *
 *   1. the replacement reaches the adapter (through the real pipeline, after `compaction`);
 *   2. it is wire-only — the channel keeps the `media://` part, so restoring the media directory
 *      brings the image back;
 *   3. the gate is real: with no misses reported, the wire is untouched (zero-overhead contract);
 *   4. it composes with the capability strip in the useful direction — a model that cannot take the
 *      part is told "omitted — no vision" (actionable) rather than "unavailable" (blames the file);
 *   5. the stringified tool-result form is rewritten too, and stays a string.
 *
 * Run: pnpm --filter @codent/core run validate:wire-unhydrated-media
 */

"use strict";

import assert from "node:assert/strict";

import {
  AgentRunner,
  AgentUIChannel,
  ToolCompactCache,
  WireProjectionCache,
  createCompactionMiddleware,
  CompactionController,
  createToolCompactMiddleware,
  createWireRecoveryMiddleware,
  registerCoreEnv,
  sortMiddlewaresByPhase,
} from "../dist/dev.mjs";

// ---------------------------------------------------------------------------
// Env stub (the runner resolves a tool context before the first wire call)
// ---------------------------------------------------------------------------
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
      files.set(p, content);
    },
    async appendFile(p, content) {
      files.set(p, content);
    },
    async mkdir() {},
    async exists(p) {
      return files.has(p);
    },
    async readdir(p) {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const names = new Set();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        names.add(rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest);
      }
      return [...names].map((name) => ({ name, type: "file" }));
    },
    async remove(p) {
      files.delete(p);
    },
    async stat(p) {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return { size: 1, isFile: true, isDirectory: false };
    },
  },
  runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  fetch: async () => new Response("", { status: 200 }),
});

const noop = () => {};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
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

class TestRun {
  drop = null;
  continuation = false;
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

function makeCompactionDeps(channel) {
  return {
    agentId: "unhydrated-agent",
    manager: { getAgent: () => undefined },
    getCompactionConfig: () => ({}),
    getContextWindow: () => undefined,
    getUIChannel: () => channel,
    getUsage: () => ({ getWindowUsage: () => ({ inputTokens: 1 }), getContextFillTokens: () => 1 }),
    getTodoManager: () => undefined,
    shouldTriggerAutoCompact: () => false,
    compactions: new CompactionController({
      getStatus: () => "running",
      setStatus: noop,
      onUserCancel: noop,
      emitEvent: noop,
    }),
    log: undefined,
    emitEvent: noop,
    getWireProjectionCache: () => new WireProjectionCache(),
  };
}

function makeRunner(channel, run, { parentId, hasUnhydratedMedia } = {}) {
  const { adapter, calls } = makeCapturingAdapter();
  const middleware = sortMiddlewaresByPhase([
    createCompactionMiddleware(makeCompactionDeps(channel)),
    createToolCompactMiddleware({
      getCompactionConfig: () => ({}),
      getToolCompactCache: () => new ToolCompactCache(),
      getManagedAgent: () => ({ parentId }),
    }),
    createWireRecoveryMiddleware({
      getRun: () => run,
      ...(hasUnhydratedMedia ? { hasUnhydratedMedia } : {}),
    }),
  ]);
  const runner = new AgentRunner({ adapter, model: "capturing-model", middleware, maxIterations: 1 });
  return { runner, calls };
}

async function drain(stream) {
  for await (const _chunk of stream) void _chunk;
}

async function runOnce(channel, run, options) {
  const { runner, calls } = makeRunner(channel, run, options);
  await drain(runner.run({ agentId: "unhydrated-agent", messages: channel.getMessages(), detached: true }));
  assert.ok(calls.length > 0, "the adapter must be called");
  return calls.at(-1);
}

/** A user turn whose attachment is still a `media://` ref (the restore could not read the file). */
function makeUnhydratedChannel() {
  const channel = new AgentUIChannel();
  channel.addUserMessage([
    { type: "text", content: "[Image #1: gone.png] what was in this?" },
    {
      type: "image",
      source: { type: "url", value: "media://0123abcd.png" },
      metadata: { imageIndex: 1, filename: "gone.png", mediaRef: { hash: "0123abcd", mimeType: "image/png" } },
    },
  ]);
  return channel;
}

// ============================================================================
// 1. The replacement reaches the adapter, in place, naming the attachment
// ============================================================================
{
  const channel = makeUnhydratedChannel();
  const wire = await runOnce(channel, new TestRun(), { hasUnhydratedMedia: () => true });
  const text = JSON.stringify(wire);

  assert.equal(text.includes("media://"), false, "a media:// ref must never reach a provider: it is not fetchable");
  assert.ok(
    text.includes("[Image #1: gone.png unavailable — its file is missing from this workspace.]"),
    `the placeholder must name the attachment so the ordering survives (wire: ${text})`
  );

  // 2. Wire-only: the channel keeps the ref, so restoring the media directory brings the image back.
  const keptPart = channel.getMessages()[0].parts.find((part) => part.type === "image");
  assert.equal(keptPart?.source.value, "media://0123abcd.png", "the channel must keep the dehydrated ref");
  assert.equal(
    JSON.stringify(channel.getMessages()).includes("unavailable"),
    false,
    "the replacement must not be written back into the channel"
  );
}

// ============================================================================
// 3. The gate is real: no reported misses -> no scan, no rewrite
// ============================================================================
{
  const channel = makeUnhydratedChannel();
  const wire = await runOnce(channel, new TestRun(), { hasUnhydratedMedia: () => false });
  // Documents the failure this pass exists to prevent — with the flag off (nothing reported the
  // miss) the unfetchable ref would go out as-is.
  assert.ok(JSON.stringify(wire).includes("media://"), "the gate must be the restore's report, not a scan");
}

// ============================================================================
// 4. Compose with the capability strip: "omitted" wins when the model cannot take it anyway
// ============================================================================
{
  const channel = makeUnhydratedChannel();
  const run = new TestRun();
  run.setWireDropPartTypes(new Set(["image"]));
  const wire = await runOnce(channel, run, { hasUnhydratedMedia: () => true });
  const text = JSON.stringify(wire);

  assert.equal(text.includes("media://"), false);
  assert.ok(
    text.includes("[Image #1: gone.png omitted — current model has no vision input.]"),
    "for a model without vision the actionable report is 'omitted — no vision', not 'unavailable'"
  );
  assert.equal(text.includes("unavailable"), false, "the two reasons must not both be reported for one part");
}

// ============================================================================
// 5. The stringified tool-result form is rewritten too, and stays a string
// ============================================================================
{
  const toolResult = JSON.stringify([
    { type: "text", content: "Image read: shot.png (4 B)" },
    {
      type: "image",
      source: { type: "url", value: "media://deadbeef.png" },
      metadata: { filename: "shot.png" },
    },
  ]);

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
          name: "read_file",
          arguments: JSON.stringify({ path: "shot.png" }),
          state: "complete",
          output: { type: "image", path: "shot.png", base64: "", mimeType: "image/png", size: 4 },
        },
        { type: "tool-result", toolCallId: "call-img", content: toolResult, state: "complete" },
      ],
    },
  ]);

  // `parentId` set = subagent path: the tool result is not projected into parts, so the string form
  // is what reaches the seam.
  const wire = await runOnce(channel, new TestRun(), { parentId: "parent-agent", hasUnhydratedMedia: () => true });
  const text = JSON.stringify(wire);
  const toolMessage = wire.find((message) => message.role === "tool");

  assert.equal(text.includes("media://"), false, "nested media refs must be replaced too");
  assert.equal(typeof toolMessage?.content, "string", "Chat Completions accepts only string tool content");
  assert.ok(
    toolMessage.content.includes("[Image: shot.png unavailable"),
    `the nested part must keep its identity (content: ${toolMessage.content})`
  );
  assert.ok(
    JSON.stringify(channel.getMessages()).includes("media://deadbeef.png"),
    "the channel must keep the nested ref as well"
  );
}

console.log("wire-unhydrated-media validation passed");
