/**
 * ACP session-catalog conformance: session/list, session/delete, session/fork.
 *
 * Split out of `validate-acp.mjs` when that file hit the 800-line ceiling. It drives the same
 * in-process ACP client, but its subject is the catalog plane: the ids `session/new` hands out,
 * the disk-vs-live distinction behind `session/list`, and the re-keying a `session/fork` performs.
 *
 * Run: pnpm --filter @codent/acp run validate:acp:catalog
 */

import { client as createClient, methods } from "@agentclientprotocol/sdk";

import { createAcpAgent } from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";

const checker = createChecker();
const check = checker.check;

function baseSnapshot(id, overrides = {}) {
  return {
    agentId: id,
    name: id,
    // A root session ALWAYS has a disk session id in production (`host.create` mints one via
    // `ensureSessionData()`), and the ACP layer keys everything on it — so the default test
    // double carries one too. Sessions that need it to differ from the agent id pass both.
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
    extensions: { extensions: [] },
    toolDescriptors: [],
    interactions: { approvals: [], askUser: [] },
    iteration: { current: 1, max: 100 },
    subagents: [],
    ...overrides,
  };
}

function makeFakeSession(id, diskId = id, initial = {}) {
  const listeners = new Set();
  // `AgentSession.id` is the AGENT id and `activeSessionId` is the DISK id — two different
  // values, exactly as in production (`local-agent-session.ts` sets `id = managed.id`). Keeping
  // them distinct here is what makes the "ACP sessionId is the disk id" assertions meaningful;
  // a mock that collapsed them would hide the bug this section exists to catch.
  // Mutable session state: `mode` moves on dispatch and every subsequent snapshot must keep it.
  const state = { ...initial };
  let snap = baseSnapshot(id, { activeSessionId: diskId, ...state });
  return {
    id,
    getSnapshot: () => snap,
    state,
    getSummaryStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async (command) => {
      if (command.type === "send") {
        const message = { id: "m1", role: "assistant", parts: [{ type: "text", content: "Hello from ACP." }] };
        snap = baseSnapshot(id, { status: "running", messages: [message], activeSessionId: diskId, ...state });
        for (const l of listeners) l({ channel: "messages", payload: [message], ts: Date.now() });
        snap = baseSnapshot(id, { status: "completed", messages: [message], activeSessionId: diskId, ...state });
        for (const l of listeners) l({ channel: "state", payload: snap, ts: Date.now() });
        return { ok: true };
      }
      if (command.type === "stop") return { ok: true };
      // `mode.set` must actually move the snapshot: the ACP layer re-reads the mode after the
      // dispatch, so a fake that swallowed it would make the config_option_update assertions
      // vacuous (they would pass even if the update echoed the request instead of the state).
      if (command.type === "mode.set") {
        // Real core RE-DERIVES the mode after applying it (`managed.setAgentMode()` returns
        // `getAgentMode()`, which reads the plan/auto flags) — so the resulting mode is not
        // necessarily the requested one: `plan` is refused while plan mode is unavailable, which
        // is what `planUnavailable` models. This matters because the ACP layer must advertise the
        // session's ACTUAL mode; a fake that always obeyed would make "read the state" and "echo
        // the request" indistinguishable.
        const mode = command.mode === "plan" && state.planUnavailable ? state.mode : command.mode;
        state.mode = mode;
        snap = baseSnapshot(id, { activeSessionId: diskId, ...state });
        // The `mode` channel payload is `{ mode }` — the projector reads `event.payload.mode`.
        // A bare string here would make it emit `currentModeId: undefined`, which the SDK rejects
        // as invalid params and then closes the whole connection.
        for (const l of listeners) l({ channel: "mode", payload: { mode }, ts: Date.now() });
        return { ok: true };
      }
      return { ok: true };
    },
  };
}

// ===========================================================================
// I. Session catalog — list / delete / fork
// ===========================================================================

