/**
 * ACP validation: client-supplied MCP servers over `session/new`.
 *
 * An ACP client puts its MCP servers in `session/new`'s `mcpServers` parameter, and before this
 * change the agent ignored the parameter entirely while declaring `mcpCapabilities: {http:false,
 * sse:false}` — so an editor's configured MCP servers silently did nothing and the capability
 * declaration made it unfixable from the client side.
 *
 * Asserted here:
 *
 *   1. stdio / http / sse entries are mapped into the create options (shape + name conversion);
 *   2. the capability declaration matches the implementation (`{http:true, sse:true}`, no `acp`);
 *   3. unsupported (`acp`) and malformed entries are JSON-RPC errors and create NO session;
 *   4. an absent / empty list carries no servers, so the workspace file stays the source;
 *   5. the session's own MCP summary is what `/mcp` renders, and it exposes no non-path literal
 *      through the path-semantic `configPath` / `configLoadedFrom` fields.
 *
 * Run: pnpm --filter @codent/acp run validate:acp:mcp
 */

import { client as createClient, methods } from "@agentclientprotocol/sdk";

import { createAcpAgent, mapAcpMcpServers } from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";

const checker = createChecker();
const check = checker.check;

// ============================================================================
// A. Pure mapping units
// ============================================================================

{
  const { servers } = mapAcpMcpServers([
    // Stdio has no `type` discriminant, and its `env` is an `{name,value}[]`.
    { name: "local", command: "/bin/mcp-server", args: ["--flag"], env: [{ name: "TOKEN", value: "t0ken" }] },
    {
      name: "remote",
      type: "http",
      url: "https://mcp.test/api",
      headers: [{ name: "Authorization", value: "Bearer x" }],
    },
    { name: "streamed", type: "sse", url: "https://mcp.test/sse", headers: [{ name: "X-Key", value: "k" }] },
  ]);
  check("stdio maps to transport: stdio with command/args", servers?.local?.transport === "stdio");
  check("stdio keeps its command and args", servers?.local?.command === "/bin/mcp-server");
  check(
    "stdio env is converted from {name,value}[] to a record",
    JSON.stringify(servers?.local?.env) === JSON.stringify({ TOKEN: "t0ken" })
  );
  check("type http maps to transport: http", servers?.remote?.transport === "http");
  check("http url survives", servers?.remote?.url === "https://mcp.test/api");
  check("http headers are converted to a record", servers?.remote?.headers?.Authorization === "Bearer x");
  check("type sse maps to transport: sse (not downgraded to http)", servers?.streamed?.transport === "sse");
  check("sse headers are converted too", servers?.streamed?.headers?.["X-Key"] === "k");
}

check("an absent list yields no servers", mapAcpMcpServers(undefined).servers === undefined);
check("an empty list yields no servers", mapAcpMcpServers([]).servers === undefined);

// Each rejection must name the offending server and be a value the caller can act on.
{
  const acp = mapAcpMcpServers([{ name: "bridged", type: "acp", serverId: "s1" }]);
  check("type acp is rejected", Boolean(acp.error) && acp.servers === undefined);
  check("the acp rejection names the transport", acp.error?.includes("acp"));

  const noCommand = mapAcpMcpServers([{ name: "broken", args: [], env: [] }]);
  check("a stdio entry without command is rejected", noCommand.error?.includes("command"));

  const emptyCommand = mapAcpMcpServers([{ name: "broken", command: "", args: [], env: [] }]);
  check("an empty command is rejected (not accepted as present)", Boolean(emptyCommand.error));

  const noUrl = mapAcpMcpServers([{ name: "broken", type: "http", headers: [] }]);
  check("an http entry without url is rejected", noUrl.error?.includes("url"));

  const noSseUrl = mapAcpMcpServers([{ name: "broken", type: "sse", headers: [] }]);
  check("an sse entry without url is rejected", noSseUrl.error?.includes("url"));

  const duplicate = mapAcpMcpServers([
    { name: "same", command: "/a", args: [], env: [] },
    { name: "same", command: "/b", args: [], env: [] },
  ]);
  check("a duplicate name is rejected", duplicate.error?.includes("same"));

  const unnamed = mapAcpMcpServers([{ name: "", command: "/a", args: [], env: [] }]);
  check("a nameless entry is rejected", Boolean(unnamed.error));
}

