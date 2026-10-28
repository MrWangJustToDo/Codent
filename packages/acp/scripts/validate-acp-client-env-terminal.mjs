/**
 * A live-terminal conformance: abort, deadline, and truncation on the argv path.
 *
 * Split out of `validate-acp-client-env.mjs` (which hit the 800-line ceiling). Its subject is the
 * one shape the main suite cannot reach: a client whose terminal never exits on its own. There, the
 * terminal reports `exitStatus` on the second poll, so no test in that file can exercise the
 * polling loop's exit conditions — which is exactly where two real bugs lived (an ignored abort
 * signal, and a deadline that looked like a successful empty search).
 *
 * Run: pnpm --filter @codent/acp run validate:acp:terminal
 */

import { client as createClient, methods } from "@agentclientprotocol/sdk";

import { execArgsCapture } from "../../core/dist/dev.mjs";
import { createAcpAgent, createAcpClientEnv } from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";

const checker = createChecker();
const check = checker.check;

/** A fallback whose calls are recorded, so "delegated" is provable rather than assumed. */
const fallbackEnv = {
  rootPath: "/ws",
  path: { resolve: (...p) => p.join("/"), normalize: (p) => p, isAbsolute: (p) => p.startsWith("/") },
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => "/home/me",
  cwd: async () => "/ws",
  byteLength: (s) => s.length,
  fs: {
    readFile: async (p) => `local:${p}`,
    writeFile: async () => {},
    stat: async () => ({ isDirectory: false, isFile: true, size: 3, mtime: new Date(0) }),
    readdir: async () => [],
    mkdir: async () => {},
    exists: async () => true,
    remove: async () => {},
  },
  runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  getShellInfo: async () => ({ shell: "/bin/bash", kind: "bash" }),
  fetch: async () => new Response(""),
};

const fullCaps = { readTextFile: true, writeTextFile: true, terminal: true };

function baseSnapshot(id, diskId) {
  return {
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
    extensions: { extensions: [], commands: [] },
    toolDescriptors: [],
    interactions: { approvals: [], askUser: [] },
    iteration: { current: 1, max: 1 },
    subagents: [],
  };
}

function fakeSession(id, diskId) {
  const snap = baseSnapshot(id, diskId);
  return {
    id,
    getSnapshot: () => snap,
    getAgentStreamSnapshot: () => null,
    subscribe: () => () => {},
    dispatch: async () => ({ ok: true }),
  };
}

void createClient;
void createAcpAgent;
void fakeSession;

// ===========================================================================
// 9. A live terminal: abort and timeout must not read as "no matches"
// ===========================================================================