const deletedIds = [];
const catalogMetas = [
  { id: "ses_new", name: "Newest", version: 1, modelStyle: "openai", model: "m", createdAt: 3, updatedAt: 300 },
  { id: "ses_mid", name: "Middle", version: 1, modelStyle: "openai", model: "m", createdAt: 2, updatedAt: 200 },
  { id: "ses_old", name: "Oldest", version: 1, modelStyle: "openai", model: "m", createdAt: 1, updatedAt: 100 },
];
// Host actions the assertions below need to observe. The catalog host serves ONE live session
// (the one `session/new` creates), so `connect` returns it by whichever disk id it currently
// carries — that is what makes the "the id `new` returned is usable everywhere else" scenarios
// (load / resume / close) assertable without a second session factory.
const hostCalls = { created: 0, resumeTargets: [], destroyed: [] };
let liveFake = null;
const catalogHost = {
  async create(options) {
    hostCalls.created += 1;
    // `resume` / `load` re-enter through `create` with the requested disk id — that is the whole
    // mechanism by which an id from `new` addresses the same session again, so record it.
    if (options?.resumeSessionId) hostCalls.resumeTargets.push(options.resumeSessionId);
    liveFake = makeFakeSession("agent_c", "ses_live");
    return { session: liveFake };
  },
  connect: () => null,
  list: () => [],
  async destroy(id) {
    hostCalls.destroyed.push(id);
  },
  async listPersistedSessions() {
    // A session from an earlier process has no live agent — it must still be listed.
    return catalogMetas;
  },
  async deleteSession(id) {
    deletedIds.push(id);
    return id === "ses_new" || id === "ses_live";
  },
};
const catalogUpdates = [];
const catalogClient = createClient({ name: "catalog-client" }).onNotification(methods.client.session.update, (ctx) =>
  catalogUpdates.push(ctx.params)
);
const catalogApp = createAcpAgent({ host: catalogHost, defaults: { model: "fake-model" }, rootPath: "/ws" });

await catalogClient.connectWith(catalogApp, async (cx) => {
  const init = await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
  const caps = init.agentCapabilities?.sessionCapabilities;
  check(
    "initialize advertises list/delete/fork when the host supports them",
    Boolean(caps?.list && caps?.delete && caps?.fork)
  );
  check("initialize keeps advertising resume/close", Boolean(caps?.resume && caps?.close));
  check("initialize does not over-claim additionalDirectories", caps?.additionalDirectories == null);

  const listed = await cx.request(methods.agent.session.list, {});
  check(
    "session/list returns disk sessions in updatedAt-desc order",
    JSON.stringify(listed.sessions.map((s) => s.sessionId)) === JSON.stringify(["ses_new", "ses_mid", "ses_old"])
  );
  check(
    "session/list maps cwd/title/updatedAt onto SessionInfo",
    listed.sessions[0].cwd === "/ws" &&
      listed.sessions[0].title === "Newest" &&
      listed.sessions[0].updatedAt === new Date(300).toISOString()
  );
  check("session/list omits nextCursor on the last page", listed.nextCursor == null);

  // Delete a session the client never opened (the common path).
  await cx.request(methods.agent.session.delete, { sessionId: "ses_new" });
  check("session/delete removes a persisted session without opening it", deletedIds.includes("ses_new"));

  // A session that is live but not yet on disk must not be reported as missing.
  const liveNew = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
  check("session/new's id is the disk id", liveNew.sessionId === "ses_live");

  // ONE ID SPACE: the id `new` handed out must address the same session in every other method,
  // with no translation. Each of these would fail loudly if the layer kept the agent id instead.
  // ONE ID SPACE: the id `new` handed out must address the same session in every other method,
  // with no translation — and above all it must NOT be the agent runtime id (`agent_c`), which
  // is the two-id-spaces bug this whole capability exists to close.
  check("session/new's id is not the agent runtime id", liveNew.sessionId !== liveFake.id);
  await cx.request(methods.agent.session.resume, { sessionId: liveNew.sessionId, cwd: "/ws", mcpServers: [] });
  check("session/new's id is accepted by session/resume", hostCalls.resumeTargets.includes("ses_live"));
  await cx.request(methods.agent.session.load, { sessionId: liveNew.sessionId, cwd: "/ws", mcpServers: [] });
  check(
    "session/new's id is accepted by session/load",
    hostCalls.resumeTargets.filter((id) => id === "ses_live").length >= 2
  );
  await cx.request(methods.agent.session.close, { sessionId: liveNew.sessionId });
  check("session/new's id is accepted by session/close", hostCalls.destroyed.includes("agent_c"));

  // Re-open it so the delete scenarios below run against a live session, exactly as before.
  await cx.request(methods.agent.session.resume, { sessionId: liveNew.sessionId, cwd: "/ws", mcpServers: [] });
  await cx.request(methods.agent.session.delete, { sessionId: liveNew.sessionId });
  check("session/delete succeeds for a live session with no file yet", deletedIds.includes("ses_live"));

  // A session that is neither live nor on disk is a hard not-found.
  let notFound = false;
  try {
    await cx.request(methods.agent.session.delete, { sessionId: "ses_ghost" });
  } catch {
    notFound = true;
  }
  check("session/delete of an unknown session is a JSON-RPC error", notFound);

  // Unknown session after deletion is no longer promptable.
  let promptRejected = false;
  try {
    await cx.request(methods.agent.session.prompt, { sessionId: "ses_live", prompt: [{ type: "text", text: "hi" }] });
  } catch {
    promptRejected = true;
  }
  check("a deleted live session is no longer promptable", promptRejected);
});