// ============================================================================
// B. In-process conformance (SDK client ↔ our agent)
// ============================================================================

/** Captures what the host was asked to create, and reports a session-shaped double. */
function makeHost(overrides = {}) {
  const createCalls = [];
  const session = makeFakeSession("agent_m", "ses_mcp");

  const host = {
    ...overrides,
    async create(options) {
      createCalls.push(options);
      return { session };
    },
    connect: () => null,
    list: () => [],
    async destroy() {},
  };

  return { host, createCalls, session };
}

function baseSnapshot(id, overrides = {}) {
  return {
    agentId: id,
    name: id,
    activeSessionId: `ses_${id}`,
    status: "idle",
    error: "",
    pendingApprovalCount: 0,
    mode: "normal",
    lastStreamDurationMs: 0,
    messages: [],
    queues: { steer: [], followUp: [] },
    usage: {
      contextFillTokens: 0,
      tokenLimit: 200000,
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
    iteration: { current: 1, max: 100 },
    subagents: [],
    ...overrides,
  };
}

function makeFakeSession(id, diskId, overrides = {}) {
  const listeners = new Set();
  let snap = baseSnapshot(id, { activeSessionId: diskId, ...overrides });
  return {
    id,
    getSnapshot: () => snap,
    getAgentStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async () => ({ ok: true }),
  };
}

// --- capability declaration -------------------------------------------------

{
  const { host } = makeHost();
  const client = createClient({ name: "caps-client" });
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  await client.connectWith(app, async (cx) => {
    const init = await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    const caps = init.agentCapabilities?.mcpCapabilities;
    check("mcpCapabilities.http is true", caps?.http === true);
    check("mcpCapabilities.sse is true (core connects sse)", caps?.sse === true);
    check("mcpCapabilities does not claim acp", caps?.acp == null);
  });
}

// --- servers reach the create options --------------------------------------

{
  const { host, createCalls } = makeHost();
  const client = createClient({ name: "mcp-client" });
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });

  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });

    await cx.request(methods.agent.session.new, {
      cwd: "/ws",
      mcpServers: [
        { name: "local", command: "/bin/mcp", args: ["--x"], env: [{ name: "K", value: "v" }] },
        { name: "remote", type: "http", url: "https://m.test/mcp", headers: [] },
        { name: "streamed", type: "sse", url: "https://m.test/sse", headers: [] },
      ],
    });

    const sent = createCalls.at(-1)?.mcpServers;
    check("session/new forwards the mapped servers to the host", Boolean(sent));
    check(
      "all three transports arrive at the host",
      Object.keys(sent ?? {})
        .sort()
        .join(",") === "local,remote,streamed"
    );
    check(
      "the host receives core's transport names",
      sent?.streamed?.transport === "sse" && sent?.local?.transport === "stdio"
    );

    // An empty list ⇒ the create options must NOT carry an (empty) map, or every session would
    // silently stop reading `.agents/mcp.json`.
    //
    // There is no "field absent" case at this layer: the SDK schema types `mcpServers` as a
    // required array, so a request without it is refused as invalid params before our handler
    // runs. The handler's tolerance of `undefined` is covered by the unit assertions in part A.
    await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    check(
      "an empty list carries no mcpServers (workspace file stays the source)",
      createCalls.at(-1)?.mcpServers === undefined
    );
  });
}

// --- rejections create no session ------------------------------------------

