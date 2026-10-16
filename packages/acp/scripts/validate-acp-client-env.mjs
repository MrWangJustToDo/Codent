/**
 * `--client-env` conformance: the client-backed CoreEnv and everything it must NOT do.
 *
 * The subject here is the env itself, not the ACP transport, so most checks call the env directly
 * (`createAcpClientEnv` over a recording client) — a request log is the most direct evidence for
 * claims like "`.agents/**` never reaches the client" and "`fs/read_text_file` carries no line
 * argument". The last section drives the whole ACP app to prove the flag's two states and that
 * `execFile` really is what routes to `terminal/create`.
 *
 * Run: pnpm --filter @codent/acp run validate:acp:client-env
 */

import { client as createClient, methods } from "@agentclientprotocol/sdk";
import fs from "node:fs/promises";
import path from "node:path";

import { createAcpAgent, createAcpClientEnv, isLocalOnlyPath, resolveRoot, toWirePath } from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";

const checker = createChecker();
const check = checker.check;

// ===========================================================================
// A recording client + a recording fallback
// ===========================================================================

/** Every client request the env makes, in order. */
const requests = [];

/** Terminal exit status returned by the next `terminal/output`, per terminal. */
const terminalScript = new Map();

function recordingClient() {
  return {
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === methods.client.fs.readTextFile) return { content: `remote:${params.path}` };
      if (method === methods.client.fs.writeTextFile) return {};
      if (method === methods.client.terminal.create) {
        const terminalId = `t${requests.length}`;
        terminalScript.set(terminalId, { output: "remote-stdout", exitCode: 0, polls: 0 });
        return { terminalId };
      }
      if (method === methods.client.terminal.output) {
        const script = terminalScript.get(params.terminalId);
        script.polls += 1;
        // First poll: still running (no exitStatus). Second: done. This is what makes the loop's
        // bounded-poll structure observable rather than a single-shot read.
        if (script.polls < 2) return { output: "", truncated: false };
        return { output: script.output, truncated: false, exitStatus: { exitCode: script.exitCode } };
      }
      if (method === methods.client.terminal.release) return {};
      throw new Error(`unexpected client method: ${method}`);
    },
  };
}

/** A fallback whose every call is recorded, so "delegated" is provable rather than assumed. */
const fallbackCalls = [];
const fallbackEnv = {
  rootPath: "/ws",
  path: { resolve: (...p) => p.join("/"), normalize: (p) => p, isAbsolute: (p) => p.startsWith("/") },
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({ FALLBACK: "1" }),
  homedir: async () => "/home/me",
  cwd: async () => "/ws",
  byteLength: (s) => s.length,
  base64Encode: () => "",
  base64Decode: () => new Uint8Array(),
  fs: {
    readFile: async (p, enc) => {
      fallbackCalls.push(["readFile", p, enc]);
      return enc === "buffer" ? new Uint8Array([1]) : `local:${p}`;
    },
    writeFile: async (p) => void fallbackCalls.push(["writeFile", p]),
    stat: async (p) => {
      fallbackCalls.push(["stat", p]);
      return { isDirectory: false, isFile: true, size: 3, mtime: new Date(0) };
    },
    readdir: async (p) => {
      fallbackCalls.push(["readdir", p]);
      return [{ name: "a.ts", type: "file" }];
    },
    mkdir: async (p) => void fallbackCalls.push(["mkdir", p]),
    exists: async (p) => {
      fallbackCalls.push(["exists", p]);
      return true;
    },
    remove: async (p) => void fallbackCalls.push(["remove", p]),
    appendFile: async (p) => void fallbackCalls.push(["appendFile", p]),
    rename: async (from, to) => void fallbackCalls.push(["rename", from, to]),
    // Deliberately no `readFileRange`: the fallback's own shape should not leak a range read into
    // the client env (the client env omits it on purpose).
  },
  runCommand: async (command) => {
    fallbackCalls.push(["runCommand", command]);
    return { stdout: "local-shell", stderr: "", exitCode: 0 };
  },
  exec: async (command) => {
    fallbackCalls.push(["exec", command]);
    return { stdout: "local-exec", stderr: "", exitCode: 0 };
  },
  startCommand: async (c) => {
    fallbackCalls.push(["startCommand", c]);
    return { id: "job1", kill: async () => {}, onExit: () => {} };
  },
  getShellInfo: async () => {
    fallbackCalls.push(["getShellInfo"]);
    return { shell: "/bin/bash", kind: "bash" };
  },
  fetch: async () => new Response(""),
};