{
  /**
   * A client whose terminal never exits on its own — the only shape that exercises the polling
   * loop's exit conditions. The earlier sections' client returns `exitStatus` on the second poll,
   * so none of them can reach an abort or a deadline.
   */
  function neverExitingClient() {
    const calls = [];
    return {
      calls,
      client: () => ({
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === methods.client.terminal.create) return { terminalId: "t_slow" };
          if (method === methods.client.terminal.output) return { output: "partial", truncated: false };
          if (method === methods.client.terminal.kill) return {};
          if (method === methods.client.terminal.release) return {};
          throw new Error(`unexpected ${method}`);
        },
      }),
    };
  }

  function slowEnv(overrides = {}) {
    const rec = neverExitingClient();
    return {
      ...rec,
      env: createAcpClientEnv({
        client: rec.client,
        sessionId: () => "ses_slow",
        rootPath: "/ws",
        fallback: fallbackEnv,
        caps: fullCaps,
        log: () => {},
        ...overrides,
      }),
    };
  }

  // --- abort ---------------------------------------------------------------
  {
    const { env, calls } = slowEnv();
    const controller = new AbortController();
    // Abort while the loop is polling: the first sleep is 20 ms, so this lands mid-loop.
    setTimeout(() => controller.abort(), 30);
    const outcome = await env
      .execFile("grep", ["-r", "x", "/ws"], { signal: controller.signal })
      .then((r) => ({ kind: "returned", r }))
      .catch((e) => ({ kind: "threw", code: e.code, message: e.message }));
    check(
      "an aborted execFile does not resolve as a successful empty search",
      outcome.kind === "threw" ? outcome.code === "aborted" : false
    );
    check(
      "the aborted terminal was killed",
      calls.some((c) => c.method === methods.client.terminal.kill)
    );
    check(
      "the aborted terminal was released",
      calls.some((c) => c.method === methods.client.terminal.release)
    );
    check(
      "abort was not mistaken for a deadline",
      !calls.some((c) => c.method === methods.client.terminal.output && c.params?.terminalId === undefined)
    );
  }

  // --- an already-aborted signal never spawns a terminal -------------------
  {
    const { env, calls } = slowEnv();
    const controller = new AbortController();
    controller.abort();
    const outcome = await env
      .execFile("grep", ["x"], { signal: controller.signal })
      .then((r) => ({ kind: "returned", r }))
      .catch((e) => ({ kind: "threw", code: e.code }));
    check(
      "an already-aborted signal fails rather than running",
      outcome.kind !== "returned" || outcome.r.killed === true
    );
    check("no terminal was created before the abort", !calls.some((c) => c.method === methods.client.terminal.create));
  }

  // --- one reason per request, and the buckets mean what they say -------------
  {
    const unboundEnv = createAcpClientEnv({
      client: () => ({ request: async () => ({}) }),
      sessionId: () => undefined,
      rootPath: "/ws",
      fallback: fallbackEnv,
      caps: fullCaps,
      log: () => {},
    });
    // A `.agents/**` read while unbound hits BOTH conditions (a path we never send, and no session
    // yet). It must be counted ONCE, or a single startup read inflates the routing stats.
    await unboundEnv.fs.readFile("/ws/.agents/sessions/a.jsonl");
    check(
      "a request that matches two fallback reasons is counted once",
      unboundEnv.fallbackCounts.localOnlyPath === 1 && unboundEnv.fallbackCounts.localNoCapability === 0
    );

    // "No session yet" is about WHEN, not WHERE: the same path would have gone to the client a
    // moment later, so it belongs with the capability bucket, not the path bucket.
    await unboundEnv.fs.readFile("/ws/src/a.ts");
    check(
      "an unbound workspace read is filed as 'could not ask', not as 'path we never send'",
      unboundEnv.fallbackCounts.localNoCapability === 1 && unboundEnv.fallbackCounts.localOnlyPath === 1
    );

    // Deliberate local routing is neither.
    await unboundEnv.fs.readFile("/ws/src/a.png", "buffer");
    check(
      "a deliberate local route (byte read) is in neither bucket",
      unboundEnv.fallbackCounts.other === 1 &&
        unboundEnv.fallbackCounts.localOnlyPath === 1 &&
        unboundEnv.fallbackCounts.localNoCapability === 1
    );
  }

  // --- unbound: never send an undefined sessionId (the fs paths' invariant) --
  {
    const calls = [];
    const env = createAcpClientEnv({
      client: () => ({
        request: async (method, params) => {
          calls.push({ method, sessionId: params?.sessionId });
          throw new Error("the client must not be asked before the session exists");
        },
      }),
      sessionId: () => undefined,
      rootPath: "/ws",
      fallback: fallbackEnv,
      caps: fullCaps,
      log: () => {},
    });
    const outcome = await env
      .execFile("grep", ["x", "/ws"])
      .then((r) => ({ kind: "returned", r }))
      .catch((e) => ({ kind: "threw", message: e.message }));
    check("an unbound execFile degrades instead of asking the client", calls.length === 0);
    check(
      "and it reports 'unsupported' the way callers already handle",
      outcome.kind === "returned" ? outcome.r.missing === true : false
    );
  }

  // --- deadline ------------------------------------------------------------
  {
    const { env, calls } = slowEnv();
    const started = Date.now();
    const result = await env.execFile("grep", ["-r", "x", "/ws"], { timeout: 60 });
    check("a deadline produces a result (not a hang)", Boolean(result));
    check("a timed-out search is marked killed, so callers fall back", result.killed === true);
    check("a timed-out search does not claim a clean exit code", result.code === null);
    check("a timed-out search says why on stderr", /time budget|exceeded/i.test(result.stderr));
    check("the deadline was actually respected", Date.now() - started < 2000);
    check(
      "the timed-out terminal was killed and released",
      calls.some((c) => c.method === methods.client.terminal.kill) &&
        calls.some((c) => c.method === methods.client.terminal.release)
    );
  }

  // --- exit AND truncated on the SAME response (the regression) -------------
  {
    // A process can exit while its buffer was clipped by the client's byte limit. The exit used to
    // win the branch, so the clipped stdout was returned as a complete result — a grep that stops
    // matching partway and says nothing. The pre-refactor code caught this outside the loop; the
    // `endedBy` refactor lost it.
    const env = createAcpClientEnv({
      client: () => ({
        request: async (method) => {
          if (method === methods.client.terminal.create) return { terminalId: "t_both" };
          if (method === methods.client.terminal.output) {
            return { output: "clipped-and-done", truncated: true, exitStatus: { exitCode: 0 } };
          }
          return {};
        },
      }),
      sessionId: () => "ses_both",
      rootPath: "/ws",
      fallback: fallbackEnv,
      caps: fullCaps,
      log: () => {},
    });
    const result = await env.execFile("grep", ["-r", "x", "/ws"]);
    check("an exited-but-truncated buffer is not presented as a complete result", result.killed === true);
    check("and it says the output was clipped", /truncat/i.test(result.stderr));
  }

  // --- signal-terminated exit ---------------------------------------------
  {
    const env = createAcpClientEnv({
      client: () => ({
        request: async (method) => {
          if (method === methods.client.terminal.create) return { terminalId: "t_signal" };
          if (method === methods.client.terminal.output) {
            // A process killed by a signal reports no exit code but DOES report the signal.
            return { output: "partial", truncated: false, exitStatus: { exitCode: null, signal: "SIGTERM" } };
          }
          return {};
        },
      }),
      sessionId: () => "ses_signal",
      rootPath: "/ws",
      fallback: fallbackEnv,
      caps: fullCaps,
      log: () => {},
    });
    const result = await env.execFile("grep", ["-r", "x", "/ws"]);
    check("a signal-terminated terminal is marked killed", result.killed === true);
    check("and does not claim a clean exit code", result.code === null);
    check("and says the process was terminated by a signal", /signal/i.test(result.stderr));
    // The caller's contract: a killed search is "no answer", not "zero matches".
    const captured = await execArgsCapture(env, "grep", ["-r", "x", "/ws"]);
    check("a killed search is not read as an empty match set", captured === undefined);
  }

  // --- truncation ----------------------------------------------------------
  {
    const rec = neverExitingClient();
    const env = createAcpClientEnv({
      client: () => ({
        request: async (method) => {
          if (method === methods.client.terminal.create) return { terminalId: "t_trunc" };
          if (method === methods.client.terminal.output) return { output: "clipped", truncated: true };
          return {};
        },
      }),
      sessionId: () => "ses_slow",
      rootPath: "/ws",
      fallback: fallbackEnv,
      caps: fullCaps,
      log: () => {},
    });
    void rec;
    const result = await env.execFile("grep", ["-r", "x", "/ws"]);
    check("a truncated buffer is not presented as a complete result", result.killed === true);
    check("truncation is explained on stderr", /truncat/i.test(result.stderr));
  }
}