{
  const { host, createCalls } = makeHost();
  const client = createClient({ name: "reject-client" });
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });

  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });

    const rejected = async (servers) => {
      const before = createCalls.length;
      let text = null;
      let blob = "";
      try {
        await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: servers });
      } catch (error) {
        // Two layers can refuse a malformed entry, and which one fires depends on whether the
        // shape is expressible in ACP's own schema at all:
        //   - the SDK's zod validation (`command` / `url` are REQUIRED in the ACP types), which
        //     reports through `error.data` and never reaches our handler;
        //   - our own check, which reports by throwing (the SDK wraps the text as
        //     `Internal error` and puts it in `data.details`).
        // Both are "a JSON-RPC error and no session", which is what the requirement asks, so
        // the assertion reads the entire payload instead of pinning one spelling.
        text = `${error?.message ?? ""} ${error?.data?.details ?? ""}`;
        blob = `${text} ${JSON.stringify(error?.data ?? {})}`;
      }
      return { text, blob, created: createCalls.length > before };
    };

    // The SDK wraps a handler throw as `Internal error` and puts our text in `data.details`,
    // so both spellings are read.
    const acp = await rejected([{ name: "bridged", type: "acp", serverId: "s1" }]);
    check("type acp is a JSON-RPC error", acp.text !== null);
    check("the acp error explains the transport is unsupported", /not supported/i.test(acp.blob));
    check("no session is created for a rejected acp entry", acp.created === false);

    const noCommand = await rejected([{ name: "broken", args: [], env: [] }]);
    check("a stdio entry without command is a JSON-RPC error naming command", /command/i.test(noCommand.blob));
    check("no session is created for a missing command", noCommand.created === false);

    // An EMPTY command is schema-valid, so this one really does reach our own check.
    const emptyCommand = await rejected([{ name: "broken", command: "", args: [], env: [] }]);
    check("an empty command is rejected by our own validation", /command/i.test(emptyCommand.blob));
    check("no session is created for an empty command", emptyCommand.created === false);

    const duplicate = await rejected([
      { name: "dup", command: "/a", args: [], env: [] },
      { name: "dup", command: "/b", args: [], env: [] },
    ]);
    check("a duplicate name is a JSON-RPC error", duplicate.blob.includes("dup"));
    check("no session is created for a duplicate name", duplicate.created === false);

    const noUrl = await rejected([{ name: "web", type: "http", headers: [] }]);
    check("an http entry without url is a JSON-RPC error naming url", /url/i.test(noUrl.blob));
    check("no session is created for a missing url", noUrl.created === false);
  });
}

// --- load / resume carry servers the same way session/new does -----------------

{
  const { host, createCalls } = makeHost();
  const client = createClient({ name: "resume-mcp-client" });
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });

  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });

    // Restoring runs the same `Host.create` as `session/new`, so a client that sends its
    // configured servers here must be OBEYED — refusing would make every MCP-configured client
    // unable to restore a session (`load` cannot even omit the field: it is required by
    // `LoadSessionRequest`).
    //
    // Wrapped so a regression that starts refusing again reports as a FAIL with its text rather
    // than as an uncaught JSON-RPC rejection that kills the script before anything is printed.
    const attempt = async (method, params) => {
      try {
        await cx.request(method, params);
        return { ok: true, params: createCalls.at(-1), error: null };
      } catch (error) {
        return { ok: false, params: null, error: `${error?.message ?? ""} ${error?.data?.details ?? ""}` };
      }
    };

    const resume = await attempt(methods.agent.session.resume, {
      sessionId: "ses_old",
      cwd: "/ws",
      mcpServers: [
        { name: "local", command: "/bin/mcp", args: [], env: [{ name: "K", value: "v" }] },
        { name: "streamed", type: "sse", url: "https://m.test/sse", headers: [] },
      ],
    });
    check("session/resume forwards client mcpServers to the host", Boolean(resume.params?.mcpServers));
    check(
      "session/resume maps transports the same way session/new does",
      resume.params?.mcpServers?.streamed?.transport === "sse" &&
        resume.params?.mcpServers?.local?.transport === "stdio"
    );
    check("session/resume still resumes the requested session", resume.params?.resumeSessionId === "ses_old");

    // Each restore case needs an id that is NOT already live: `resume`/`load` on a live id REUSE it
    // (re-creating would put two writers on one disk log and a second projector on its channels — see
    // the catalog gate's reuse assertion), so no `create` happens and there is nothing to observe.
    const load = await attempt(methods.agent.session.load, {
      sessionId: "ses_load",
      cwd: "/ws",
      mcpServers: [{ name: "local", command: "/bin/mcp", args: [], env: [] }],
    });
    check("session/load forwards client mcpServers to the host", Boolean(load.params?.mcpServers));

    // An empty list is the "I have no servers" case and must NOT suppress the workspace file.
    const empty = await attempt(methods.agent.session.resume, {
      sessionId: "ses_empty",
      cwd: "/ws",
      mcpServers: [],
    });
    check(
      "an empty list on resume carries no mcpServers (workspace file stays the source)",
      empty.params?.mcpServers === undefined
    );

    // A malformed entry is refused on this path too — and creates nothing.
    const before = createCalls.length;
    const bad = await attempt(methods.agent.session.resume, {
      sessionId: "ses_old",
      cwd: "/ws",
      mcpServers: [{ name: "bridged", type: "acp", serverId: "s1" }],
    });
    check("session/resume refuses an unsupported transport", /not supported/i.test(bad.error ?? ""));
    check("a refused session/resume creates no session", createCalls.length === before);
  });
}

