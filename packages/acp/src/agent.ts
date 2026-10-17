/**
 * The ACP request table: `createAcpAgent` registers every agent method the protocol defines, wires each to
 * the bridge map, and owns the prompt-turn sequencing and the legacy `session/set_model` shim.
 */
/* eslint-disable max-lines -- Justified ceiling exception: this file is the handler table, and everything
 * that has a subject of its own is already extracted (`tools` / `content` / `paths` / `permissions` /
 * `interactions` / `projector` / `sessions` / `session-config-options` / `session-status`). What remains is
 * one registration block per protocol method over seven closures (`bridges`, `createRuntime`, `initCaps`,
 * `options`, `emit`, `attach`, `handleInteractions`); moving it needs those threaded through a factory
 * first, which is a change of its own. Tracks that extraction, not a licence to keep growing here. */
/**
 * CodentAcpAgent — the agent side of ACP.
 *
 * Serves an {@link AgentSessionHost} over stdio: each ACP session maps to one
 * in-process `AgentSession` under a stable external id, and an
 * {@link AcpProjector} turns its channels into `session/update` notifications.
 * Prompt turns dispatch through the session and resolve to an ACP `StopReason`;
 * approvals / `ask_user` become `session/request_permission` /
 * `elicitation/create` round-trips.
 */