// --- configOptions stay in sync after session/set_mode ------------------------
//
// `configOptions` is only carried by `session/new` / `session/fork` responses, so without an
// update the client's cached selector (the `category: "mode"` entry) would keep the value from
// session creation forever. The spec scenario promises that entry tracks the current mode.
{
  const modeSession = makeFakeSession("agent_mode", "ses_mode", { mode: "plan" });
  const clampSession = modeSession;
  const modeHost = {
    async create() {
      return { session: modeSession };
    },
    connect: () => modeSession,
    list: () => [],
    async destroy() {},
    async listPersistedSessions() {
      return [];
    },
    async deleteSession() {
      return true;
    },
  };
  const modeUpdates = [];
  const modeClient = createClient({ name: "mode-client" }).onNotification(methods.client.session.update, (ctx) =>
    modeUpdates.push(ctx.params)
  );
  const modeApp = createAcpAgent({ host: modeHost, defaults: { model: "fake-model" }, rootPath: "/ws" });

  await modeClient.connectWith(modeApp, async (cx) => {
    await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    const fresh = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    const advertised = (resp) => resp.configOptions?.find((option) => option.category === "mode")?.currentValue;
    check("session/new advertises the current mode", advertised(fresh) === "plan");

    modeUpdates.length = 0;
    await cx.request(methods.agent.session.setMode, { sessionId: fresh.sessionId, modeId: "normal" });
    const optionUpdates = modeUpdates.filter((u) => u.update.sessionUpdate === "config_option_update");
    check("session/set_mode emits a config_option_update", optionUpdates.length === 1);
    check(
      "the config_option_update carries the NEW mode",
      optionUpdates[0]?.update.configOptions?.find((o) => o.category === "mode")?.currentValue === "normal"
    );
    check(
      "the config_option_update carries the full option set, not just the changed entry",
      (optionUpdates[0]?.update.configOptions?.length ?? 0) > 0 &&
        optionUpdates[0].update.configOptions.some((o) => o.category === "mode")
    );
    check(
      "set_mode still emits current_mode_update (the pre-existing behavior)",
      modeUpdates.some((u) => u.update.sessionUpdate === "current_mode_update")
    );

    // A mode the session REFUSES (plan while unavailable) must not be advertised as if it took:
    // the update is built from the session state, not from the request.
    modeUpdates.length = 0;
    clampSession.state.planUnavailable = true;
    await cx.request(methods.agent.session.setMode, { sessionId: fresh.sessionId, modeId: "plan" });
    const clamped = modeUpdates.filter((u) => u.update.sessionUpdate === "config_option_update");
    check("a refused mode is not advertised (the update follows the session, not the request)", clamped.length === 0);
    check("the session really did refuse it", clampSession.getSnapshot().mode === "normal");
    clampSession.state.planUnavailable = false;

    // Idempotence: the client's cached entry is already correct, so re-setting the same mode must
    // not spam an identical update back at it.
    modeUpdates.length = 0;
    await cx.request(methods.agent.session.setMode, { sessionId: fresh.sessionId, modeId: "normal" });
    check(
      "re-setting the same mode emits no config_option_update",
      modeUpdates.filter((u) => u.update.sessionUpdate === "config_option_update").length === 0
    );

    // And the entry follows a second real change (not just the first one after creation).
    modeUpdates.length = 0;
    await cx.request(methods.agent.session.setMode, { sessionId: fresh.sessionId, modeId: "plan" });
    const back = modeUpdates.filter((u) => u.update.sessionUpdate === "config_option_update");
    check(
      "a second mode change updates the entry again",
      back[0]?.update.configOptions?.find((o) => o.category === "mode")?.currentValue === "plan"
    );
  });
}