function reset() {
  requests.length = 0;
  fallbackCalls.length = 0;
  terminalScript.clear();
}

const fullCaps = { readTextFile: true, writeTextFile: true, terminal: true };
const sessionId = () => "ses_1";

function makeEnv(caps = fullCaps, rootPath = "/ws") {
  return createAcpClientEnv({
    client: recordingClient,
    sessionId,
    rootPath,
    fallback: fallbackEnv,
    caps,
  });
}

// ===========================================================================
// 1. The local-only guard itself
// ===========================================================================

{
  check("`.agents` at the root is local-only", isLocalOnlyPath("/ws", "/ws/.agents"));
  check("`.agents/logs/...` is local-only", isLocalOnlyPath("/ws", "/ws/.agents/logs/x/agent.log"));
  check("a RELATIVE `.agents/...` is local-only", isLocalOnlyPath("/ws", ".agents/sessions/a.jsonl"));
  check("a workspace source file is not local-only", !isLocalOnlyPath("/ws", "/ws/src/index.ts"));
  check("a relative workspace file is not local-only", !isLocalOnlyPath("/ws", "src/index.ts"));
  check("outside the root is local-only", isLocalOnlyPath("/ws", "/etc/passwd"));
  check("`..` traversal out of the root is local-only", isLocalOnlyPath("/ws", "../secrets.txt"));
  // A prefix test on the string would call this local when it is an ordinary file.
  check("a file NAMED `.agentsomething` is not local-only", !isLocalOnlyPath("/ws", "/ws/.agentsomething"));
}

// ===========================================================================
// 2. Read / write routing
// ===========================================================================

{
  reset();
  const env = makeEnv();
  const content = await env.fs.readFile("/ws/src/a.ts");
  check("a workspace read goes to the client", content === "remote:/ws/src/a.ts");
  check("the read carried the session id", requests[0]?.params?.sessionId === "ses_1");
  check(
    "the read carried NO line/limit (core has no line semantics)",
    !("line" in (requests[0]?.params ?? {})) && !("limit" in (requests[0]?.params ?? {}))
  );
  check("the client's read did not touch the fallback", fallbackCalls.length === 0);

  reset();
  await env.fs.writeFile("/ws/src/a.ts", "hello");
  check("a workspace write goes to the client", requests[0]?.method === methods.client.fs.writeTextFile);
  check("the write carried the content", requests[0]?.params?.content === "hello");

  reset();
  const binary = await env.fs.readFile("/ws/src/a.bin", "buffer");
  check("a binary read is served locally (the client method is text-only)", binary instanceof Uint8Array);
  check("the binary read made no client request", requests.length === 0);
  check(
    "the binary read used the fallback",
    fallbackCalls.some((c) => c[0] === "readFile" && c[2] === "buffer")
  );

  reset();
  await env.fs.writeFile("/ws/src/a.bin", new Uint8Array([1, 2]));
  check("a binary write is served locally", requests.length === 0 && fallbackCalls.some((c) => c[0] === "writeFile"));

  // A byte read is ALWAYS local: decoding the client's text back to bytes would corrupt anything
  // that is not valid UTF-8, so byte reads never take the client path even with full capability.
  reset();
  const bytes = await env.fs.readFile("/ws/src/a.png", "buffer");
  check("a byte read makes no client request even with full capability", requests.length === 0);
  check(
    "a byte read is served by the fallback",
    fallbackCalls.some((c) => c[0] === "readFile" && c[2] === "buffer")
  );
  check("the byte read returned bytes", bytes instanceof Uint8Array);
}

// ===========================================================================
// 3. `.agents/**` and outside-root never reach the client
// ===========================================================================

{
  reset();
  const env = makeEnv();
  await env.fs.readFile("/ws/.agents/sessions/ses_1.session.jsonl");
  await env.fs.writeFile("/ws/.agents/logs/ses_1/agent.log", "line");
  await env.fs.writeFile("/ws/.agents/media/x.png", "bytes");
  check("`.agents/**` reads and writes make ZERO client requests", requests.length === 0);
  check("`.agents/**` was served by the fallback", fallbackCalls.filter((c) => c[0] === "readFile").length === 1);

  reset();
  await env.fs.readFile("/etc/passwd");
  await env.fs.writeFile("/tmp/outside.txt", "x");
  check("outside-root reads and writes make ZERO client requests", requests.length === 0);
}

