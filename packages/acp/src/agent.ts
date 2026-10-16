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

import { agent as createAgentApp, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { isActiveStatus } from "@codent/core";

import { commandsFromSnapshot, dispatchSlashCommand, parseSlashCommand } from "./commands.js";
import { promptBlocksToContent, type PromptCaps } from "./content.js";
import { createInteractionHandlers } from "./interactions.js";
import { mapAcpMcpServers } from "./mcp.js";
import { AcpProjector } from "./projector.js";
import { applyMode, applyModel, sessionConfigOptions } from "./session-config-options.js";
import { buildSessionRuntime, type SessionRuntime } from "./session-runtime.js";
import { diskSessionId, sessionModes, stopReasonFor } from "./session-status.js";
import { paginateSessions } from "./sessions.js";

import type { AcpClientEnv } from "./client-env.js";
import type { AcpModelCatalogEntry, ConfigOptionTarget } from "./session-config-options.js";
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
   * Selectable models, when the workspace's `models.json` was the source. Absent on the explicit
   * `--model` flags path (which skips that file) and on the `.env` fallback — both of which is what
   * makes the ACP model selector disappear there.
   */
  modelCatalog?: AcpModelCatalogEntry[];
  /**
   * The config entry `modelCatalog`'s active model came from — the seed for a session's recorded
   * entry, so `session/new` can advertise the right one when a model id appears in several entries.
   * Absent whenever {@link modelCatalog} is (nothing to disambiguate).
   */
  modelCatalogActiveIndex?: number;
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

/** Create the ACP agent app (handlers registered; call `connect(stream)` to serve). */
export function createAcpAgent(options: AcpAgentOptions): AgentApp {
  // `CODENT_ACP_TRACE=1` narrates every outgoing `session/update` on stderr (see `emit`).
  const TRACE_UPDATES = process.env.CODENT_ACP_TRACE === "1";
  const app = createAgentApp({ name: AGENT_NAME });
  const rootPath = options.rootPath ?? process.cwd();
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
      // One line per outgoing update, with the id the client keys on and (for text) a snippet: a client
      // that renders something the agent did not send — a doubled prompt, a repeated turn — is settled
      // by reading what WAS sent, instead of guessing at which side duplicated it.
      const key = update as { messageId?: string; toolCallId?: string; content?: { text?: string } };
      const text = typeof key.content?.text === "string" ? ` ${JSON.stringify(key.content.text.slice(0, 40))}` : "";
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
    if (!model || options.modelCatalogActiveIndex === undefined) return undefined;
    const active = options.modelCatalog?.find((entry) => entry.index === options.modelCatalogActiveIndex);
    return active?.models.includes(model) ? active.index : undefined;
  };

  const attach = (
    session: AgentSession,
    clientCaps: ClientCapabilities | undefined,
    acpId: string,
    runtime: SessionRuntime,
    /**
     * Replay the stored transcript. Done HERE, before {@link AcpProjector.start} subscribes: a
     * session delivers its current messages to a NEW subscriber, so subscribing first emitted the
     * whole conversation live and the replay emitted the assistant half of it again (with every
     * historical tool call created `pending` and then corrected) — the duplicated, mis-ordered
     * transcript a `session/load` produced. Replaying first also primes the cursors, which is what
     * makes that retained delivery idempotent.
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
    // No id may own two live bridges. The `set` below would ORPHAN a previous one: its projector
    // keeps its subscription, so every later update is emitted twice under the SAME session id, while
    // its stale cursors keep racing the new projector's (which is how a transcript comes out
    // duplicated and out of order). Nothing else would ever stop it — only `close` runs `closeBridge`.
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
      modes: sessionModes(snapshot.mode),
      configOptions: sessionConfigOptions(snapshot, options.modelCatalog, bridge.selectedModelEntryIndex),
    };
  });

  const resumeSession = async (
    sessionId: string,
    replay: boolean,
    clientCaps: ClientCapabilities | undefined,
    mcpServers: McpServer[] | undefined,
    additionalDirectories: string[] | undefined
  ): Promise<void> => {
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
      return;
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
    attach(session, clientCaps, sessionId, runtime, replay);
  };

  app.onRequest(methods.agent.session.load, async (ctx) => {
    await resumeSession(ctx.params.sessionId, true, initCaps, ctx.params.mcpServers, ctx.params.additionalDirectories);
    return {};
  });

  app.onRequest(methods.agent.session.resume, async (ctx) => {
    await resumeSession(ctx.params.sessionId, false, initCaps, ctx.params.mcpServers, ctx.params.additionalDirectories);
    return {};
  });

  app.onRequest(methods.agent.session.close, async (ctx) => {
    const bridge = bridges.get(ctx.params.sessionId);
    if (bridge) await closeBridge(bridge);
    return {};
  });

  // --------------------------------------------------------------------------
  // Session catalog (list / delete / fork)
  // --------------------------------------------------------------------------

  app.onRequest(methods.agent.session.list, async (ctx) => {
    const listPersisted = options.host.listPersistedSessions;
    if (!listPersisted) {
      // Not advertised in initialize for such a host — but a client may call anyway.
      throw new Error("This host cannot enumerate persisted sessions (no listPersistedSessions capability)");
    }
    // `ListSessionsRequest` carries only `cwd`, `cursor` and `_meta` (no `additionalDirectories`,
    // unlike the session-creating requests), so there is nothing here to refuse. `cwd` is purely
    // an optional filter and is NOT forwarded: the root is fixed at handshake, and the catalog we
    // answer from is already scoped to it, so echoing the client's value back would only pretend
    // to filter.
    if (ctx.params.cwd && ctx.params.cwd !== rootPath) {
      process.stderr.write(
        `[codent-acp] note: session cwd ${ctx.params.cwd} differs from workspace root ${rootPath}\n`
      );
    }
    const listed = await listPersisted.call(options.host);
    const page = paginateSessions(listed, rootPath, { cursor: ctx.params.cursor });
    return {
      sessions: page.sessions,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  });

  app.onRequest(methods.agent.session.delete, async (ctx) => {
    const deleteSession = options.host.deleteSession;
    if (!deleteSession) {
      throw new Error("This host cannot delete persisted sessions (no deleteSession capability)");
    }
    // `DeleteSessionRequest` carries only `sessionId` — nothing else to check.
    const sessionId = ctx.params.sessionId;
    // Stop and unregister a live session first: deleting the log out from under a running
    // agent would leave an append stream writing to a removed file.
    const live = bridges.get(sessionId);
    if (live) await closeBridge(live);

    // Success is "was live, or its file is gone" — a session created by `session/new` and
    // deleted immediately has NO file yet (`ensureSessionData` only mints the id in memory),
    // so a bare `store.delete` returning false must not be reported as "not found".
    const removed = await deleteSession.call(options.host, sessionId);
    if (!removed && !live) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return {};
  });

  app.onRequest(methods.agent.session.fork, async (ctx) => {
    const sourceId = ctx.params.sessionId;
    const bridge = bridges.get(sourceId);
    if (!bridge) throw new Error(`Unknown session: ${sourceId}`);

    // Same refusal as every other request type (defined once above) — a fork is exactly as
    // unable to widen the workspace root as a fresh session is.
    rejectAdditionalDirectories(ctx.params.additionalDirectories);

    // Mirror `session/new`'s note: the root is fixed at handshake, so a differing `cwd` is
    // informational rather than an error (a fork cannot move the source's conversation).
    if (ctx.params.cwd && ctx.params.cwd !== rootPath) {
      process.stderr.write(
        `[codent-acp] note: session cwd ${ctx.params.cwd} differs from workspace root ${rootPath}\n`
      );
    }

    // MCP servers are fixed when the agent is created, and this path REUSES the source's live
    // agent — there is no `Host.create` on the fork path — so a fork genuinely cannot swap them.
    // Rejecting loudly beats ignoring the parameter.
    //
    // This is the fork-only rule: `session/load` and `session/resume` DO obey `mcpServers`,
    // because each of those builds a fresh agent through `Host.create`.
    if (ctx.params.mcpServers?.length) {
      throw new Error(
        "session/fork does not accept mcpServers: MCP servers are fixed when a session is created " +
          "and forking does not change them"
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
      modes: sessionModes(snapshot.mode),
      configOptions: sessionConfigOptions(snapshot, options.modelCatalog, bridge.selectedModelEntryIndex),
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
      configOptions: sessionConfigOptions(snapshot, options.modelCatalog, bridge.selectedModelEntryIndex),
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
    if (!bridge) throw new Error(`Unknown session: ${ctx.params.sessionId}`);
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
    if (!bridge) throw new Error(`Unknown session: ${ctx.params.sessionId}`);

    // Look the id up in the SET WE ADVERTISE rather than comparing against a literal: adding an
    // option later must not leave this check behind (a hardcoded id would reject the new one).
    const option = sessionConfigOptions(
      bridge.session.getSnapshot(),
      options.modelCatalog,
      bridge.selectedModelEntryIndex
    ).find((entry) => entry.id === ctx.params.configId);
    if (!option) throw new Error(`Unknown configuration option: ${ctx.params.configId}`);

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
        const applied = await applyModel(toTarget(bridge), ctx.params.value as string, options.modelCatalog);
        // Record the entry the connection came from, so every later advertisement names it instead
        // of first-matching a model id that several entries may share. A bare re-selection of the
        // current model reports no entry and leaves the recorded one alone.
        if (applied.entryIndex !== undefined) bridge.selectedModelEntryIndex = applied.entryIndex;
        break;
      }
      default:
        // No third option is advertised, so an unhandled category is a real gap. Swallow it and the
        // client's selector silently stops meaning anything.
        throw new Error(`Configuration option "${option.id}" has no write path (category: ${option.category})`);
    }
    advertise(bridge, before);

    // Protocol requires the FULL set back (there is no incremental form), read after the change.
    return {
      configOptions: sessionConfigOptions(
        bridge.session.getSnapshot(),
        options.modelCatalog,
        bridge.selectedModelEntryIndex
      ),
    };
  });

  app.onRequest(methods.agent.session.prompt, async (ctx) => {
    const bridge = bridges.get(ctx.params.sessionId);
    if (!bridge) throw new Error(`Unknown session: ${ctx.params.sessionId}`);
    const run = bridge.chain.then(() => runPrompt(bridge, ctx.params));
    bridge.chain = run.catch(() => undefined);
    return run;
  });

  app.onNotification(methods.agent.session.cancel, (ctx) => {
    const bridge = bridges.get(ctx.params.sessionId);
    if (!bridge) return;
    bridge.cancelled = true;
    for (const controller of bridge.pending) controller.abort();
    bridge.pending.clear();
    void bridge.session.dispatch({ type: "stop" }).catch(() => undefined);
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
      // A turn can SUSPEND — an approval or an `ask_user` — and the pump RETURNS there: the client
      // answers, `respondToToolApproval` starts a new pump, and the SAME turn keeps streaming.
      // Resolving the prompt at that point told the client the turn was over while its continuation
      // still arrived — messages updating under a "not running" status. Wait for the TURN instead:
      // the status leaves the active set only when the turn really ends, since a wait is still active.
      await waitForTurnEnd(bridge);
    } catch (error) {
      if (bridge.cancelled) return { stopReason: "cancelled" };
      throw error;
    }
    return { stopReason: stopReasonFor(bridge) };
  };

  /**
   * Resolve once the session is no longer ACTIVE — the turn is over, not merely suspended — or once
   * this session was cancelled.
   *
   * The event is the mechanism and a short interval is the safety net. A status change that never
   * reaches us would otherwise hang the prompt for good, and a hung prompt BLOCKS the client's next
   * submission (`bridge.chain` serializes prompts): that is exactly "after an abort, typing does
   * nothing". A cancel also ends the wait by definition — the client asked for it — so `cancelled`
   * counts as over, whether or not the status has landed yet.
   */
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