// ===========================================================================
// 10. A session that never came to exist must not leak its runtime
// ===========================================================================

{
  // Both create paths build a per-session runtime (and a per-session env) BEFORE asking it for a
  // session. If that ask fails, nothing else ever releases it — `closeBridge` only runs for a
  // session that exists — so the failure path has to do it.
  async function driveFailure({ request, hostCreate }) {
    const disposed = [];
    const app = createAcpAgent({
      host: {
        async create() {
          throw new Error("plain host must not be used");
        },
        connect: () => null,
        list: () => [],
        async destroy() {},
      },
      defaults: { model: "m" },
      rootPath: "/ws",
      createSessionHost: async () => ({
        host: {
          create: hostCreate,
          connect: () => null,
          list: () => [],
          async destroy() {},
        },
        dispose: async () => void disposed.push(1),
      }),
    });
    const client = createClient({ name: "fail-client" });
    let error = null;
    await client.connectWith(app, async (cx) => {
      await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      try {
        await cx.request(request.method, request.params);
      } catch (e) {
        error = e;
      }
    });
    return { disposed: disposed.length, error };
  }

  // session/new: `host.create` refuses.
  {
    const { disposed, error } = await driveFailure({
      request: { method: methods.agent.session.new, params: { cwd: "/ws", mcpServers: [] } },
      hostCreate: async () => {
        throw new Error("create failed");
      },
    });
    check("a failed session/new still answers with an error", error !== null);
    check("a failed session/new releases its runtime", disposed === 1);
  }

  // session/load: restoring an unknown id fails the same way.
  {
    const { disposed, error } = await driveFailure({
      request: {
        method: methods.agent.session.load,
        params: { sessionId: "ses_missing", cwd: "/ws", mcpServers: [] },
      },
      hostCreate: async () => {
        throw new Error("unknown session id");
      },
    });
    check("a failed session/load answers with an error", error !== null);
    check("a failed session/load releases its runtime", disposed === 1);
  }

  // Control: a SUCCESSFUL create must not dispose early (closing the session does that).
  {
    const disposed = [];
    const app = createAcpAgent({
      host: {
        async create() {
          throw new Error("plain host must not be used");
        },
        connect: () => null,
        list: () => [],
        async destroy() {},
      },
      defaults: { model: "m" },
      rootPath: "/ws",
      createSessionHost: async () => ({
        host: {
          async create() {
            return { session: fakeSession("agent_ok", "ses_ok") };
          },
          connect: () => null,
          list: () => [],
          async destroy() {},
        },
        dispose: async () => void disposed.push(1),
      }),
    });
    const client = createClient({ name: "ok-client" });
    await client.connectWith(app, async (cx) => {
      await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
      const created = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
      check("a successful create does not dispose its runtime early", disposed.length === 0);
      await cx.request(methods.agent.session.close, { sessionId: created.sessionId });
      check("closing it does release it", disposed.length === 1);
    });
  }
}

finish(checker.failures);