// --- additionalDirectories is refused everywhere it appears -------------------
//
// The capability is undeclared, and the base spec requires a request for an undeclared capability
// to be REFUSED rather than quietly ignored. Every request type that carries the field is covered
// here; the title used to promise this while only exercising `load`/`resume`, which is exactly how
// `session/new` — the entry point clients hit by default — kept silently ignoring it.

{
  const { host, createCalls } = makeHost();
  const client = createClient({ name: "dirs-client" });
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });

  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });

    const refused = async (method, params) => {
      const before = createCalls.length;
      let blob = null;
      try {
        await cx.request(method, params);
      } catch (error) {
        blob = `${error?.message ?? ""} ${error?.data?.details ?? ""}`;
      }
      return { blob, created: createCalls.length > before };
    };

    const created = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    check("a session is created for the additionalDirectories checks", typeof created.sessionId === "string");

    // `session/new` is the one that used to ignore the field. Asserted first because it matters
    // most: a client that sends an extra root here would otherwise get a session that silently
    // cannot see it.
    const fresh = await refused(methods.agent.session.new, {
      cwd: "/ws",
      mcpServers: [],
      additionalDirectories: ["/other"],
    });
    check("session/new refuses additionalDirectories", /additionalDirectories/i.test(fresh.blob ?? ""));
    check("a refused session/new creates no session", fresh.created === false);

    const load = await refused(methods.agent.session.load, {
      sessionId: "ses_x",
      cwd: "/ws",
      mcpServers: [],
      additionalDirectories: ["/other"],
    });
    check("session/load refuses additionalDirectories", /additionalDirectories/i.test(load.blob ?? ""));
    check("a refused session/load creates no session", load.created === false);

    const resume = await refused(methods.agent.session.resume, {
      sessionId: "ses_x",
      cwd: "/ws",
      mcpServers: [],
      additionalDirectories: ["/other"],
    });
    check("session/resume refuses additionalDirectories", /additionalDirectories/i.test(resume.blob ?? ""));
    check("a refused session/resume creates no session", resume.created === false);

    // Fork reuses the live bridge, so it has an existing sessionId as its source rather than a
    // freshly minted one.
    const fork = await refused(methods.agent.session.fork, {
      sessionId: created.sessionId,
      cwd: "/ws",
      additionalDirectories: ["/other"],
    });
    check("session/fork refuses additionalDirectories", /additionalDirectories/i.test(fork.blob ?? ""));
    check("a refused session/fork creates no session", fork.created === false);

    // The refusal is the SAME verdict on every path — one helper, one message, so a client can
    // match on it without caring which request it sent.
    const blobs = [fresh.blob, load.blob, resume.blob, fork.blob].map((b) => (b ?? "").trim());
    check(
      "every path uses the same refusal message",
      blobs.every((b) => b.length > 0 && b === blobs[0])
    );
  });
}

// --- fork is the ONE path that refuses mcpServers ---------------------------
//
// `load` and `resume` obey `mcpServers` because each builds a fresh agent through `Host.create`;
// a fork reuses the source's live bridge, so it genuinely cannot swap them. That asymmetry is the
// whole reason this rule exists, which makes it exactly the kind of thing a test must pin down
// rather than infer from the code staying quiet.