// ===========================================================================
// 4. Capability matrix — degrade by fallback, never by throwing
// ===========================================================================

{
  // Read-only client: reads remote, writes local — and crucially the write must NOT throw.
  reset();
  const env = makeEnv({ readTextFile: true, writeTextFile: false, terminal: false });
  const read = await env.fs.readFile("/ws/src/a.ts");
  check("a read-only client still reads remotely", read === "remote:/ws/src/a.ts");
  const wrote = await env.fs
    .writeFile("/ws/src/a.ts", "x")
    .then(() => "resolved")
    .catch((e) => `threw:${e.message}`);
  check("a write with no write capability falls back instead of throwing", wrote === "resolved");
  check(
    "the write reached the fallback",
    fallbackCalls.some((c) => c[0] === "writeFile")
  );

  // No fs at all: everything must be served locally and still work.
  reset();
  const bare = makeEnv({ readTextFile: false, writeTextFile: false, terminal: false });
  const localRead = await bare.fs.readFile("/ws/src/a.ts");
  check("no fs capability ⇒ reads fall back", localRead === "local:/ws/src/a.ts");
  check("required members keep working with no fs capability", (await bare.fs.readdir("/ws/src")).length === 1);
  check("stat keeps working with no fs capability", (await bare.fs.stat("/ws/src")).size === 3);
  check("exists keeps working with no fs capability", (await bare.fs.exists("/ws/src")) === true);
  check("no fs capability ⇒ zero client requests", requests.length === 0);
  check(
    "readdir/stat/exists all reached the fallback",
    ["readdir", "stat", "exists"].every((m) => fallbackCalls.some((c) => c[0] === m))
  );

  // `execFile` must be ABSENT, not defined-and-throwing: feature detection reads existence.
  check("execFile is not defined without terminal capability", !("execFile" in bare));
  check("canExecArgs-style detection reads 'unsupported'", Boolean(bare.execFile) === false);

  // And absent `readFileRange` (the client env never defines it, capability or not).
  check("readFileRange is never defined on the client env", !("readFileRange" in makeEnv()));
  check("readFileRange is not defined even on the bare env", !("readFileRange" in bare));
}

// ===========================================================================
// 5. Free-text commands stay local; only execFile uses the terminal
// ===========================================================================

{
  reset();
  const env = makeEnv();
  const ran = await env.runCommand("echo hi | cat");
  const executed = await env.exec("ls -la");
  check("runCommand is served by the fallback", ran.stdout === "local-shell");
  check("exec is served by the fallback", executed.stdout === "local-exec");
  check("free-text commands make ZERO client requests", requests.length === 0);
  check("the command default cwd follows the fallback, not process.cwd()", (await env.cwd()) === "/ws");

  reset();
  const result = await env.execFile("grep", ["-n", "x", "/ws/src/a.ts"]);
  check("execFile goes through terminal/create", requests[0]?.method === methods.client.terminal.create);
  check("the terminal request carries command + args, not a shell string", requests[0]?.params?.command === "grep");
  check("args are passed as an array", Array.isArray(requests[0]?.params?.args));
  check("execFile returns the COMPLETE stdout", result.stdout === "remote-stdout");
  check("execFile returns an exit code", result.code === 0);
  check("execFile polls more than once (bounded, not single-shot)", terminalScript.values().next().value.polls >= 2);
  check(
    "the terminal is released",
    requests.some((r) => r.method === methods.client.terminal.release)
  );
  check("execFile did not touch the fallback", fallbackCalls.length === 0);
}

// ===========================================================================
// 6. The ACP app: flag off ⇒ no client env at all; flag on ⇒ per-session runtimes
// ===========================================================================