// --- session/set_config_option: the write side of the advertised selector ----
//
// `configOptions` is a declaration, and `session/set_config_option` is the request that acts on
// it. Advertising the `mode` select without registering the setter meant a client rendered a mode
// dropdown and got "Method not found" (-32601) the instant a user touched it — so these assertions
// exist to keep the two halves welded together.
{
  const cfgSession = makeFakeSession("agent_cfg", "ses_cfg", { mode: "plan" });
  const cfgHost = {
    async create() {
      return { session: cfgSession };
    },
    connect: () => cfgSession,
    list: () => [],
    async destroy() {},
    async listPersistedSessions() {
      return [];
    },
    async deleteSession() {
      return true;
    },
  };
  const cfgUpdates = [];
  const cfgClient = createClient({ name: "cfg-client" }).onNotification(methods.client.session.update, (ctx) =>
    cfgUpdates.push(ctx.params)
  );
  const cfgApp = createAcpAgent({ host: cfgHost, defaults: { model: "fake-model" }, rootPath: "/ws" });

  await cfgClient.connectWith(cfgApp, async (cx) => {
    await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    const fresh = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });

    // The advertised id is accepted, and the mode actually moves (not just reported as moved).
    // Caught rather than awaited bare: if the handler ever disappears the request rejects with
    // "Method not found", and an unhandled rejection would abort the whole file as a stack trace
    // instead of reporting which promise the agent broke.
    cfgUpdates.length = 0;
    let resp = null;
    let writeError = null;
    try {
      resp = await cx.request(methods.agent.session.setConfigOption, {
        sessionId: fresh.sessionId,
        configId: "mode",
        value: "normal",
      });
    } catch (error) {
      writeError = `${error?.message ?? ""} ${error?.data?.details ?? ""}`;
    }
    check(
      "session/set_config_option is accepted (the advertised select is writable)",
      writeError === null && resp !== null
    );
    check("it really changed the session mode", cfgSession.getSnapshot().mode === "normal");
    check(
      "its response carries the full option set with the new value",
      resp?.configOptions?.find((o) => o.category === "mode")?.currentValue === "normal"
    );
    const viaConfig = cfgUpdates.filter((u) => u.update.sessionUpdate === "config_option_update");

    // THE point of this section: the two entry points are one behaviour. Same target mode, same
    // session → the emitted update must be identical field for field, or they have started to
    // drift into two mode systems.
    cfgUpdates.length = 0;
    await cx.request(methods.agent.session.setMode, { sessionId: fresh.sessionId, modeId: "plan" });
    cfgUpdates.length = 0;
    await cx.request(methods.agent.session.setMode, { sessionId: fresh.sessionId, modeId: "normal" });
    const viaSetMode = cfgUpdates.filter((u) => u.update.sessionUpdate === "config_option_update");
    check(
      "set_config_option and set_mode produce an identical config_option_update",
      viaConfig.length === 1 &&
        viaSetMode.length === 1 &&
        JSON.stringify(viaConfig[0].update) === JSON.stringify(viaSetMode[0].update)
    );

    // Idempotence carries over from the shared implementation (it is the same guard).
    cfgUpdates.length = 0;
    await cx.request(methods.agent.session.setConfigOption, {
      sessionId: fresh.sessionId,
      configId: "mode",
      value: "normal",
    });
    check(
      "re-setting the same value through set_config_option emits no update",
      cfgUpdates.filter((u) => u.update.sessionUpdate === "config_option_update").length === 0
    );

    // The response must describe the SESSION, not echo the request. This only shows up when the
    // session does not do what it was asked: `planUnavailable` makes the session refuse `plan`, so
    // an echo would happily report "plan" for a session that is still "normal".
    cfgUpdates.length = 0;
    cfgSession.state.planUnavailable = true;
    const refused = await cx.request(methods.agent.session.setConfigOption, {
      sessionId: fresh.sessionId,
      configId: "mode",
      value: "plan",
    });
    check(
      "a value the session refuses is reported as the session's ACTUAL mode, not the request",
      refused.configOptions?.find((o) => o.category === "mode")?.currentValue === "normal"
    );
    check("the session really did refuse it", cfgSession.getSnapshot().mode === "normal");
    check(
      "a refused value emits no config_option_update (nothing took effect)",
      cfgUpdates.filter((u) => u.update.sessionUpdate === "config_option_update").length === 0
    );
    cfgSession.state.planUnavailable = false;

    // An id outside the advertised set is refused, and refusing must not have moved anything.
    let badId = null;
    try {
      await cx.request(methods.agent.session.setConfigOption, {
        sessionId: fresh.sessionId,
        configId: "not-an-option",
        value: "plan",
      });
    } catch (error) {
      badId = `${error?.message ?? ""} ${error?.data?.details ?? ""}`;
    }
    check("an undeclared configId is refused", /not-an-option/i.test(badId ?? ""));
    check("a refused option does not change the mode", cfgSession.getSnapshot().mode === "normal");

    // A session that does not exist cannot have its mode set — reporting success would be a lie.
    // Both entry points reach the same `applyMode`, so they must give the SAME answer here; a
    // client that happens to use one route must not be told a different story than the other.
    const ghostly = async (send) => {
      try {
        await send();
        return null; // resolved = reported success
      } catch (error) {
        return `${error?.message ?? ""} ${error?.data?.details ?? ""}`;
      }
    };
    const ghost = await ghostly(() =>
      cx.request(methods.agent.session.setConfigOption, {
        sessionId: "ses_ghost",
        configId: "mode",
        value: "plan",
      })
    );
    check("an unknown session is refused rather than reported as set", /ses_ghost/i.test(ghost ?? ""));
    const ghostViaSetMode = await ghostly(() =>
      cx.request(methods.agent.session.setMode, { sessionId: "ses_ghost", modeId: "plan" })
    );
    check(
      "set_mode refuses an unknown session too (the two entry points agree)",
      /ses_ghost/i.test(ghostViaSetMode ?? "")
    );
  });
}