import {
  agent as createAgentApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import { isActiveStatus } from "@codent/core";
import { createHash } from "node:crypto";

import { commandsFromSnapshot, dispatchSlashCommand, parseSlashCommand } from "./commands.js";
import { promptBlocksToContent, type PromptCaps } from "./content.js";
import { createInteractionHandlers } from "./interactions.js";
import { mapAcpMcpServers } from "./mcp.js";
import { resolveRoot } from "./paths.js";
import { AcpProjector } from "./projector.js";
import { applyMode, applyModel, sessionConfigOptions } from "./session-config-options.js";
import { buildSessionRuntime, type SessionRuntime } from "./session-runtime.js";
import { diskSessionId, sessionSelectors, sessionSelectorsFor, stopReasonFor } from "./session-status.js";
import { createSessionCatalog } from "./sessions.js";

import type { AcpClientEnv } from "./client-env.js";
import type { ConfigOptionTarget } from "./session-config-options.js";
import type { SessionUpdate } from "./types.js";
import type {
  AgentApp,
  AgentConnection,
  AgentContext,
  ClientCapabilities,
  McpServer,
  PromptRequest,
  StopReason,
} from "@agentclientprotocol/sdk";
import type {
  McpServerConfig,
  AgentSession,
  AgentSessionHost,
  AgentSessionSnapshot,
  ModelCatalogRead,
  ModelInfo,
  ModelStyle,
  AgentMode,
} from "@codent/core";

// Re-exported so a host builds `AcpAgentOptions` from one import site rather than reaching into the
// module that happens to consume the catalog.
export type { AcpModelCatalogEntry } from "./session-config-options.js";

/** Per-session bookkeeping. */
interface SessionBridge {
  session: AgentSession;
  /** The runtime that owns this session (per-session under `--client-env`). */
  runtime: SessionRuntime;
  /** Client-backed env for this session, when the flag is on. */
  clientEnv?: AcpClientEnv;
  /** The external ACP session id all updates/requests are tagged with. */
  acpId: string;
  projector: AcpProjector;
  /** Serializes prompt turns: one in-flight prompt per session. */
  chain: Promise<unknown>;
  cancelled: boolean;
  lastFinishReason: string | undefined;
  seenApprovals: Set<string>;
  /** Approvals dropped because the client owns the decision (reported on session close). */
  clientOwnedApprovals: number;
  seenAskUser: Set<string>;
  /** In-flight permission/elicitation request controllers (cancelled on cancel/close). */
  pending: Set<AbortController>;
  elicitation: boolean;
  promptCaps: PromptCaps;
  /**
   * The mode the client was last told about (via `configOptions`). Its `category: "mode"` entry
   * is the client's cached selector state, so it is only re-sent when it actually changed.
   */
  lastAdvertisedConfigMode: AgentMode | undefined;
  /**
   * The model the client was last told about (via `configOptions`). Tracked separately from
   * {@link lastAdvertisedConfigMode} because the two change independently and the protocol has no
   * incremental form: any change re-sends the WHOLE option set.
   */
  lastAdvertisedConfigModel: string | undefined;
  /**
   * The entry the session's connection came from (`.agents/config/models.json` index), when this
   * process knows it: seeded at attach from the config's active entry, updated by every model switch.
   *
   * Needed because a model id is only unique within an entry — with `shared` in two entries, an
   * advertisement that resolves the current model by first match names the wrong entry, and a client
   * re-selecting that value would dispatch the wrong credentials. `undefined` means "not recorded"
   * (a resumed session), which degrades to first match rather than a wrong claim.
   */
  selectedModelEntryIndex: number | undefined;
  /** The entry index the client was last told about — the mirror that makes a silent change visible. */
  lastAdvertisedConfigEntryIndex: number | undefined;
  /**
   * Whether the stored transcript has been replayed to the client. `load` owes the history once; a
   * repeat on the same live session must not replay it again (the client would render it twice).
   */
  replayed: boolean;
}

export interface AcpAgentDefaults {
  model: string;
  modelStyle?: ModelStyle;
  modelBaseURL?: string;
  modelApiKey?: string;
  modelInfo?: ModelInfo;
  systemPrompt?: string;
}

export interface AcpAgentOptions {
  host: AgentSessionHost;
  defaults: AcpAgentDefaults;
  rootPath?: string;
  version?: string;
  /**
   * The runtime's model read — the ONE `loadModels(...)` result, carried by the runtime this host serves.
   * The host projects it (selectors, legacy `models`, both write paths) and never derives a list of its
   * own. Absent only for an embedder that supplies no read, which means "no model list".
   */
  models?: ModelCatalogRead;
  /**
   * Build a per-session runtime whose env is backed by the ACP client (`--client-env`).
   *
   * Absent by default, in which case every session goes through `host` exactly as before. When
   * present, `session/new` / `load` / `resume` ask it for a host **bound to that session's env**
   * and use that host instead, which is what keeps "one runtime owns one env" intact (the runtime
   * carries its own env, and tools read it from `ToolRunContext.coreEnv`).
   *
   * It receives the disk session id because every client request must carry it.
   */
  createSessionHost?: (context: AcpClientEnvFactoryContext) => Promise<AcpSessionRuntime>;
}

/** What {@link AcpAgentOptions.createSessionHost} needs to build one session's client-backed env. */
export interface AcpClientEnvFactoryContext {
  /**
   * The ACP session id as the client knows it (the disk id — see {@link diskSessionId}), or
   * `undefined` before the session exists.
   *
   * A nullable getter, not a value, because of an ordering fact: `session/load` and
   * `session/resume` are told the id by the client, but `session/new` is not — core mints it
   * inside `host.create` (`ensureSessionData`), which is the very call that needs this env.
   *
   * During that call the env is asked to read workspace files — the instruction file
   * (`AGENTS.md` / `CLAUDE.md`), `.lsp.json`, `.mcp.json` — and none of them can be tagged with a
   * session id yet. They are served from the local fallback and counted; refusing them is not an
   * option, because the instruction loader catches a failed read and reports "no documentation
   * file found", so a refusal silently costs every new session its project instructions.
   */
  sessionId: () => string | undefined;
  /** The client capabilities observed during `initialize`. */
  clientCapabilities: ClientCapabilities | undefined;
  /**
   * The agent-side connection handle, for calling `fs/*` / `terminal/*` back to the client.
   *
   * Passed down rather than imported: the connection belongs to the app, and a session's env must
   * not be able to outlive it.
   */
  client: () => AgentContext;
}

/**
 * A per-session runtime handed back by {@link AcpAgentOptions.createSessionHost}.
 *
 * `dispose` is required and not optional: this runtime owns an env built for one session, and a
 * leaked one keeps a client-backed env (and its fallback handle) alive after the session is gone.
 */
export interface AcpSessionRuntime {
  host: AgentSessionHost;
  dispose: () => Promise<void>;
  /**
   * The client-backed env this runtime serves, when it has one.
   *
   * Presence is what tells the approval policy that writes may leave the process — see
   * `approvals.ts`. Omitted by runtimes that do not borrow the client's filesystem.
   */
  clientEnv?: AcpClientEnv;
}

const AGENT_NAME = "codent";

/** Create the ACP agent app (handlers registered; call `connect(stream)` to serve).
 *  At the line ceiling — extract a subject rather than adding prose. */
export function createAcpAgent(options: AcpAgentOptions): AgentApp {
  // `CODENT_ACP_TRACE=1` narrates every outgoing `session/update` on stderr (see `emit`).
  const TRACE_UPDATES = process.env.CODENT_ACP_TRACE === "1";
  const app = createAgentApp({ name: AGENT_NAME });
  const rootPath = resolveRoot(options.rootPath);
  const version = options.version ?? "0.0.1";
  const bridges = new Map<string, SessionBridge>();
  let connection: AgentConnection | null = null;
  let initCaps: ClientCapabilities | undefined;

  app.onConnect((conn) => {
    connection = conn;
  });

  const client = (): AgentContext => {
    const conn = connection as AgentConnection | null;
    if (!conn) throw new Error("ACP connection not established");
    return conn.client;
  };

  const emit = (acpId: string, update: SessionUpdate): void => {
    if (TRACE_UPDATES) {
      // One line per outgoing update (id + text snippet): "the client shows something we did not send"
      // is settled by reading what WAS sent.
      const key = update as { messageId?: string; toolCallId?: string; content?: { text?: string } };
      // `len` and `sha` are what make "the same text twice" decidable: two similar thoughts share a
      // 40-character prefix, identical ones share a length AND a hash. Without them a duplicated
      // reasoning block reads exactly like a repeated sentence in the model's output.
      const text =
        typeof key.content?.text === "string"
          ? ` ${JSON.stringify(key.content.text.slice(0, 40))} len=${key.content.text.length} sha=${createHash("sha1").update(key.content.text).digest("hex").slice(0, 8)}`
          : "";
      process.stderr.write(`[codent-acp] → ${update.sessionUpdate} ${key.messageId ?? key.toolCallId ?? ""}${text}\n`);
    }
    try {
      void client()
        .notify(methods.client.session.update, { sessionId: acpId, update })
        .catch(() => {});
    } catch {
      // not connected yet — drop
    }
  };

  /**
   * The entry a session's connection comes from, when the config tells us: the active entry, and
   * only when it actually holds that session's model. Anything else stays unrecorded rather than
   * guessed — see {@link SessionBridge.selectedModelEntryIndex}.
   */
  const seededModelEntryIndex = (model: string | undefined): number | undefined => {
    const active = options.models?.active;
    if (!model || !active) return undefined;
    return options.models?.entries[active.entryIndex]?.models.includes(model) ? active.entryIndex : undefined;
  };

  const attach = (
    session: AgentSession,
    clientCaps: ClientCapabilities | undefined,
    acpId: string,
    runtime: SessionRuntime,
    /**
     * Replay the transcript. Done HERE, BEFORE {@link AcpProjector.start} subscribes — a session delivers
     * its messages to a new subscriber, so subscribing first doubled the transcript — and priming the
     * cursors first is what makes that retained delivery idempotent.
     */
    replay = false
  ): SessionBridge => {
    const bridge: SessionBridge = {
      session,
      runtime,
      clientEnv: runtime.clientEnv,
      acpId,
      chain: Promise.resolve(),
      cancelled: false,
      lastFinishReason: undefined,
      seenApprovals: new Set(),
      clientOwnedApprovals: 0,
      seenAskUser: new Set(),
      pending: new Set(),
      elicitation: Boolean(clientCaps?.elicitation?.form),
      promptCaps: { image: true, audio: true, embeddedContext: true },
      lastAdvertisedConfigMode: undefined,
      lastAdvertisedConfigModel: undefined,
      // The connection's entry, when this process can know it: `session/new` took it from the
      // config's active entry. A resumed session whose model is not in that entry (the file changed
      // under it, or another process switched it) keeps `undefined` — the snapshot carries the model
      // id but not the connection, so first-match resolution is the honest fallback there.
      selectedModelEntryIndex: seededModelEntryIndex(session.getSnapshot().model),
      lastAdvertisedConfigEntryIndex: undefined,
      replayed: false,
      projector: undefined as unknown as AcpProjector,
    };
    bridge.projector = new AcpProjector(session, {
      rootPath,
      emit: (update) => emit(bridge.acpId, update),
      commands: () => commandsFromSnapshot(session.getSnapshot()),
      client: {
        compaction: Boolean(clientCaps?.session?.compaction),
        notices: Boolean(clientCaps?.session?.notices),
      },
      onInteraction: (payload) => void handleInteractions(bridge, payload),
    });
    if (replay) {
      bridge.replayed = true;
      bridge.projector.replayFrom(session.getSnapshot());
    }
    bridge.projector.start();
    // No id may own two live bridges: the `set` below would orphan a previous one, whose projector keeps its subscription — updates emitted twice under one id, and only `close` would ever stop it.
    bridges.get(acpId)?.projector.stop();
    bridges.set(acpId, bridge);
    return bridge;
  };

  /** The {@link ConfigOptionTarget} shape the shared write helpers act on. */
  const toTarget = (bridge: SessionBridge): ConfigOptionTarget => ({ session: bridge.session, acpId: bridge.acpId });

  /** Build this session's runtime (see `session-runtime.ts`). */
  const createRuntime = (): Promise<SessionRuntime> =>
    buildSessionRuntime({ options, client, getClientCapabilities: () => initCaps });

  const closeBridge = async (bridge: SessionBridge): Promise<void> => {
    for (const controller of bridge.pending) controller.abort();
    bridge.pending.clear();
    await bridge.session.dispatch({ type: "stop" }).catch(() => undefined);
    bridge.projector.stop();
    for (const [id, b] of bridges) if (b === bridge) bridges.delete(id);
    await bridge.runtime.host.destroy(bridge.session.id);
    // Release the per-session env/runtime. A no-op without `--client-env`, and idempotent with it
    // (a fork moves the bridge to a new id, but the runtime instance does not change).
    await bridge.runtime.dispose().catch(() => undefined);
  };

  const { handleInteractions } = createInteractionHandlers({
    client,
    emit,
    rootPath,
    onClientOwnedApproval: () => undefined,
  });

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  app.onRequest(methods.agent.initialize, (ctx) => {
    initCaps = ctx.params.clientCapabilities;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        // Per-session MCP servers are wired through `session/new` (`mcp.ts` maps and
        // validates them). stdio / http / sse are all connectable by core; `acp` is the one
        // form with no core entry point, so it is neither declared here nor accepted there.
        mcpCapabilities: { http: true, sse: true },
        // `list` / `delete` are host-dependent: a host that cannot enumerate or remove
        // persisted sessions must not have us advertise them (the remote-session host has no
        // local store). Declaring a capability we cannot serve is exactly what the
        // "capabilities are truthful" rule forbids.
        sessionCapabilities: {
          ...(options.host.listPersistedSessions ? { list: {} } : {}),
          ...(options.host.deleteSession ? { delete: {} } : {}),
          resume: {},
          close: {},
          // UNSTABLE in the SDK. Declared because we cover the WHOLE request, which the base spec
          // makes a precondition of declaring `fork`: `mcpServers` is refused loudly (a fork
          // reuses the source's live agent, so its servers genuinely cannot change − unlike
          // `session/new`/`load`/`resume`, which each build a fresh agent and therefore obey it),
          // `additionalDirectories` is refused too, and `cwd` is only a hint (the root is fixed at
          // handshake). Nothing here is silently dropped.
          fork: {},
        },
        auth: { logout: {} },
      },
      agentInfo: { name: AGENT_NAME, title: "Codent", version },
      authMethods: [],
    };
  });

  app.onRequest(methods.agent.authenticate, () => ({}));
  app.onRequest(methods.agent.logout, () => ({}));

  const createOptions = (mcpServers?: Record<string, McpServerConfig>): Parameters<AgentSessionHost["create"]>[0] => ({
    name: `${AGENT_NAME}-${bridges.size + 1}`,
    model: options.defaults.model,
    ...(options.defaults.modelStyle ? { modelStyle: options.defaults.modelStyle } : {}),
    ...(options.defaults.modelBaseURL ? { modelBaseURL: options.defaults.modelBaseURL } : {}),
    ...(options.defaults.modelApiKey ? { modelApiKey: options.defaults.modelApiKey } : {}),
    ...(options.defaults.modelInfo ? { modelInfo: options.defaults.modelInfo } : {}),
    ...(options.defaults.systemPrompt ? { systemPrompt: options.defaults.systemPrompt } : {}),
    // Session-supplied servers REPLACE the workspace `.agents/mcp.json` (see
    // `AgentSessionCreateOptions.mcpServers`); absent ⇒ the file is the source, as before.
    ...(mcpServers ? { mcpServers } : {}),
  });

  /**
   * Refuse a request that asks for `additionalDirectories`.
   *
   * The capability is deliberately undeclared (the agent serves exactly the workspace root it
   * was handed at handshake), and the base requirement is that a request for an undeclared
   * capability is refused rather than quietly ignored:
   * `openspec/specs/acp-agent-host/spec.md` — "对应的 client 请求 MUST NOT 被接受（返回 JSON-RPC 错误）".
   * Ignoring the field would let a client keep talking to an agent that cannot see the roots it
   * asked for, with nothing anywhere saying so.
   *
   * EVERY request type that can carry the field must call this — `session/new`, `session/load`,
   * `session/resume`, `session/fork`. `session/new` was the one that used to ignore it, which
   * was the worst of the four: it is the entry point a client reaches for by default.
   */
  const rejectAdditionalDirectories = (directories: string[] | undefined | null): void => {
    if (directories?.length) {
      throw new Error(
        "additionalDirectories is not supported: this agent serves exactly the workspace root it " + "was started with"
      );
    }
  };

  app.onRequest(methods.agent.session.new, async (ctx) => {
    // Checked FIRST, so a refused request creates nothing (same ordering as the malformed-MCP
    // check below).
    rejectAdditionalDirectories(ctx.params.additionalDirectories);
    if (ctx.params.cwd && ctx.params.cwd !== rootPath) {
      process.stderr.write(
        `[codent-acp] note: session cwd ${ctx.params.cwd} differs from workspace root ${rootPath}\n`
      );
    }
    // Mapped (and validated) BEFORE the session exists: a malformed entry must not leave a
    // half-configured session behind, and a client cannot retract one it was never told about.
    const mapped = mapAcpMcpServers(ctx.params.mcpServers);
    if (mapped.error) {
      throw new Error(mapped.error);
    }
    // With `--client-env` the session's env is client-backed and therefore per-session, so the
    // runtime is built here rather than borrowed from the process-wide host.
    const runtime = await createRuntime();
    let session: AgentSession;
    try {
      ({ session } = await runtime.host.create(createOptions(mapped.servers)));
    } catch (error) {
      // The runtime owns a per-session env; if the session never came to exist, nothing else will
      // ever release it (only `closeBridge` disposes, and there is no bridge yet).
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
    const acpId = diskSessionId(session);
    runtime.bind(acpId);
    const bridge = attach(session, initCaps, acpId, runtime);
    const snapshot = session.getSnapshot();
    bridge.lastAdvertisedConfigMode = snapshot.mode;
    bridge.lastAdvertisedConfigModel = snapshot.model;
    bridge.lastAdvertisedConfigEntryIndex = bridge.selectedModelEntryIndex;
    return {
      sessionId: acpId,
      ...sessionSelectors(snapshot, options.models, bridge.selectedModelEntryIndex),
    };
  });

  const resumeSession = async (
    sessionId: string,
    replay: boolean,
    clientCaps: ClientCapabilities | undefined,
    mcpServers: McpServer[] | undefined,
    additionalDirectories: string[] | undefined
  ): Promise<SessionBridge> => {
    // `additionalDirectories` is not a declared capability; see `rejectAdditionalDirectories`.
    rejectAdditionalDirectories(additionalDirectories);
    // Restoring a session runs the same `Host.create` as `session/new` (with `resumeSessionId`),
    // so a client-supplied list is carried exactly the same way: it replaces the workspace
    // config for this session, and an empty list falls back to the file.
    //
    // Rejecting it instead would be a hard block on every client that sends its configured
    // servers here — which is the normal case, and `load` cannot even omit the field (it is
    // required by `LoadSessionRequest`).
    const mapped = mapAcpMcpServers(mcpServers);
    if (mapped.error) {
      throw new Error(mapped.error);
    }
    // Already live in this process: REUSE it. Going on would build a second session over the same
    // disk log (two writers) and attach a second projector over the same channels — and the first one
    // would never be stopped, so every update (both tagged with this session id) arrives twice, with
    // two sets of cursors racing each other.
    const live = bridges.get(sessionId);
    if (live) {
      // `load` owes the client the transcript once. A repeat on the live session must not replay it
      // again — the client would render the whole conversation a second time.
      if (replay && !live.replayed) {
        live.replayed = true;
        live.projector.replayFrom(live.session.getSnapshot());
      }
      return live;
    }
    // The client told us the id here, so the client-backed env can carry it from the start.
    const runtime = await createRuntime();
    runtime.bind(sessionId);
    let session: AgentSession;
    try {
      ({ session } = await runtime.host.create({
        ...createOptions(mapped.servers),
        resumeSessionId: sessionId,
      }));
    } catch (error) {
      // A failed restore is the common case here (unknown or unreadable id), and the runtime owns a
      // per-session env that nothing else would ever release — same reason as `session/new`.
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
    // The requested disk id is authoritative here (it is what the client will keep using);
    // `diskSessionId` is the same value after the restore, so assert rather than diverge.
    return attach(session, clientCaps, sessionId, runtime, replay);
  };

  app.onRequest(methods.agent.session.load, async (ctx) => {
    const bridge = await resumeSession(
      ctx.params.sessionId,
      true,
      initCaps,
      ctx.params.mcpServers,
      ctx.params.additionalDirectories
    );
    return sessionSelectorsFor(bridge, options.models);
  });
  app.onRequest(methods.agent.session.resume, async (ctx) => {
    const bridge = await resumeSession(
      ctx.params.sessionId,
      false,
      initCaps,
      ctx.params.mcpServers,
      ctx.params.additionalDirectories
    );
    return sessionSelectorsFor(bridge, options.models);
  });

  app.onRequest(methods.agent.session.close, async (ctx) => {
    const bridge = bridges.get(ctx.params.sessionId);
    if (bridge) await closeBridge(bridge);
    return {};
  });

  // --------------------------------------------------------------------------
  // Session catalog (list / delete / fork)
  // --------------------------------------------------------------------------

  const catalog = createSessionCatalog({
    ...(options.host.listPersistedSessions
      ? { listPersistedSessions: options.host.listPersistedSessions.bind(options.host) }
      : {}),
    ...(options.host.deleteSession ? { deleteSession: options.host.deleteSession.bind(options.host) } : {}),
    rootPath,
    closeLive: async (sessionId) => {
      const live = bridges.get(sessionId);
      if (!live) return false;
      await closeBridge(live);
      return true;
    },
    note: (text) => process.stderr.write(text),
  });
  app.onRequest(methods.agent.session.list, (ctx) => catalog.list(ctx.params));
  app.onRequest(methods.agent.session.delete, (ctx) => catalog.remove(ctx.params));

  app.onRequest(methods.agent.session.fork, async (ctx) => {
    const sourceId = ctx.params.sessionId;

    // Same refusal as every other request type (defined once above) — a fork is exactly as
    // unable to widen the workspace root as a fresh session is.
    rejectAdditionalDirectories(ctx.params.additionalDirectories);

    // A fork of a session this process has not opened is NORMAL for a client forking from
    // `session/list`: restore it first, exactly like `load`, then clone (no replay — the client
    // watches the NEW id from here on).
    const wasLive = bridges.has(sourceId);
    let bridge = bridges.get(sourceId);
    if (!bridge) {
      await resumeSession(sourceId, false, initCaps, ctx.params.mcpServers, undefined);
      bridge = bridges.get(sourceId);
    }
    if (!bridge) throw RequestError.invalidParams(undefined, `Unknown session: ${sourceId}`);

    // Informational only: the root is fixed at handshake (a fork cannot move the conversation).
    if (ctx.params.cwd && ctx.params.cwd !== rootPath) {
      process.stderr.write(`[codent-acp] note: fork cwd ${ctx.params.cwd} differs from root ${rootPath}\n`);
    }

    // Fork-only rule: this path REUSES the source's live agent (no `Host.create`), so it cannot swap
    // MCP servers — `load`/`resume` do obey them, because each builds a fresh agent.
    if (ctx.params.mcpServers?.length && wasLive) {
      throw RequestError.invalidParams(
        undefined,
        "session/fork does not accept mcpServers for a live source (they are fixed at creation)"
      );
    }

    // Captured BEFORE the dispatch: a successful clone re-points the session to a NEW disk id,
    // so reading `activeSessionId` afterwards (or inside the re-key below) would key the map by
    // the new id twice and leave the source key behind — a second key for one bridge.
    const sourceDiskId = diskSessionId(bridge.session);

    // `session.clone` copies the whole transcript (ACP's fork request carries no fork point).
    // The source session is left intact on disk; core also refuses while a run is active.
    const result = (await bridge.session.dispatch({ type: "session.clone" })) as {
      ok: boolean;
      error?: string;
      data?: { sessionId?: string };
    };
    if (!result?.ok) {
      throw new Error(result?.error ?? "session/fork failed");
    }
    const newId = result.data?.sessionId ?? diskSessionId(bridge.session);

    // Re-key the SAME bridge: `branchSession` already switched the underlying agent to the new
    // session, so a second bridge would double-subscribe and double-send every update. Set the
    // new key before dropping the old one so no frame lands in a gap, and refresh `acpId`
    // because `emit` closes over `bridge.acpId`.
    bridges.set(newId, bridge);
    if (newId !== sourceId) bridges.delete(sourceId);
    // The dispatch may also have changed the disk id without producing a new ACP id; drop the
    // stale key either way so `bridges` never maps two ids to one bridge.
    if (sourceDiskId !== newId && sourceDiskId !== sourceId) bridges.delete(sourceDiskId);
    bridge.acpId = newId;

    const snapshot = bridge.session.getSnapshot();
    bridge.lastAdvertisedConfigMode = snapshot.mode;
    bridge.lastAdvertisedConfigModel = snapshot.model;
    bridge.lastAdvertisedConfigEntryIndex = bridge.selectedModelEntryIndex;
    return {
      sessionId: newId,
      ...sessionSelectors(snapshot, options.models, bridge.selectedModelEntryIndex),
    };
  });

  /**
   * Apply a mode to a live session — the ONE place a mode change happens.
   *
   * ACP reaches this by two routes (`session/set_mode`, and `session/set_config_option` via the
   * `mode` config option it advertises), and they must not grow into two mode systems: the
   * dispatch, the re-read and the follow-up update are all one behaviour.
   */
  /**
   * Re-advertise the WHOLE option set, but only when the value actually changed.
   *
   * The protocol's `ConfigOptionUpdate` carries `configOptions` and has no incremental form, so a
   * single changed entry still means re-sending the set — sending only that entry would wipe the
   * others out of the client's cache. And a re-set of the same value must stay silent: the client's
   * cache is already correct, and re-broadcasting would be noise the user cannot act on.
   */
  const advertise = (
    bridge: SessionBridge,
    previous: { mode: AgentMode; model?: string; entryIndex?: number }
  ): void => {
    const snapshot = bridge.session.getSnapshot();
    if (
      snapshot.mode === previous.mode &&
      snapshot.model === previous.model &&
      bridge.selectedModelEntryIndex === previous.entryIndex
    ) {
      return;
    }
    bridge.lastAdvertisedConfigMode = snapshot.mode;
    bridge.lastAdvertisedConfigModel = snapshot.model;
    bridge.lastAdvertisedConfigEntryIndex = bridge.selectedModelEntryIndex;
    emit(bridge.acpId, {
      sessionUpdate: "config_option_update",
      configOptions: sessionConfigOptions(snapshot, options.models, bridge.selectedModelEntryIndex),
    });
  };

  /**
   * The values the client was last told about, so {@link advertise} can tell "changed" from "same".
   *
   * The entry index is compared too: switching between two entries that offer the SAME model id
   * (`0:shared` → `1:shared`) changes the connection while the model string stands still, and a
   * client whose cache said `0:shared` must be told.
   */
  const advertised = (bridge: SessionBridge): { mode: AgentMode; model?: string; entryIndex?: number } => ({
    mode: bridge.lastAdvertisedConfigMode ?? bridge.session.getSnapshot().mode,
    model: bridge.lastAdvertisedConfigModel,
    entryIndex: bridge.lastAdvertisedConfigEntryIndex,
  });

  app.onRequest(methods.agent.session.setMode, async (ctx) => {
    const bridge = bridges.get(ctx.params.sessionId);
    // Reject, like every other handler that must CHANGE something: reporting success for a session
    // we never touched is a lie the client cannot detect. (`close` is allowed to tolerate absence —
    // there the desired state is already true, so "ok" is honest. Here it is not.)
    if (!bridge) throw RequestError.invalidParams(undefined, `Unknown session: ${ctx.params.sessionId}`);
    const before = advertised(bridge);
    await applyMode(toTarget(bridge), ctx.params.modeId as AgentMode);
    advertise(bridge, before);
    return {};
  });

  // The write side of the `configOptions` we advertise: declaring a select implies accepting the
  // request that sets it. Without this a client renders the selector and then gets "Method not
  // found" (-32601) the moment anyone touches it.
  app.onRequest(methods.agent.session.setConfigOption, async (ctx) => {
    const bridge = bridges.get(ctx.params.sessionId);
    if (!bridge) throw RequestError.invalidParams(undefined, `Unknown session: ${ctx.params.sessionId}`);

    // Look the id up in the SET WE ADVERTISE rather than comparing against a literal: adding an
    // option later must not leave this check behind (a hardcoded id would reject the new one).
    const option = sessionConfigOptions(
      bridge.session.getSnapshot(),
      options.models,
      bridge.selectedModelEntryIndex
    ).find((entry) => entry.id === ctx.params.configId);
    if (!option) throw RequestError.invalidParams(undefined, `Unknown configuration option: ${ctx.params.configId}`);

    // Dispatch on the option's CATEGORY, not on the configId. Reading the id would hardcode the set
    // again, and assuming "the only option is mode" (as this did while mode was the only one) sends
    // a model id through `mode.set` — which reports success and broadcasts a current value that
    // never took effect.
    const before = advertised(bridge);
    switch (option.category) {
      case "mode":
        await applyMode(toTarget(bridge), ctx.params.value as AgentMode);
        break;
      case "model": {
        const applied = await applyModel(toTarget(bridge), ctx.params.value as string, options.models);
        // Record the entry the connection came from, so every later advertisement names it instead
        // of first-matching a model id that several entries may share. A bare re-selection of the
        // current model reports no entry and leaves the recorded one alone.
        if (applied.entryIndex !== undefined) bridge.selectedModelEntryIndex = applied.entryIndex;
        break;
      }
      default:
        // No third option is advertised, so an unhandled category is a real gap. Swallow it and the
        // client's selector silently stops meaning anything.
        throw RequestError.invalidRequest(
          undefined,
          `Configuration option "${option.id}" has no write path (category: ${option.category})`
        );
    }
    advertise(bridge, before);

    // Protocol requires the FULL set back (there is no incremental form), read after the change.
    return {
      configOptions: sessionConfigOptions(bridge.session.getSnapshot(), options.models, bridge.selectedModelEntryIndex),
    };
  });

  // Legacy model selection. The current protocol dropped `session/set_model` in favour of a
  // `configOptions` entry with `category: "model"`, but clients that still speak the older API call it
  // — and one that only reads `models` had no picker at all. Same `applyModel` as
  // `session/set_config_option`, so neither surface can drift from the other.
  // Cast: this protocol version removed the method from its handler map, so there is no keyed entry to
  // type against — but the SDK accepts a custom method with its own params parser, and the wire has no
  // restriction at all. The clients that call it are exactly the ones this exists for.
  const onLegacyRequest = app.onRequest.bind(app) as unknown as (
    method: string,
    parser: (params: unknown) => { sessionId: string; modelId: string },
    handler: (ctx: { params: { sessionId: string; modelId: string } }) => Promise<Record<string, never>>
  ) => void;
  onLegacyRequest(
    "session/set_model",
    (params) => {
      const rec = params as { sessionId?: unknown; modelId?: unknown };
      if (typeof rec?.sessionId !== "string" || typeof rec?.modelId !== "string") {
        throw RequestError.invalidParams(undefined, "session/set_model requires sessionId and modelId");
      }
      return { sessionId: rec.sessionId, modelId: rec.modelId };
    },
    async (ctx) => {
      const bridge = bridges.get(ctx.params.sessionId);
      if (!bridge) throw RequestError.invalidParams(undefined, `Unknown session: ${ctx.params.sessionId}`);
      const applied = await applyModel(toTarget(bridge), ctx.params.modelId, options.models);
      if (applied.entryIndex !== undefined) bridge.selectedModelEntryIndex = applied.entryIndex;
      return {};
    }
  );

  app.onRequest(methods.agent.session.prompt, async (ctx) => {
    const bridge = bridges.get(ctx.params.sessionId);
    if (!bridge) throw RequestError.invalidParams(undefined, `Unknown session: ${ctx.params.sessionId}`);
    // A prompt arriving while the turn is SUSPENDED on the client (approval / `ask_user`) is force-submit:
    // the answer it waits for was replaced by typing, so queueing waits on a client that will never answer.
    // Denying what is pending (what cancelling does) ends that turn as `cancelled`; this prompt then runs.
    if (bridge.pending.size > 0) interruptBridge(bridge);
    const run = bridge.chain.then(async () => {
      if (TRACE_UPDATES) process.stderr.write(`[codent-acp] <- session/prompt ${ctx.params.sessionId}\n`);
      const startedAt = Date.now();
      const result = await runPrompt(bridge, ctx.params);
      if (TRACE_UPDATES) process.stderr.write(`[codent-acp] -> ${result.stopReason} ${Date.now() - startedAt}ms\n`);
      return result;
    });
    bridge.chain = run.catch(() => undefined);
    return run;
  });

  /**
  /** End the running or suspended turn: `session/cancel`, or a prompt that arrives while it waits. */
  const interruptBridge = (bridge: SessionBridge): void => {
    bridge.cancelled = true;
    for (const controller of bridge.pending) controller.abort();
    bridge.pending.clear();
    void bridge.session.dispatch({ type: "stop" }).catch(() => undefined);
  };

  app.onNotification(methods.agent.session.cancel, (ctx) => {
    const bridge = bridges.get(ctx.params.sessionId);
    if (!bridge) return;
    interruptBridge(bridge);
  });

  const runPrompt = async (bridge: SessionBridge, params: PromptRequest): Promise<{ stopReason: StopReason }> => {
    bridge.cancelled = false;
    const mapping = promptBlocksToContent(params.prompt, bridge.promptCaps);
    if (mapping.error) throw new Error(mapping.error);

    const text = typeof mapping.content === "string" ? mapping.content : undefined;
    const parsed = text ? parseSlashCommand(text) : null;
    if (parsed && text) {
      const result = await dispatchSlashCommand(bridge.session, bridge.session.getSnapshot(), parsed);
      if (result.handled) {
        if (result.message) {
          emit(bridge.acpId, {
            sessionUpdate: "agent_message_chunk",
            messageId: `${bridge.acpId}-command-${Date.now()}`,
            content: { type: "text", text: result.message },
          });
        }
        return { stopReason: "end_turn" };
      }
    }

    try {
      await bridge.session.dispatch({ type: "send", content: mapping.content });
      // A suspended turn (approval / ask_user) returns the pump while the SAME turn keeps streaming:
      // resolving here told the client the turn was over. Wait for the TURN. */
      await waitForTurnEnd(bridge);
    } catch (error) {
      if (bridge.cancelled) return { stopReason: "cancelled" };
      throw error;
    }
    return { stopReason: stopReasonFor(bridge) };
  };

  /** Resolve when the turn is over (not merely suspended), or when this session was cancelled.
   *  A hang here blocks the client's next submission (`bridge.chain` serializes prompts). */
  const waitForTurnEnd = (bridge: { session: AgentSession; cancelled: boolean }): Promise<void> =>
    new Promise((resolve) => {
      const isOver = (): boolean => bridge.cancelled || !isActiveStatus(bridge.session.getSnapshot().status);
      if (isOver()) {
        resolve();
        return;
      }
      const timer = setInterval(finish, 250);
      const unsubscribe = bridge.session.subscribe(finish, { channels: ["state", "lifecycle"] });
      function finish(): void {
        if (!isOver()) return;
        clearInterval(timer);
        unsubscribe();
        resolve();
      }
    });

  return app;
}

/**
 * Serve an ACP agent over stdio. Returns the live connection.
 *
 * The caller (a bin entry) owns process teardown; this only wires the transport.
 */
export function runAcpAgentStdio(options: AcpAgentOptions): AgentConnection {
  const app = createAcpAgent(options);
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      process.stdin.on("end", () => controller.close());
      process.stdin.on("error", (err) => controller.error(err));
    },
  });
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve) => {
        if ((process.stdout as unknown as { destroyed?: boolean }).destroyed) return resolve();
        process.stdout.write(chunk, () => resolve());
      });
    },
  });
  return app.connect(ndJsonStream(output, input));
}

/** Re-exported for tests / callers that need the snapshot type. */
export type { AgentSessionSnapshot };