function fakeSession(id, diskId) {
  return {
    id,
    getSnapshot: () => ({
      agentId: id,
      name: id,
      activeSessionId: diskId,
      status: "idle",
      error: "",
      pendingApprovalCount: 0,
      mode: "normal",
      lastStreamDurationMs: 0,
      messages: [],
      queues: { steer: [], followUp: [] },
      usage: {
        contextFillTokens: 0,
        tokenLimit: 1,
        percent: 0,
        cost: 0,
        llmDurationMs: 0,
        llmOutputTokens: 0,
        total: {},
        window: {},
        billedInputTokens: 0,
      },
      todos: [],
      todosTitle: null,
      plan: {},
      autoMode: false,
      mcp: { servers: [] },
      extensions: { extensions: [] },
      toolDescriptors: [],
      interactions: { approvals: [], askUser: [] },
      iteration: { current: 1, max: 1 },
      subagents: [],
    }),
    getSummaryStreamSnapshot: () => null,
    subscribe: () => () => {},
    dispatch: async () => ({ ok: true }),
  };
}

{
  // --- flag OFF: the app never asks for a client-backed runtime -----------------
  const factoryContexts = [];
  const plainHost = {
    async create() {
      return { session: fakeSession("agent_p", "ses_p") };
    },
    connect: () => null,
    list: () => [],
    async destroy() {},
  };
  const app = createAcpAgent({ host: plainHost, defaults: { model: "m" }, rootPath: "/ws" });
  const client = createClient({ name: "off-client" });
  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    const created = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    check("flag off: session/new works on the plain host", created.sessionId === "ses_p");
  });
  check("flag off: no per-session factory was consulted", factoryContexts.length === 0);
}

{
  // --- flag ON: a client-backed runtime per session -----------------------------
  const factoryContexts = [];
  const disposed = [];
  const plainHost = {
    async create() {
      throw new Error("the plain host must not be used when the factory is wired");
    },
    connect: () => null,
    list: () => [],
    async destroy() {},
  };
  const app = createAcpAgent({
    host: plainHost,
    defaults: { model: "m" },
    rootPath: "/ws",
    createSessionHost: async (context) => {
      factoryContexts.push(context);
      const id = { value: "" };
      // Read the (late-bound) id up front. It MUST answer `undefined` rather than throw: a throw
      // here is swallowed by the instruction loader's `catch`, which silently costs every new
      // session its project instructions (see `validate-acp-client-env-bootstrap.mjs`, which
      // proves it end to end). `undefined` means "serve this locally".
      let preCreate;
      let preCreateError = null;
      try {
        preCreate = context.sessionId();
      } catch (error) {
        preCreateError = error;
      }
      check("reading the session id before the session exists does not throw", preCreateError === null);
      check("it answers `undefined`, meaning 'serve locally'", preCreate === undefined);
      return {
        host: {
          async create() {
            id.value = "ses_client";
            return { session: fakeSession("agent_c", "ses_client") };
          },
          connect: () => null,
          list: () => [],
          async destroy() {},
        },
        dispose: async () => void disposed.push(context),
      };
    },
  });
  const client = createClient({ name: "on-client" });
  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    const created = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    check("flag on: the session is created on the per-session runtime", created.sessionId === "ses_client");
    check(
      "flag on: the factory observed the client capabilities",
      factoryContexts[0]?.clientCapabilities?.terminal === true
    );
    check("flag on: the factory got a way to call the client back", typeof factoryContexts[0]?.client === "function");
    await cx.request(methods.agent.session.close, { sessionId: created.sessionId });
    check("flag on: closing the session releases its runtime", disposed.length === 1);
  });
}

// ===========================================================================
// 7. Approval authority moves only where the operation actually reaches the client
// ===========================================================================

{
  // The env answers the only question the policy asks. Capability + path, in that order.
  const full = makeEnv(fullCaps);
  check("a workspace write is the client's to authorise", full.routesWriteToClient("/ws/src/a.ts") === true);
  check("a relative workspace write is the client's too", full.routesWriteToClient("src/a.ts") === true);
  check("an `.agents/**` write is still OURS to authorise", full.routesWriteToClient("/ws/.agents/x.jsonl") === false);
  check("an outside-root write is still OURS", full.routesWriteToClient("/etc/passwd") === false);
  const noWrite = makeEnv({ readTextFile: true, writeTextFile: false, terminal: false });
  check("without the write capability NO write is the client's", noWrite.routesWriteToClient("/ws/src/a.ts") === false);
}

