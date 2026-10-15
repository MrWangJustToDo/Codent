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
import { BUILTIN_TOOL_NAMES } from "@codent/core";

import { shouldSuppressApproval } from "./approvals.js";
import { commandsFromSnapshot, dispatchSlashCommand, parseSlashCommand } from "./commands.js";
import { promptBlocksToContent, type PromptCaps } from "./content.js";
import { mapAcpMcpServers } from "./mcp.js";
import {
  buildElicitationRequest,
  mapElicitationResponse,
  mapPermissionOutcome,
  permissionOptions,
} from "./permissions.js";
import { AcpProjector } from "./projector.js";
import { paginateSessions } from "./sessions.js";
import { toolKindFor } from "./tools.js";

import type { AcpClientEnv } from "./client-env.js";
import type { SessionUpdate } from "./types.js";
import type {
  AgentApp,
  AgentConnection,
  AgentContext,
  ClientCapabilities,
  McpServer,
  PromptRequest,
  SessionConfigOption,
  SessionMode,
  SessionModeState,
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

/** Per-session bookkeeping. */
/**
 * A session's runtime: the host its agent was created on, plus the two things the caller needs
 * from a per-session (client-backed) runtime — late binding of the disk id, and release.
 */
interface SessionRuntime {
  host: AgentSessionHost;
  /** Bind the disk session id once `host.create` has minted it. */
  bind: (sessionId: string) => void;
  dispose: () => Promise<void>;
  /**
   * The client-backed env, when this runtime has one (`--client-env`).
   *
   * Present means "writes may leave this process", which is what decides whether an approval is
   * still ours to ask — see `approvals.ts`.
   */
  clientEnv?: AcpClientEnv;
}

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
const MODE_IDS: AgentMode[] = ["normal", "auto", "plan"];
const MODE_META: Record<AgentMode, { name: string; description: string }> = {
  normal: { name: "Normal", description: "Ask before risky actions" },
  auto: { name: "Auto", description: "Skip tool approvals (YOLO)" },
  plan: { name: "Plan", description: "Explore read-only, then build a plan" },
};

function sessionModes(current: AgentMode): SessionModeState {
  const availableModes: SessionMode[] = MODE_IDS.map((id) => ({ id, ...MODE_META[id] }));
  return { currentModeId: current, availableModes };
}

/**
 * The ACP session id for a live session: the **disk** session id (`ses_…`), never the agent id.
 *
 * `AgentSession.id` is the agent id (`agent_…`, `local-agent-session.ts`), and the two are not
 * interchangeable: `session/load` / `session/resume` address a PERSISTED conversation, and
 * `session/list` / `session/delete` hand out disk ids too. Exposing the agent id here (as this
 * did) made the id returned by `session/new` unusable for `session/load`, and made
 * `session/delete` / `session/fork`'s "find the live bridge" lookups miss every session
 * enumerated from disk.
 *
 * `host.create` mints one via `managed.ensureSessionData()` before returning, so this is always
 * present for a root session.
 */
function diskSessionId(session: AgentSession): string {
  const active = session.getSnapshot().activeSessionId;
  if (!active) {
    // Not expected for a root session (see above). Fail loudly rather than fall back to the
    // agent id, which would silently reintroduce the two-id-spaces bug this guards against.
    throw new Error(`ACP session has no disk session id (agent ${session.id})`);
  }
  return active;
}

/**
 * The session config select (`category: "mode"`) advertised by `session/new` and `session/fork`.
 * Reads the same `mode` channel state as `session/set_mode` / `current_mode_update`, so it is a
 * projection of that truth, not a second source.
 */
function sessionConfigOptions(current: AgentMode): SessionConfigOption[] {
  return [
    {
      id: "mode",
      name: "Mode",
      description: "How the agent handles risky actions",
      category: "mode",
      type: "select",
      currentValue: current,
      options: MODE_IDS.map((id) => ({ value: id, name: MODE_META[id].name, description: MODE_META[id].description })),
    },
  ];
}

/** Create the ACP agent app (handlers registered; call `connect(stream)` to serve). */
export function createAcpAgent(options: AcpAgentOptions): AgentApp {
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
    try {
      void client()
        .notify(methods.client.session.update, { sessionId: acpId, update })
        .catch(() => {});
    } catch {
      // not connected yet — drop
    }
  };

  /**
   * Build this session's runtime.
   *
   * Without `--client-env` there is nothing per-session: `bind` is a no-op and `dispose` does
   * nothing, so every call site reads the same whether or not the flag is on.
   */
  const createRuntime = async (): Promise<SessionRuntime> => {
    if (!options.createSessionHost) {
      return { host: options.host, bind: () => undefined, dispose: async () => undefined };
    }
    let sessionId = "";
    const perSession = await options.createSessionHost({
      client,
      // `undefined` while the session does not exist yet: `host.create` reads workspace files
      // (AGENTS.md / CLAUDE.md, `.lsp.json`, `.mcp.json`) before it hands back a session, and those
      // reads have no session to tag. They are answered locally instead of refused — see the
      // factory contract in `agent.ts`, and Bug A's trace: a throw here was swallowed by the
      // instruction loader's `catch`, which silently produced a session with no project rules.
      sessionId: () => (sessionId ? sessionId : undefined),
      clientCapabilities: initCaps,
    });
    return {
      host: perSession.host,
      bind: (id: string) => {
        sessionId = id;
      },
      dispose: perSession.dispose,
      ...(perSession.clientEnv ? { clientEnv: perSession.clientEnv } : {}),
    };
  };

  const attach = (
    session: AgentSession,
    clientCaps: ClientCapabilities | undefined,
    acpId: string,
    runtime: SessionRuntime
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
    bridge.projector.start();
    bridges.set(acpId, bridge);
    return bridge;
  };

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

  const handleInteractions = async (bridge: SessionBridge, payload: unknown): Promise<void> => {
    const snapshot = payload as {
      approvals?: Array<{ approvalId: string; toolName: string; toolCallId: string }>;
      askUser?: Array<{ toolCallId: string; question: string; options?: string[]; multiSelect?: boolean }>;
    };
    for (const approval of snapshot.approvals ?? []) {
      if (bridge.seenApprovals.has(approval.approvalId)) continue;
      bridge.seenApprovals.add(approval.approvalId);
      // Under `--client-env` some approvals are the client's to grant, and it already did (it
      // served the `fs/*` call we made). Asking again would be the same question twice, so the
      // answer is given here instead — see `approvals.ts` for the exact set and the exclusions.
      if (
        bridge.clientEnv &&
        shouldSuppressApproval({
          approval,
          messages: bridge.session.getSnapshot().messages ?? [],
          clientEnv: bridge.clientEnv,
          mode: bridge.session.getSnapshot().mode,
        })
      ) {
        bridge.clientOwnedApprovals += 1;
        void bridge.session
          .dispatch({ type: "respondApproval", approvalId: approval.approvalId, approved: true })
          .catch(() => undefined);
        continue;
      }
      void requestApproval(bridge, approval);
    }
    for (const ask of snapshot.askUser ?? []) {
      if (bridge.seenAskUser.has(ask.toolCallId)) continue;
      bridge.seenAskUser.add(ask.toolCallId);
      void requestElicitation(bridge, ask);
    }
  };

  const requestApproval = async (
    bridge: SessionBridge,
    approval: { approvalId: string; toolName: string; toolCallId: string }
  ): Promise<void> => {
    const controller = new AbortController();
    bridge.pending.add(controller);
    try {
      const response = await client().request(
        methods.client.session.requestPermission,
        {
          sessionId: bridge.acpId,
          toolCall: {
            toolCallId: approval.toolCallId,
            title: approval.toolName,
            kind: toolKindFor(approval.toolName),
            status: "pending",
          },
          options: permissionOptions(),
        },
        { cancellationSignal: controller.signal }
      );
      const decision = mapPermissionOutcome(response);
      if (!decision) return;
      await bridge.session.dispatch({
        type: "respondApproval",
        approvalId: approval.approvalId,
        approved: decision.approved,
      });
    } catch {
      // connection closed / cancelled — the session's own approval timeout settles it
    } finally {
      bridge.pending.delete(controller);
    }
  };

  const requestElicitation = async (
    bridge: SessionBridge,
    ask: { toolCallId: string; question: string; options?: string[]; multiSelect?: boolean }
  ): Promise<void> => {
    const controller = new AbortController();
    bridge.pending.add(controller);
    try {
      if (!bridge.elicitation) {
        emit(bridge.acpId, {
          sessionUpdate: "agent_message_chunk",
          messageId: `${bridge.acpId}-ask-${ask.toolCallId}`,
          content: { type: "text", text: `The agent asked: ${ask.question}` },
        });
        await bridge.session.dispatch({
          type: "addToolResult",
          toolCallId: ask.toolCallId,
          output: askUserOutput(ask, null, true),
        });
        return;
      }
      const response = await client().request(
        methods.client.elicitation.create,
        buildElicitationRequest(bridge.acpId, ask),
        { cancellationSignal: controller.signal }
      );
      await bridge.session.dispatch({
        type: "addToolResult",
        toolCallId: ask.toolCallId,
        output: askUserOutput(ask, mapElicitationResponse(response), false),
      });
    } catch {
      // connection closed / cancelled — leave the interaction to time out
    } finally {
      bridge.pending.delete(controller);
    }
  };

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
    // Record what the client is being told, so `set_mode` knows whether it changed anything.
    bridge.lastAdvertisedConfigMode = snapshot.mode;
    return {
      sessionId: acpId,
      modes: sessionModes(snapshot.mode),
      configOptions: sessionConfigOptions(snapshot.mode),
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
    // The client told us the id here, so the client-backed env can carry it from the start.
    const runtime = await createRuntime();
    runtime.bind(sessionId);
    const { session } = await runtime.host.create({
      ...createOptions(mapped.servers),
      resumeSessionId: sessionId,
    });
    // The requested disk id is authoritative here (it is what the client will keep using);
    // `diskSessionId` is the same value after the restore, so assert rather than diverge.
    const bridge = attach(session, clientCaps, sessionId, runtime);
    if (replay) bridge.projector.replayFrom(session.getSnapshot());
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
    return {
      sessionId: newId,
      modes: sessionModes(snapshot.mode),
      configOptions: sessionConfigOptions(snapshot.mode),
    };
  });

  app.onRequest(methods.agent.session.setMode, async (ctx) => {
    const mode = ctx.params.modeId as AgentMode;
    if (!MODE_IDS.includes(mode)) throw new Error(`Unknown mode: ${ctx.params.modeId}`);
    const bridge = bridges.get(ctx.params.sessionId);
    if (bridge) {
      await bridge.session.dispatch({ type: "mode.set", mode });
      // Re-read the mode from the session rather than echoing the request: the dispatch may be a
      // no-op (already in that mode) or clamp to something else, and the advertised option must
      // describe what the session ACTUALLY is. Without this update the client keeps whatever
      // `configOptions` it got from `session/new`/`session/fork` and its selector drifts silently.
      const current = bridge.session.getSnapshot().mode;
      if (current !== bridge.lastAdvertisedConfigMode) {
        bridge.lastAdvertisedConfigMode = current;
        emit(bridge.acpId, {
          sessionUpdate: "config_option_update",
          configOptions: sessionConfigOptions(current),
        });
      }
    }
    return {};
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
    } catch (error) {
      if (bridge.cancelled) return { stopReason: "cancelled" };
      throw error;
    }
    return { stopReason: stopReasonFor(bridge) };
  };

  return app;
}

/** `ask_user` result shaped for `askUserOutputSchema` (the client tool's contract). */
function askUserOutput(
  ask: { question: string; options?: string[] },
  answer: { answer: string; selected?: string[]; draft?: string } | null,
  cancelled: boolean
): Record<string, unknown> {
  return {
    question: ask.question,
    answer: answer?.answer ?? "",
    hasOptions: Boolean(ask.options?.length),
    durationMs: 0,
    cachedOutputPath: null,
    success: true,
    tool: BUILTIN_TOOL_NAMES.askUser,
    ...(answer?.selected ? { selected: answer.selected, multiSelect: true } : {}),
    ...(answer?.draft !== undefined ? { draft: answer.draft } : {}),
    ...(cancelled ? { cancelled: true } : {}),
  };
}

function stopReasonFor(bridge: SessionBridge): StopReason {
  const snapshot = bridge.session.getSnapshot();
  if (bridge.cancelled || snapshot.status === "aborted") return "cancelled";
  if (snapshot.status === "error") return "end_turn";
  const { iteration } = snapshot;
  if (iteration.max > 0 && iteration.current >= iteration.max) return "max_turn_requests";
  if (bridge.lastFinishReason === "length") return "max_tokens";
  return "end_turn";
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
