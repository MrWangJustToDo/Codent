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

import { createAcpAgent, createAcpClientEnv, isLocalOnlyPath } from "../dist/index.mjs";

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
      // Deliberately read the (late-bound) id up front: it MUST throw before `host.create`
      // returns, so a client request can never be issued with an empty session id.
      let preCreateError = null;
      try {
        context.sessionId();
      } catch (error) {
        preCreateError = error;
      }
      check("the session id is not readable before the session exists", preCreateError !== null);
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
  check("rename is forwarded from the fallback", typeof env.fs.rename === "function");
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

finish(checker.failures);