{
  const { host, createCalls } = makeHost();
  const client = createClient({ name: "fork-mcp-client" });
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });

  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    const created = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    const before = createCalls.length;

    let text = "";
    try {
      await cx.request(methods.agent.session.fork, {
        sessionId: created.sessionId,
        cwd: "/ws",
        mcpServers: [{ name: "late", command: "node", args: ["server.js"], env: [] }],
      });
    } catch (error) {
      text = `${error?.message ?? ""} ${error?.data?.details ?? ""}`;
    }
    check("session/fork refuses mcpServers", /mcpServers/i.test(text));
    check("a refused fork creates no session", createCalls.length === before);
  });
}

// --- the /mcp source display ------------------------------------------------

{
  // The summary the app renders `/mcp` from. A session-options session has no file, so the
  // path-semantic fields must stay EMPTY rather than carry a marker like "session-options"
  // (which would render as a nonexistent file path).
  const session = makeFakeSession("agent_s", "ses_src", {
    mcp: { servers: [{ name: "local", transport: "stdio", toolCount: 3, status: "connected", command: "/bin/mcp" }] },
  });
  const host = {
    async create() {
      return { session };
    },
    connect: () => null,
    list: () => [],
    async destroy() {},
  };
  const client = createClient({ name: "summary-client" });
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });

  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    const created = await cx.request(methods.agent.session.new, {
      cwd: "/ws",
      mcpServers: [{ name: "local", command: "/bin/mcp", args: [], env: [] }],
    });
    check("the session is created with client-supplied servers", typeof created.sessionId === "string");
  });

  const snapshot = session.getSnapshot();
  const mcp = snapshot.mcp;
  check("the MCP summary lists the session's servers", mcp?.servers?.length === 1);
  check("the summary carries no path-like placeholder", !JSON.stringify(mcp).includes("session-options"));
}

// ============================================================================
// E. An MCP server's question reaches the client (and only when it can answer)
// ============================================================================
//
// `mcpElicit` is core's whole opt-in for the MCP `elicitation` capability: with a hook core
// advertises it at the MCP handshake and registers the handler; without one it declares nothing (a
// server that asks anyway gets a protocol error, which core's own `validate:mcp-client` covers). MCP
// servers connect inside `host.create`, which runs after the ACP `initialize` handshake, so the
// client's capability is knowable at the moment the hook would be supplied — and both halves of the
// decision are asserted here, because "no hook" and "a hook that always declines" look the same from
// the tool's side but only one is honest about the handshake.

{
  const asked = [];
  const { host, createCalls } = makeHost();
  // A short deadline keeps the post-close case below a millisecond-scale check: with the default
  // (five minutes) a request that never settles would read as a hung validator, not as a failure.
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws", interactionTimeoutMs: 50 });
  const client = createClient({ name: "elicit-client" }).onRequest(methods.client.elicitation.create, (ctx) => {
    asked.push(ctx.params);
    return { action: "accept", content: { profile: "work" } };
  });

  let hook;
  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const created = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    hook = createCalls.at(-1)?.mcpElicit;
    check("the session's create options carry an elicit hook", typeof hook === "function");

    const answer = await hook({
      server: "browsermcp",
      params: {
        message: "Which profile?",
        requestedSchema: { type: "object", properties: { profile: { type: "string", enum: ["work", "personal"] } } },
      },
    });
    check("the question reaches the client as a form", asked[0]?.mode === "form");
    check("…scoped to the session the client created", asked[0]?.sessionId === created.sessionId);
    check("…carrying the server's own message", asked[0]?.message === "Which profile?");
    check(
      "…and the server's schema (enum/title) survives the hop",
      asked[0]?.requestedSchema?.properties?.profile?.enum?.[0] === "work"
    );
    check(
      "the accepted form comes back as MCP content",
      JSON.stringify(answer) === JSON.stringify({ action: "accept", content: { profile: "work" } })
    );
  });

  // The connection is gone (this is what a client quitting mid-question looks like). The hook must
  // still ANSWER: a server's tool call parked on a request nobody will send is the failure mode.
  // `decline` and not `cancel`: closing the connection closed this session, so the question is
  // refused up front instead of being sent to a peer that can no longer receive it.
  const late = await hook({ server: "browsermcp", params: { message: "still there?" } });
  check("a question after the connection closed is declined, not left hanging", late === "decline", String(late));
}