// A host without the catalog members must NOT advertise list/delete.
{
  const bareClient = createClient({ name: "bare-client" });
  const bareApp = createAcpAgent({
    host: {
      async create() {
        return { session: makeFakeSession("agent_b", "ses_b") };
      },
      connect: () => null,
      list: () => [],
      async destroy() {},
    },
    defaults: { model: "fake-model" },
    rootPath: "/ws",
  });
  await bareClient.connectWith(bareApp, async (cx) => {
    const init = await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    const caps = init.agentCapabilities?.sessionCapabilities;
    check("a host without the catalog does not advertise list/delete", !caps?.list && !caps?.delete);
    let listFailed = false;
    try {
      await cx.request(methods.agent.session.list, {});
    } catch {
      listFailed = true;
    }
    check("session/list on such a host is an explicit error, not a silent empty list", listFailed);
  });
}

// --- fork -----------------------------------------------------------------

const forkedBranches = [];
// Flipped by `runActive` to model core's "refuse to clone while the agent is running".
let runActive = false;
function makeForkSession(id, diskId) {
  const listeners = new Set();
  let snap = baseSnapshot(id, { activeSessionId: diskId });
  return {
    id,
    getSnapshot: () => snap,
    getSummaryStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async (command) => {
      if (command.type !== "session.clone") return { ok: true };
      if (runActive) {
        // Core's wording (`branchSession`): a half-finished turn would be branched.
        return { ok: false, error: "Cannot clone while the agent is running — stop it first (Esc)." };
      }
      forkedBranches.push(diskId);
      // Mimic `branchSession`: switch the underlying agent to a NEW disk session.
      const newId = "ses_forked";
      snap = { ...snap, activeSessionId: newId };
      for (const l of listeners) l({ channel: "state", payload: snap, ts: Date.now() });
      return { ok: true, data: { sessionId: newId } };
    },
    markRunning(value) {
      runActive = value;
    },
  };
}