{
  const full = makeEnv(fullCaps);
  const context = { caps: full.clientCapabilities, routesWriteToClient: (t) => full.routesWriteToClient(t) };
  const { isClientOwnedApproval } = await import("../dist/index.mjs");
  const approval = (toolName) => ({ approvalId: "ap1", toolName, toolCallId: "tc1" });

  check(
    "write_file on a workspace path is client-owned",
    isClientOwnedApproval(approval("write_file"), { path: "src/a.ts" }, context) === true
  );
  check(
    "edit_file on a workspace path is client-owned",
    isClientOwnedApproval(approval("edit_file"), { path: "src/a.ts" }, context) === true
  );
  check(
    "write_file into `.agents/**` is NOT client-owned",
    isClientOwnedApproval(approval("write_file"), { path: ".agents/sessions/x.jsonl" }, context) === false
  );
  // The destructive one. `fs/*` has no delete, so the write capability must not be read as one.
  check(
    "delete_file is NEVER client-owned (no ACP method can authorise it)",
    isClientOwnedApproval(approval("delete_file"), { path: "src/a.ts" }, context) === false
  );
  check(
    "run_command is NEVER client-owned (it runs on our shell)",
    isClientOwnedApproval(approval("run_command"), { command: "rm -rf /" }, context) === false
  );
  check("kill_command is NEVER client-owned", isClientOwnedApproval(approval("kill_command"), {}, context) === false);
  // A missing path cannot prove the write reached the client, so the prompt must be kept.
  check(
    "a write approval with no path keeps its prompt",
    isClientOwnedApproval(approval("write_file"), {}, context) === false
  );
  check(
    "a write approval with an empty path keeps its prompt",
    isClientOwnedApproval(approval("write_file"), { path: "" }, context) === false
  );
  // And with no write capability, even a workspace write keeps its prompt.
  const readOnly = makeEnv({ readTextFile: true, writeTextFile: false, terminal: false });
  const readOnlyContext = {
    caps: readOnly.clientCapabilities,
    routesWriteToClient: (t) => readOnly.routesWriteToClient(t),
  };
  check(
    "without the write capability a workspace write keeps its prompt",
    isClientOwnedApproval(approval("write_file"), { path: "src/a.ts" }, readOnlyContext) === false
  );
}