{
  // The host cannot carry the hook (the remote session host refuses one: a hook is executable code,
  // so it cannot cross the wire). Supplying it anyway made every `session/new`/`load`/`resume` throw
  // for any client that advertises form elicitation — a working configuration turned into a broken
  // one. The client capability is therefore only HALF the condition.
  const { host, createCalls } = makeHost({ acceptMcpElicit: false });
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  const client = createClient({ name: "refusing-host-client" });
  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const created = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    check("a host that refuses the hook still creates the session", typeof created.sessionId === "string");
    check("…without being handed one", createCalls.at(-1)?.mcpElicit === undefined);
  });
}

{
  // `load`/`resume` reconnect MCP servers inside `host.create` too, so the hook has to be supplied on
  // every path that starts a session — not only the first one.
  const { host, createCalls } = makeHost();
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  const client = createClient({ name: "restore-elicit-client" });
  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    });
    await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    check("session/new supplies the hook", typeof createCalls.at(-1)?.mcpElicit === "function");
    await cx.request(methods.agent.session.resume, { sessionId: "ses_r1", cwd: "/ws", mcpServers: [] });
    check("session/resume supplies it too", typeof createCalls.at(-1)?.mcpElicit === "function");
    await cx.request(methods.agent.session.load, { sessionId: "ses_l1", cwd: "/ws", mcpServers: [] });
    check("…and so does session/load", typeof createCalls.at(-1)?.mcpElicit === "function");
  });
}

{
  // Same session, client without form elicitation: no hook at all, so core never tells a server
  // "you may ask the user" — the documented fail-closed-by-absence path.
  const { host, createCalls } = makeHost();
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  const client = createClient({ name: "no-elicit-client" });
  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
  });
  check("no elicit hook without the client capability", createCalls.at(-1)?.mcpElicit === undefined);
}

{
  // A fork re-keys the SAME bridge (`bridge.acpId = newId`) and the channel reads that field on every
  // question, so the clone's dialog is scoped to the clone without a re-bind to forget. `session.fork`
  // is the only place the outgoing handle changes; the source conversation keeps its own channel.
  const asked = [];
  const forkedId = "ses_forked";
  let snapshot = baseSnapshot("agent_fork", { activeSessionId: "ses_src" });
  const session = {
    id: "agent_fork",
    getSnapshot: () => snapshot,
    getAgentStreamSnapshot: () => null,
    subscribe: () => () => {},
    async dispatch(command) {
      if (command?.type === "session.clone") {
        snapshot = baseSnapshot("agent_fork", { activeSessionId: forkedId });
        return { ok: true, data: { sessionId: forkedId } };
      }
      return { ok: true };
    },
  };
  const createCalls = [];
  const host = {
    async create(options) {
      createCalls.push(options);
      return { session };
    },
    connect: () => null,
    list: () => [],
    async destroy() {},
  };
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  const client = createClient({ name: "fork-elicit-client" }).onRequest(methods.client.elicitation.create, (ctx) => {
    asked.push(ctx.params);
    return { action: "accept", content: { ok: true } };
  });

  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const created = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    const hook = createCalls.at(-1)?.mcpElicit;
    check("the forked session's hook exists", typeof hook === "function");

    const forked = await cx.request(methods.agent.session.fork, { sessionId: created.sessionId, cwd: "/ws" });
    check("the fork produced a new session", forked.sessionId === forkedId);

    await hook({ server: "browsermcp", params: { message: "after the fork" } });
    check(
      "a question after a fork is scoped to the CLONE's handle",
      asked.at(-1)?.sessionId === forkedId,
      JSON.stringify(asked.at(-1)?.sessionId)
    );
  });
}

finish(checker.failures);