const forkUpdates = [];
const forkClient = createClient({ name: "fork-client" }).onNotification(methods.client.session.update, (ctx) =>
  forkUpdates.push(ctx.params)
);
let forkSource = null;
const forkApp = createAcpAgent({
  host: {
    async create() {
      forkSource = makeForkSession("agent_f", "ses_source");
      return { session: forkSource };
    },
    connect: () => null,
    list: () => [],
    async destroy() {},
  },
  defaults: { model: "fake-model" },
  rootPath: "/ws",
});

await forkClient.connectWith(forkApp, async (cx) => {
  const src = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
  check("fork source id is the disk id", src.sessionId === "ses_source");

  // An in-flight run must be refused BEFORE anything is created (core's guard), and the error
  // must tell the user what to do about it.
  forkSource.markRunning(true);
  let runningRejected = null;
  try {
    await cx.request(methods.agent.session.fork, { sessionId: src.sessionId, cwd: "/ws" });
  } catch (error) {
    runningRejected = `${error?.message ?? ""} ${error?.data?.details ?? ""}`;
  }
  check("session/fork refuses while a run is in flight", runningRejected !== null);
  check("...with an error that says to stop the run first", /stop it first/i.test(runningRejected ?? ""));
  check("a refused fork created nothing", forkedBranches.length === 0);
  forkSource.markRunning(false);

  // Pre-fork updates legitimately carry the source id; only post-fork traffic is asserted below.
  await new Promise((r) => setTimeout(r, 20));
  forkUpdates.length = 0;

  // The fork request carries a mode select too.
  const forked = await cx.request(methods.agent.session.fork, { sessionId: src.sessionId, cwd: "/ws" });
  check(
    "session/fork returns a new session id",
    forked.sessionId === "ses_forked" && forked.sessionId !== src.sessionId
  );
  check("session/fork dispatched session.clone on the source", forkedBranches.includes("ses_source"));
  check(
    "session/fork advertises the mode select",
    forked.configOptions?.some((o) => o.category === "mode")
  );

  // The bridge was re-keyed: the NEW id is live, the OLD one is not.
  const newIsLive = await cx
    .request(methods.agent.session.prompt, { sessionId: "ses_forked", prompt: [{ type: "text", text: "go" }] })
    .then(() => true)
    .catch(() => false);
  check("the forked id addresses the live session", newIsLive);
  let oldRejected = false;
  try {
    await cx.request(methods.agent.session.prompt, { sessionId: "ses_source", prompt: [{ type: "text", text: "go" }] });
  } catch {
    oldRejected = true;
  }
  check("the source id no longer addresses a live session (single bridge, re-keyed)", oldRejected);
  await new Promise((r) => setTimeout(r, 20));
  check(
    "post-fork updates carry the new id only",
    forkUpdates.every((p) => p.sessionId === "ses_forked")
  );

  // The source is only un-bridged in THIS process — its persisted data is untouched, so a client
  // can still resume it (that is the whole point of a fork rather than a destructive move).
  await cx.request(methods.agent.session.resume, { sessionId: "ses_source", cwd: "/ws", mcpServers: [] });
  const sourceResumable = await cx
    .request(methods.agent.session.prompt, { sessionId: "ses_source", prompt: [{ type: "text", text: "hi" }] })
    .then(() => true)
    .catch(() => false);
  check("the source session stays resumable after a fork", sourceResumable);

  // mcpServers on a fork is rejected loudly, not ignored. The SDK wraps a handler throw as
  // `Internal error` and puts our text in `data.details`, so read both.
  let mcpRejected = false;
  try {
    await cx.request(methods.agent.session.fork, {
      sessionId: "ses_forked",
      cwd: "/ws",
      mcpServers: [{ name: "x", command: "/bin/echo", args: [], env: [] }],
    });
  } catch (error) {
    const text = `${error?.message ?? ""} ${error?.data?.details ?? ""}`;
    mcpRejected = text.includes("mcpServers");
  }
  check("session/fork rejects mcpServers with an explanatory error", mcpRejected);
});

finish(checker.failures);