{
  // End-to-end: with the flag on, a client-owned write approval is answered WITHOUT a
  // `session/request_permission`; with it off, nothing changes.
  const permissionCalls = [];
  const responded = [];

  /**
   * A session double that delivers the interaction event the real one does — an approval only
   * ever reaches the agent through `subscribe`, so a double that just holds a snapshot would
   * assert nothing about the suppression path.
   */
  function approvalSession(id, diskId, toolName, input, mode = "normal") {
    const listeners = new Set();
    const message = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "tool-call", id: "tc1", toolCallId: "tc1", name: toolName, input }],
    };
    const base = fakeSession(id, diskId);
    let snap = { ...base.getSnapshot(), messages: [message], status: "running", mode };
    return {
      ...base,
      getSnapshot: () => snap,
      subscribe: (handler) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
      dispatch: async (command) => {
        responded.push(command);
        if (command.type === "send") {
          snap = { ...snap, status: "running" };
          for (const l of listeners) {
            l({
              channel: "interaction",
              payload: { approvals: [{ approvalId: "ap1", toolName, toolCallId: "tc1" }], askUser: [] },
              ts: Date.now(),
            });
          }
          await new Promise((r) => setTimeout(r, 20));
          snap = { ...snap, status: "completed" };
        }
        return { ok: true };
      },
    };
  }

  function makeHost() {
    return {
      async create() {
        return { session: approvalSession("agent_a", "ses_a", currentTool, currentInput, currentMode) };
      },
      connect: () => null,
      list: () => [],
      async destroy() {},
    };
  }

  let currentTool = "write_file";
  let currentInput = { path: "src/a.ts" };
  let currentMode = "normal";

  async function drive({ clientEnv, toolName, input, mode = "normal" }) {
    permissionCalls.length = 0;
    responded.length = 0;
    currentTool = toolName;
    currentInput = input;
    currentMode = mode;
    const app = createAcpAgent({
      host: makeHost(),
      defaults: { model: "m" },
      rootPath: "/ws",
      ...(clientEnv
        ? { createSessionHost: async () => ({ host: makeHost(), dispose: async () => {}, clientEnv }) }
        : {}),
    });
    const client = createClient({ name: "approval-client" }).onRequest(methods.client.session.requestPermission, () => {
      permissionCalls.push(1);
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    });
    await client.connectWith(app, async (cx) => {
      await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
      await cx.request(methods.agent.session.prompt, {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
      await new Promise((r) => setTimeout(r, 40));
    });
  }

  // Whether the client was ASKED is the discriminating observable, not "was it answered": with
  // the flag off the client answers through the prompt, so `respondApproval` fires either way.
  // The property under test is exactly "no second question", i.e. zero permission requests.

  // Flag OFF: nothing changes for existing hosts — the approval round-trips through the client.
  await drive({ clientEnv: null, toolName: "write_file", input: { path: "src/a.ts" } });
  check("flag off: the client is asked, exactly as before", permissionCalls.length === 1);

  // Flag ON with a client-owned write: answered without asking the client.
  await drive({ clientEnv: makeEnv(fullCaps), toolName: "write_file", input: { path: "src/a.ts" } });
  check("flag on: a client-owned write is answered with NO second permission request", permissionCalls.length === 0);
  check(
    "flag on: that answer is an approval (it does not silently deny)",
    responded.some((c) => c.type === "respondApproval" && c.approved === true)
  );

  // Flag ON but a LOCAL path: the prompt stays.
  await drive({ clientEnv: makeEnv(fullCaps), toolName: "write_file", input: { path: ".agents/x.jsonl" } });
  check("flag on: a local `.agents/**` write still prompts", permissionCalls.length === 1);

  // Flag ON but delete_file: the prompt stays — this is the one that must never be silent.
  await drive({ clientEnv: makeEnv(fullCaps), toolName: "delete_file", input: { path: "src/a.ts" } });
  check("flag on: delete_file still prompts", permissionCalls.length === 1);

  // Flag ON in plan mode: the client authorises a FILE OPERATION, not the session's read-only
  // phase — and we cannot know it was ever granted, so spending its allow during that phase would
  // buy a write that plan mode does not perform. (A real session also auto-approves during plan's
  // executing/retro phases in core; the guard reads only the advertised mode, which is what this
  // double sets.)
  await drive({ clientEnv: makeEnv(fullCaps), toolName: "write_file", input: { path: "src/a.ts" }, mode: "plan" });
  check("flag on + plan mode: the write still prompts", permissionCalls.length === 1);

  // Flag ON, no write capability: the write never left the process, so the prompt stays.
  const readOnlyEnv = makeEnv({ readTextFile: true, writeTextFile: false, terminal: false });
  await drive({ clientEnv: readOnlyEnv, toolName: "write_file", input: { path: "src/a.ts" } });
  check("flag on + no write capability: the write still prompts", permissionCalls.length === 1);
}

// ===========================================================================
// 8. Optional members the sink and the job registry depend on are forwarded
// ===========================================================================

{
  // These never serve a client path (`.agents/**` and outside-root both stay local), so dropping
  // them would be a pure regression — and a silent one for `appendFile`, where the log sink simply
  // refuses to attach and the session loses its log file.
  const env = makeEnv(fullCaps);
  check("appendFile is forwarded from the fallback", typeof env.fs.appendFile === "function");
  // `rename` is NOT in the always-local class: it is the second half of a whole-file rewrite, and
  // with the write routed to the client that rename would run against OUR filesystem while the temp
  // file lives on the client's (ENOENT/EXDEV under a genuinely remote client, plus a leaked temp).
  // Withholding it makes `write_file` take its direct-write branch instead — one write, real path.
  check("rename is NOT forwarded while writes route to the client", typeof env.fs.rename === "undefined");
  check(
    "rename IS forwarded when writes stay local (the atomic rewrite still has its card)",
    typeof makeEnv({ readTextFile: true, writeTextFile: false, terminal: true }).fs.rename === "function"
  );
  check("startCommand is forwarded from the fallback", typeof env.startCommand === "function");
  check("getShellInfo is forwarded (approval analysis needs the real shell)", typeof env.getShellInfo === "function");

  reset();
  await env.fs.appendFile("/ws/.agents/logs/ses_1/agent.log", "line\n");
  check("an appendFile write makes ZERO client requests", requests.length === 0);
  check(
    "the appendFile write reached the fallback",
    fallbackCalls.some((c) => c[0] === "appendFile")
  );

  // And a sink built over this env really does attach, which is the property that matters.
  const sinkEnv = { ...env, fs: { ...env.fs } };
  check("the env the sink sees still has appendFile", typeof sinkEnv.fs.appendFile === "function");
}

// ===========================================================================
// 9. Every path on the wire is absolute (the contract ACP specifies)
// ===========================================================================
//
// ACP requires absolute paths on every path-bearing request (`fs/*`: "Absolute path to the file",
// `terminal/create.cwd`: "Must be an absolute path") while the tools hand us workspace-RELATIVE ones.
// Sending them verbatim is the defect this file exists to pin: the client resolves them against ITS
// OWN cwd, refuses them as outside the workspace, and the write's approval prompt then never resolves.
{
  reset();
  await makeEnv().fs.readFile("packages/acp/README.md");
  await makeEnv().fs.writeFile("packages/acp/README.md", "hello");
  await makeEnv().execFile("cat", ["packages/acp/README.md"], { cwd: "packages/acp" });
  const sent = requests.map((r) => r.params.path ?? r.params.cwd).filter((p) => typeof p === "string");
  check("a relative read, write and execFile reached the client", sent.length === 3, sent.join(", "));
  check(
    "every path on the wire is absolute",
    sent.every((p) => p.startsWith("/")),
    sent.join(", ")
  );
  check(
    "and resolved against rootPath, not process.cwd()",
    sent.every((p) => p.startsWith("/ws/")),
    sent.join(", ")
  );
  check(
    "each keeps its own frame, so none collapses to the root",
    sent.includes("/ws/packages/acp/README.md") && sent.includes("/ws/packages/acp")
  );

  reset();
  await makeEnv().fs.writeFile("/ws/already/absolute.txt", "x");
  check(
    "an absolute path is passed through unchanged",
    requests.length === 1 && requests[0].params.path === "/ws/already/absolute.txt"
  );
}

// ===========================================================================
// 10. One resolution: `locations` and the `fs/*` that follows describe ONE file
// ===========================================================================
//
// `tool_call.location.path` and the `fs/*` request the tool then makes are two spellings of the same
// file, so they must not disagree on how to spell it. They did: `locations` came from a
// string-concatenation helper (`tools.ts`) that kept `..` and `//`, while the `fs/*` body came from a
// `resolve`-based one, so a client that followed a location could ask for a path the file is not at.
//
// The assertions below deliberately do NOT reuse the implementation's own predicate — that is how a
// POSIX-only `startsWith("/")` check survived a green suite. Absoluteness is asserted the way a
// filesystem would judge it.
{
  const root = "/ws";

  // --- idempotence: resolving an already-wire path is a no-op -------------------------------
  const once = toWirePath("packages/acp/README.md", root);
  check("a relative path resolves under the root", once === "/ws/packages/acp/README.md", once);
  check("resolving a wire path again is a no-op (idempotent)", toWirePath(once, root) === once);

  // --- normalization: one file, one string --------------------------------------------------
  check(
    "`..` segments collapse, so a location and the read that follows it agree",
    toWirePath("packages/core/../acp/README.md", root) === "/ws/packages/acp/README.md",
    toWirePath("packages/core/../acp/README.md", root)
  );
  check("a doubled separator collapses too", toWirePath("a//b.md", root) === "/ws/a/b.md", toWirePath("a//b.md", root));

  // --- no process.cwd() fallback ------------------------------------------------------------
  // `pathe.resolve("", t)` silently resolves against the process's cwd. An empty root means "no base
  // to resolve against", and the honest answer is the path unchanged.
  const previousCwd = process.cwd();
  process.chdir("/tmp");
  try {
    check(
      "an empty rootPath returns the path unchanged (no process.cwd() fallback)",
      toWirePath("rel/only.md", "") === "rel/only.md",
      toWirePath("rel/only.md", "")
    );
  } finally {
    process.chdir(previousCwd);
  }

  // --- absoluteness judged as a filesystem judges it, not by `startsWith("/")` ---------------
  for (const [label, input] of [
    ["POSIX", "/abs/x.ts"],
    ["Windows drive-letter", "C:\\dev\\x.ts"],
    ["UNC", "\\\\srv\\share\\x.ts"],
  ]) {
    const out = toWirePath(input, root);
    // The failure mode this catches: a Windows/UNC path treated as relative becomes
    // `<root>/C:/dev/x.ts` — a path pointing at a file that does not exist.
    check(`a ${label} absolute path is not re-based under the root`, !out.startsWith(`${root}/`), out);
  }

  // --- the two producers agree --------------------------------------------------------------
  // The exact pair from the report: same file, same root, two spellings before this change.
  const viaLocation = toWirePath("packages/core/../acp/README.md", root);
  reset();
  await makeEnv().fs.readFile("packages/core/../acp/README.md");
  const viaFsRequest = requests[0]?.params?.path;
  check(
    "a location and its fs request spell the file identically",
    viaLocation === viaFsRequest,
    `location=${viaLocation} fs=${viaFsRequest}`
  );
}

// ===========================================================================
// 11. Rename's scope, and the root's absoluteness
// ===========================================================================
//
// Two consequences of the resolution contract that are easy to state and easy to get wrong:
// the `rename` gate is a CAPABILITY gate (so it removes the member for every path, including the
// local-only ones core documents as degrading), and every root-accepting entry normalizes the root
// so the `paths.ts` precondition (absolute root) actually holds for a caller-supplied `cwd`.
{
  // --- the rename gate's real scope ---------------------------------------------------------
  // Asserted as a property of the env, not of one call: with writes routed away there is no
  // `rename` for ANY path, which is exactly the degradation `session-journal.ts` documents
  // ("degrades to a direct overwrite … best-effort"). Pinned so nobody reads the gate as
  // path-selective.
  const routed = makeEnv({ readTextFile: true, writeTextFile: true, terminal: true });
  const local = makeEnv({ readTextFile: true, writeTextFile: false, terminal: true });
  check("routed writes: rename is absent for every path, `.agents/**` included", routed.fs.rename === undefined);
  check("local writes: rename is present again", typeof local.fs.rename === "function");
  check(
    "the gate is capability-level, not path-level: nothing about the target path changes it",
    typeof routed.fs.rename === "undefined" && routed.routesWriteToClient(".agents/x") === false,
    "a `.agents/**` path stays local for routing, yet rename is still gone"
  );

  // --- the root's absoluteness --------------------------------------------------------------
  // The precondition `toWirePath` documents is enforced at the entries by ONE helper: `resolveRoot`
  // may use `process.cwd()` (a relative caller root is only meaningful relative to it), while
  // `toWirePath` may never reach it (a root that arrived relative would anchor every path of the
  // session to whichever directory this process sits in).
  //
  // Asserted on the helper + the entries rather than by driving a whole bootstrap: a bootstrap call
  // resolves a model, and with a stubbed one it still performs a models.dev lookup — a network call
  // in a resolution test (0.8s cached / 4.9s uncached) and a dependency on the machine's own model
  // config, which is what made this section fail on a fresh checkout.
  const relativeRoot = resolveRoot("relative/workspace");
  check(
    "a relative root is normalized to absolute",
    relativeRoot.startsWith("/") && relativeRoot.endsWith("/relative/workspace"),
    relativeRoot
  );
  check("an absolute root is not re-based", resolveRoot("/abs/ws") === "/abs/ws", resolveRoot("/abs/ws"));
  check(
    "an omitted root is the process cwd (the one place it is the right base)",
    resolveRoot(undefined) === process.cwd(),
    resolveRoot(undefined)
  );
  check(
    "the entry's root is what a wire path then resolves against",
    toWirePath("a.ts", relativeRoot) === `${relativeRoot}/a.ts`,
    toWirePath("a.ts", relativeRoot)
  );

  // Both entries are pinned at the source: the agent entry's root is only observable through a
  // session listing (a store fixture), and the defect here is a raw fallback written AT an entry.
  for (const file of ["../src/bootstrap.ts", "../src/agent.ts"]) {
    const source = await fs.readFile(new URL(file, import.meta.url), "utf8");
    check(`${path.basename(file)} normalizes its root through resolveRoot`, source.includes("resolveRoot("));
    check(
      `${path.basename(file)} keeps no raw root fallback`,
      !/options\.(cwd|rootPath)\s*\?\?/.test(source),
      "a raw `options.<root> ?? …` is what makes the precondition unenforced"
    );
  }
}

finish(checker.failures);
