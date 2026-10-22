/**
 * The ACP request table: `createAcpAgent` registers every agent method the protocol defines, wires each to
 * the bridge map, and owns the prompt-turn sequencing and the legacy `session/set_model` shim.
 */
/* eslint-disable max-lines -- Justified ceiling exception: this file is the handler table, and everything
 * that has a subject of its own is already extracted (`stdio` / `tools` / `content` / `paths` /
 * `permissions` / `interactions` / `projector` / `sessions` / `session-config-options` /
 * `session-status`). What remains is one registration block per protocol method over the bridge map and
 * the per-session lifecycle (`attach` / `close` / rebind). The next extraction is `session-bridge.ts`
 * (SessionBridge + attach/close/rebind), which needs those closures threaded through a factory first —
 * a change of its own. Tracks that extraction, not a licence to keep growing here. */
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

import { agent as createAgentApp, methods, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { buildDefaultSystemPrompt, defaultPath, findBuiltinCommand, isActiveStatus } from "@codent/core";
import { createHash } from "node:crypto";

import { createChildProjector, type ChildProjectorHandle } from "./child-projector.js";
import { commandsFromSnapshot, dispatchSlashCommand, parseSlashCommand } from "./commands.js";
import { promptBlocksToContent, type PromptCaps } from "./content.js";
import { createInteractionHandlers, type InteractionHandlers } from "./interactions.js";
import { mapAcpMcpServers } from "./mcp.js";
import { resolveRoot } from "./paths.js";
import { AcpProjector } from "./projector.js";
import {
  applyMode,
  applyModel,
  applyThoughtLevel,
  effortOf,
  legacySessionModelState,
  resolveAdvertisedEntryIndex,
  sessionConfigOptions,
} from "./session-config-options.js";
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
  AgentSessionSubagentSummary,
  ModelCatalogRead,
  ModelInfo,
  ModelStyle,
  AgentMode,
  SessionMeta,
} from "@codent/core";

// Re-exported so a host builds `AcpAgentOptions` from one import site rather than reaching into the
// module that happens to consume the catalog.
export type { AcpModelCatalogEntry } from "./session-config-options.js";

/** Per-session bookkeeping. */
interface SessionBridge {
  session: AgentSession;
  /** The runtime that owns this session (per-session under `--client-env` / per-`cwd`). */
  runtime: SessionRuntime;
  /** Client-backed env for this session, when the flag is on. */
  clientEnv?: AcpClientEnv;
  /**
   * The stable ACP handle all updates/requests are tagged with.
   *
   * This is NOT the disk session id: `/new`, `/clone` and `/resume` replace the underlying
   * conversation while the client keeps talking on this handle (ACP has no "id changed"
   * notification). It starts equal to the disk id.
   */
  acpId: string;
  /** The conversation the session is currently attached to (`activeSessionId`). */
  diskSessionId: string;
  /** This session's workspace root — `cwd` from `new`/`load`/`resume`/`fork`. */
  rootPath: string;
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
  /** The in-flight `request_permission` per approval id (see `interactions.ts`). */
  pendingApprovals: Map<string, AbortController>;
  /** The in-flight question per `ask_user` tool call (form, or the text-prompt fallback). */
  pendingAskUser: Map<
    string,
    {
      controller: AbortController;
      ask: { toolCallId: string; question: string; options?: string[]; multiSelect?: boolean };
      mode: "form" | "text";
      answer?: (text: string) => Promise<void>;
    }
  >;
  /** Session-scoped `allow_always` / `reject_always` decisions, keyed by tool identity. */
  approvalPolicy: Map<string, boolean>;
  elicitation: boolean;
  /** Client advertises `session.notices` — failures/cancellations are reported that way. */
  notices: boolean;
  /** Client advertises `session.compaction` — child projectors inherit it. */
  clientCompaction: boolean;
  /** Client advertises `subagents` — every child frame is gated on it. */
  subagentsSupported: boolean;
  /** Child projectors for the user-visible delegations this session announced. */
  subagents: Map<string, ChildProjectorHandle>;
  /**
   * The first retained `subagents` snapshot of a `session/load` attaches children WITHOUT replaying
   * their history (the change spec: no child replay). Later children are new and replay normally.
   */
  skipChildReplay: boolean;
  promptCaps: PromptCaps;
  /** Canonical snapshot of the MCP server list this session was created with. */
  mcpKey: string;
  /** `closeBridge` is idempotent: `conn.closed` and `session/close` can race. */
  closed: boolean;
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
   * The thinking depth the client was last told about (`reasoningEffort`, or `"off"` when unset).
   *
   * Its own mirror for the same reason as the model: a depth change must re-send the whole set, and
   * `advertise` compares it against what the client's cache says rather than against the request.
   */
  lastAdvertisedConfigEffort: string | undefined;
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
  /** The entry the default model came from — seeds a new session's recorded entry (a seed, not a selection). */
  modelsDefaultEntryIndex?: number;
  /**
   * Build a per-session runtime whose env is backed by this session's workspace root (and, under
   * `--client-env`, by the ACP client).
   *
   * Absent by default, in which case every session goes through `host` exactly as before. When
   * present, `session/new` / `load` / `resume` ask it for a host **bound to that session's root**
   * and use that host instead, which is what makes ACP's `cwd` the session workspace root.
   */
  createSessionHost?: (context: AcpClientEnvFactoryContext) => Promise<AcpSessionRuntime>;
  /** Enumerate persisted sessions for a `session/list` `cwd` other than the process default. */
  listPersistedSessionsAt?: (rootPath: string) => Promise<SessionMeta[]>;
  /** How long a permission/elicitation request waits for the client before being settled. */
  interactionTimeoutMs?: number;
}

/** What {@link AcpAgentOptions.createSessionHost} needs to build one session's runtime. */
export interface AcpClientEnvFactoryContext {
  /**
   * The session's workspace root (`cwd` from the ACP request), already absolute.
   *
   * Each session owns one CoreEnv rooted here; `.agents/**`, relative tool paths and `session/list`
   * all follow it.
   */
  rootPath: string;
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
  /**
   * Child session ids announced to a client. A child never becomes a top-level session: `load`,
   * `resume`, `fork` and `prompt` must refuse it, and `delete` must not hand it to
   * `host.deleteSession` (which looks the id up as an agent and would destroy the child).
   *
   * Ids are never removed — a closed child stays screened rather than turning into "unknown", which
   * would let a late request reach the top-level path.
   */
  const knownChildIds = new Set<string>();
  let connection: AgentConnection | null = null;
  let initCaps: ClientCapabilities | undefined;
  let sessionSeq = 0;

  app.onConnect((conn) => {
    connection = conn;
    // The client is gone: no pending dialog can be answered. Settle them, end the turns and
    // release the per-session runtimes rather than leaving sessions parked on an approval nobody
    // will ever send.
    void conn.closed
      .then(async () => {
        for (const bridge of [...bridges.values()]) {
          await closeBridge(bridge).catch(() => undefined);
        }
      })
      .catch(() => undefined);
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
    const seeded = options.modelsDefaultEntryIndex;
    if (!model || seeded === undefined) return undefined;
    return options.models?.entries[seeded]?.models.includes(model) ? seeded : undefined;
  };

  /** A `cwd` from an ACP request, normalized; `fallback` when the request omitted it. */
  const resolveCwd = (cwd: string | undefined, fallback: string): string => {
    if (!cwd) return fallback;
    if (!defaultPath.isAbsolute(cwd)) {
      throw RequestError.invalidParams(undefined, `cwd must be an absolute path: ${cwd}`);
    }
    return resolveRoot(cwd);
  };

  const sessionSystemPrompt = async (sessionRoot: string, runtime: SessionRuntime): Promise<string | undefined> => {
    if (sessionRoot === rootPath) return options.defaults.systemPrompt;
    const env = runtime.host.getEnv?.();
    // A host that cannot expose its env (an embedder) cannot rebuild the prompt; the boot prompt is
    // the only honest fallback. The real bootstrap host always exposes it.
    if (!env) return options.defaults.systemPrompt;
    try {
      return await buildDefaultSystemPrompt(undefined, env);
    } catch {
      return options.defaults.systemPrompt;
    }
  };

  /**
   * A host without a per-session runtime serves exactly one root. Refuse a foreign `cwd` instead of
   * silently running the session in the wrong workspace — the failure mode ACP's "cwd is the session
   * root" rule exists to prevent.
   */
  const assertSessionRoot = (sessionRoot: string): void => {
    if (sessionRoot !== rootPath && !options.createSessionHost) {
      throw RequestError.invalidParams(
        undefined,
        `This host cannot serve session cwd ${sessionRoot}: it was built for ${rootPath} and has no per-session runtime`
      );
    }
  };

  /** The MCP list a session was created with, as a stable comparison key. */
  const mcpKeyOf = (servers: Record<string, McpServerConfig> | undefined): string =>
    JSON.stringify(Object.entries(servers ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  /** Find a bridge by its stable ACP handle OR its current disk session id. */
  const findBridge = (id: string): SessionBridge | undefined => {
    const found = lookupBridge(id);
    // Any request that reaches a session is followed by updates the client must see in order; a
    // deferred `session/new` seed must not be reordered behind them.
    found?.projector.flushDeferred();
    return found;
  };

  const lookupBridge = (id: string): SessionBridge | undefined => {
    const direct = bridges.get(id);
    if (direct) return direct;
    for (const bridge of bridges.values()) {
      if (bridge.diskSessionId === id) return bridge;
      try {
        if (diskSessionId(bridge.session) === id) return bridge;
      } catch {
        // A bridge between replacements may have no active id; skip it.
      }
    }
    return undefined;
  };

  const attach = (
    session: AgentSession,
    clientCaps: ClientCapabilities | undefined,
    acpId: string,
    runtime: SessionRuntime,
    opts: {
      rootPath: string;
      diskSessionId: string;
      mcpKey?: string;
      /**
       * Replay the transcript. Done HERE, BEFORE {@link AcpProjector.start} subscribes — a session
       * delivers its messages to a new subscriber, so subscribing first doubled the transcript — and
       * priming the cursors first is what makes that retained delivery idempotent.
       */
      replay?: boolean;
      /**
       * Attach the retained children WITHOUT replaying their history. Set by `load`/`resume`
       * (a reconnect must not duplicate a child transcript the client already rendered); a child
       * announced later is new and replays normally.
       */
      skipChildReplay?: boolean;
      /** `session/new`: queue every update until the response frame has gone out. */
      deferEmits?: boolean;
    }
  ): SessionBridge => {
    const bridge: SessionBridge = {
      session,
      runtime,
      clientEnv: runtime.clientEnv,
      acpId,
      diskSessionId: opts.diskSessionId,
      rootPath: opts.rootPath,
      chain: Promise.resolve(),
      cancelled: false,
      lastFinishReason: undefined,
      seenApprovals: new Set(),
      clientOwnedApprovals: 0,
      seenAskUser: new Set(),
      pending: new Set(),
      pendingApprovals: new Map(),
      pendingAskUser: new Map(),
      approvalPolicy: new Map(),
      elicitation: Boolean(clientCaps?.elicitation?.form),
      notices: Boolean(clientCaps?.session?.notices),
      clientCompaction: Boolean(clientCaps?.session?.compaction),
      subagentsSupported: Boolean(clientCaps?.subagents),
      subagents: new Map(),
      skipChildReplay: opts.skipChildReplay ?? opts.replay === true,
      promptCaps: { image: true, audio: true, embeddedContext: true },
      lastAdvertisedConfigMode: undefined,
      lastAdvertisedConfigModel: undefined,
      // The connection's entry, when this process can know it: `session/new` took it from the
      // config's active entry. A resumed session whose model is not in that entry (the file changed
      // under it, or another process switched it) keeps `undefined` — the snapshot carries the model
      // id but not the connection, so first-match resolution is the honest fallback there.
      selectedModelEntryIndex: seededModelEntryIndex(session.getSnapshot().model),
      lastAdvertisedConfigEntryIndex: undefined,
      lastAdvertisedConfigEffort: undefined,
      replayed: false,
      mcpKey: opts.mcpKey ?? "",
      closed: false,
      projector: undefined as unknown as AcpProjector,
    };
    bridge.projector = new AcpProjector(session, {
      rootPath: opts.rootPath,
      emit: (update) => emit(bridge.acpId, update),
      commands: () => commandsFromSnapshot(session.getSnapshot()),
      client: {
        compaction: Boolean(clientCaps?.session?.compaction),
        notices: Boolean(clientCaps?.session?.notices),
        subagents: Boolean(clientCaps?.subagents),
      },
      onSubagents: (rows) => syncChildBridges(bridge, rows),
      onInteraction: (payload) => void handleInteractions(bridge, payload).catch(() => undefined),
      // The finish reason travels on the state payload at run end (core records it with the status
      // flip), so the host reads it from the one channel every session already subscribes to.
      onState: (state) => {
        if (state.lastFinishReason) bridge.lastFinishReason = state.lastFinishReason;
      },
      // Best-effort old content for `write_file`'s diff. `null` means "not readable / new file",
      // which keeps the whole-file preview rather than inventing an edit.
      readFile: async (absolutePath) => {
        const env = runtime.host.getEnv?.();
        if (!env) return null;
        try {
          return await env.fs.readFile(absolutePath);
        } catch {
          return null;
        }
      },
    });
    const replay = opts.replay === true;
    if (replay) {
      bridge.replayed = true;
      // Replay BEFORE subscribing: the replay primes every cursor, so the retained `messages`
      // delivery that `start()` triggers emits nothing.
      bridge.projector.replayFrom(session.getSnapshot());
    }
    bridge.projector.start({
      primeOnly: !replay,
      ...(opts.deferEmits ? { deferEmits: true } : {}),
    });
    // The retained snapshot (even an EMPTY one) has been delivered by now. Clear the one-shot flag
    // here as well: on a load whose retained `subagents` is empty no callback attaches anything, and
    // leaving it set made the FIRST delegation after a load attach without replay (no prompt).
    bridge.skipChildReplay = false;
    // No id may own two live bridges: the `set` below would orphan a previous one, whose projector keeps its subscription — updates emitted twice under one id, and only `close` would ever stop it.
    bridges.get(acpId)?.projector.stop();
    bridges.set(acpId, bridge);
    return bridge;
  };

  /** Stop every child projector and forget their announcements (a NEW parent conversation). */
  const resetChildBridges = (bridge: SessionBridge): void => {
    for (const child of bridge.subagents.values()) child.stop();
    bridge.subagents.clear();
    bridge.projector.resetSubagents();
  };

  /**
   * Reconcile the child projectors an announced `subagents` snapshot implies.
   *
   * Called by the parent projector AFTER it emitted announcements, so the client always learns a
   * child id before any update tagged with it. This is the only place a child gets a projector, and
   * it never creates or destroys a child session: a removed row just stops projection.
   */
  const syncChildBridges = (bridge: SessionBridge, rows: AgentSessionSubagentSummary[]): void => {
    if (!bridge.subagentsSupported) {
      for (const child of bridge.subagents.values()) child.stop();
      bridge.subagents.clear();
      return;
    }

    const wanted = new Set(rows.map((row) => row.id));
    for (const [id, child] of [...bridge.subagents]) {
      if (wanted.has(id)) continue;
      child.stop();
      bridge.subagents.delete(id);
    }

    for (const row of rows) {
      knownChildIds.add(row.id);
      if (bridge.subagents.has(row.id)) continue;
      const childSession = bridge.runtime.host.connect(row.id);
      if (!childSession) continue;
      const child = createChildProjector(childSession, {
        childId: row.id,
        parentSessionId: bridge.acpId,
        ...(row.parentTaskToolCallId ? { parentTaskToolCallId: row.parentTaskToolCallId } : {}),
        emit: (childId, update) => {
          // The parent may close while a child stream is still flushing; a frame tagged with a
          // child id nobody announced any more is worse than a dropped one.
          if (bridge.closed || !bridge.subagentsSupported) return;
          emit(childId, update);
        },
        rootPath: bridge.rootPath,
        client: { compaction: bridge.clientCompaction, notices: bridge.notices },
        isClosed: () => bridge.closed,
      });
      child.start({ replay: !bridge.skipChildReplay });
      bridge.subagents.set(row.id, child);
    }

    // Only the first retained snapshot of a `load`/`resume` suppresses replay; a child announced
    // later is new and replays its own (prompt + early output) history.
    bridge.skipChildReplay = false;
  };

  /**
   * Is this id a child of a live session?
   *
   * The announced set is authoritative for anything a client could have learned. The host listing
   * covers a child that was never announced (internal workers are filtered out of `subagents`), so a
   * guessed id cannot be resurrected as a root session.
   */
  const isChildSessionId = async (sessionId: string, deep = true): Promise<boolean> => {
    if (knownChildIds.has(sessionId)) return true;
    // Hot paths (prompt/close) only need the announced set: no child has a top-level bridge, so an
    // unannounced id still fails as unknown. `deep` is for anything that could DESTROY a child.
    if (!deep) return false;
    try {
      const entries = await options.host.list();
      return entries.some((entry) => entry.agentId === sessionId && entry.parentId !== undefined);
    } catch {
      return false;
    }
  };

  /** The {@link ConfigOptionTarget} shape the shared write helpers act on. */
  const toTarget = (bridge: SessionBridge): ConfigOptionTarget => ({ session: bridge.session, acpId: bridge.acpId });

  /** Build this session's runtime (see `session-runtime.ts`). */
  const createRuntime = (sessionRoot: string): Promise<SessionRuntime> =>
    buildSessionRuntime({ options, client, getClientCapabilities: () => initCaps, rootPath: sessionRoot });

  const notify = (bridge: SessionBridge, message: string, level: "info" | "warning" | "error"): void => {
    if (bridge.notices) {
      emit(bridge.acpId, { sessionUpdate: "notice", severity: level, title: message });
      return;
    }
    emit(bridge.acpId, {
      sessionUpdate: "agent_message_chunk",
      messageId: `${bridge.acpId}-notice-${Date.now()}`,
      content: { type: "text", text: message },
    });
  };

  /**
   * Rebind a stable ACP handle after the underlying conversation changed (`/new`, `/clone`,
   * `/resume`). The client keeps using `bridge.acpId`; `session_info_update._meta.diskSessionId`
   * tells a client that can use it which conversation it now is.
   */
  const rebindAfterReplacement = (bridge: SessionBridge, command: string): void => {
    const next = bridge.session.getSnapshot().activeSessionId;
    if (!next || next === bridge.diskSessionId) return;
    bridge.diskSessionId = next;
    bridge.runtime.bind(next);
    bridge.replayed = false;
    emit(bridge.acpId, {
      sessionUpdate: "session_info_update",
      _meta: { diskSessionId: next },
    } as SessionUpdate);
    // ACP's transcript is append-only; the client cannot retract what it already rendered. Say so
    // instead of letting `/new` / `/resume` look like a no-op in a client that keeps the thread.
    // The conversation changed under the same handle: re-diff its child rows (a cleared session
    // has none, so the old projectors stop). No announcement reset is needed — the handle is the
    // same, so unchanged rows stay announced.
    bridge.projector.resyncSubagents();
    if (command === "session.new" || command === "session.clone" || command === "session.resume") {
      notify(
        bridge,
        `This session now refers to conversation ${next}. ACP clients cannot clear the rendered transcript; ` +
          `start a new thread if you need a clean view.`,
        "info"
      );
    }
  };

  const closeBridge = async (bridge: SessionBridge): Promise<void> => {
    if (bridge.closed) return;
    bridge.closed = true;
    // Settle before stopping: an approval is a question the client can no longer answer.
    await settlePendingInteractions(bridge);
    for (const controller of bridge.pending) controller.abort();
    bridge.pending.clear();
    bridge.pendingApprovals.clear();
    bridge.pendingAskUser.clear();
    bridge.approvalPolicy.clear();
    await bridge.session.dispatch({ type: "stop" }).catch(() => undefined);
    // Parent-owned: stop projecting the children, but never destroy them here (`delete`/`close` of a
    // child are screened out above; a parent close must not kill a subagent another surface watches).
    for (const child of bridge.subagents.values()) child.stop();
    bridge.subagents.clear();
    bridge.projector.stop();
    for (const [id, b] of bridges) if (b === bridge) bridges.delete(id);
    await bridge.runtime.host.destroy(bridge.session.id);
    // Release the per-session env/runtime. A no-op without `--client-env`, and idempotent with it
    // (a fork moves the bridge to a new id, but the runtime instance does not change).
    await bridge.runtime.dispose().catch(() => undefined);
  };

  const { handleInteractions, answerPendingTextAsk, settlePendingInteractions }: InteractionHandlers =
    createInteractionHandlers({
      client,
      emit,
      ...(options.interactionTimeoutMs !== undefined ? { timeoutMs: options.interactionTimeoutMs } : {}),
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
          ...(options.host.listPersistedSessions || options.listPersistedSessionsAt ? { list: {} } : {}),
          ...(options.host.deleteSession ? { delete: {} } : {}),
          resume: {},
          close: {},
          // UNSTABLE in the SDK. Declared because we cover the WHOLE request, which the base spec
          // makes a precondition of declaring `fork`: `mcpServers` is refused loudly (a fork
          // reuses the source's live agent, so its servers genuinely cannot change − unlike
          // `session/new`/`load`/`resume`, which each build a fresh agent and therefore obey it),
          // `additionalDirectories` is refused too, and for a live source `cwd` must match its
          // workspace root (a cold source has no persisted root, so the request's `cwd` is the root
          // it is restored into). Nothing here is silently dropped.
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

  const createOptions = (
    mcpServers?: Record<string, McpServerConfig>,
    systemPrompt = options.defaults.systemPrompt
  ): Parameters<AgentSessionHost["create"]>[0] => {
    sessionSeq += 1;
    return {
      name: `${AGENT_NAME}-${sessionSeq}`,
      model: options.defaults.model,
      ...(options.defaults.modelStyle ? { modelStyle: options.defaults.modelStyle } : {}),
      ...(options.defaults.modelBaseURL ? { modelBaseURL: options.defaults.modelBaseURL } : {}),
      ...(options.defaults.modelApiKey ? { modelApiKey: options.defaults.modelApiKey } : {}),
      ...(options.defaults.modelInfo ? { modelInfo: options.defaults.modelInfo } : {}),
      // A different `cwd` gets the default prompt built from ITS workspace (the boot prompt was
      // built from the process root, so reusing it would embed the wrong project instructions).
      ...(systemPrompt ? { systemPrompt } : {}),
      // Session-supplied servers REPLACE the workspace `.agents/mcp.json` (see
      // `AgentSessionCreateOptions.mcpServers`); absent ⇒ the file is the source, as before.
      ...(mcpServers ? { mcpServers } : {}),
    };
  };

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
    // ACP: `cwd` is the session's workspace root, not a hint. Every relative path, `.agents/**`
    // and `session/list` for this session follow it.
    const sessionRoot = resolveCwd(ctx.params.cwd, rootPath);
    assertSessionRoot(sessionRoot);
    // Mapped (and validated) BEFORE the session exists: a malformed entry must not leave a
    // half-configured session behind, and a client cannot retract one it was never told about.
    const mapped = mapAcpMcpServers(ctx.params.mcpServers);
    if (mapped.error) {
      throw new Error(mapped.error);
    }
    // The runtime owns this session's env (client-backed under `--client-env`), so it is built here
    // rather than borrowed from the process-wide host.
    const runtime = await createRuntime(sessionRoot);
    const systemPrompt = await sessionSystemPrompt(sessionRoot, runtime);
    let session: AgentSession;
    try {
      ({ session } = await runtime.host.create(createOptions(mapped.servers, systemPrompt)));
    } catch (error) {
      // The runtime owns a per-session env; if the session never came to exist, nothing else will
      // ever release it (only `closeBridge` disposes, and there is no bridge yet).
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
    const acpId = diskSessionId(session);
    runtime.bind(acpId);
    const bridge = attach(session, initCaps, acpId, runtime, {
      rootPath: sessionRoot,
      diskSessionId: acpId,
      mcpKey: mcpKeyOf(mapped.servers),
      // The response frame must carry the id before ANY update keyed by it arrives. `start()` queues
      // the retained values and the seed, and the tick below flushes them after the response.
      deferEmits: true,
    });
    const snapshot = session.getSnapshot();
    seedAdvertised(bridge);
    setImmediate(() => {
      // The client may have closed the session between the response and this tick; do not emit
      // seed notifications for an id nobody owns any more.
      if (bridges.get(acpId) !== bridge) return;
      bridge.projector.flushDeferred();
    });
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
    additionalDirectories: string[] | undefined,
    cwd: string | undefined
  ): Promise<SessionBridge> => {
    // A child is not a top-level session: load/resume/fork must not adopt it as one.
    if (await isChildSessionId(sessionId)) {
      throw RequestError.invalidParams(undefined, `Unknown session: ${sessionId}`);
    }
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
    //
    // The id may be the stable handle or the disk id: a client can hand back either after a
    // `/new`-style replacement, when the two deliberately diverge.
    const live = findBridge(sessionId);
    if (live) {
      if (cwd && resolveCwd(cwd, live.rootPath) !== live.rootPath) {
        throw RequestError.invalidParams(
          undefined,
          `cwd ${cwd} does not match the live session's workspace root ${live.rootPath}`
        );
      }
      // A live session's MCP servers are fixed at creation. Silently ignoring a different list
      // would let the client believe it is connected to servers it never reached. `load`/`resume`
      // always carry the field; an empty list is a real value (the file fallback), not "unspecified".
      if (mcpServers !== undefined && mcpKeyOf(mapped.servers) !== live.mcpKey) {
        throw RequestError.invalidParams(
          undefined,
          "mcpServers cannot change for a session that is already live in this process"
        );
      }
      // `load` owes the client the transcript once. A repeat on the live session must not replay it
      // again — the client would render the whole conversation a second time.
      if (replay && !live.replayed) {
        live.replayed = true;
        live.projector.replayFrom(live.session.getSnapshot());
      }
      // A load/resume on a LIVE parent must re-establish its child associations for the client
      // (RFD: invalidate cached child state on reconnect). Announcements are sent after the
      // response frame; the child projectors stay subscribed, so no history is replayed twice.
      setImmediate(() => {
        if (live.closed) return;
        live.projector.resetSubagents();
        live.projector.resyncSubagents();
      });
      return live;
    }
    // `cwd` is the session's workspace root (ACP requires it on load/resume). The client told us
    // the id here, so the per-session env can carry both from the start.
    const sessionRoot = resolveCwd(cwd, rootPath);
    assertSessionRoot(sessionRoot);
    const runtime = await createRuntime(sessionRoot);
    const systemPrompt = await sessionSystemPrompt(sessionRoot, runtime);
    runtime.bind(sessionId);
    let session: AgentSession;
    try {
      ({ session } = await runtime.host.create({
        ...createOptions(mapped.servers, systemPrompt),
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
    return attach(session, clientCaps, sessionId, runtime, {
      rootPath: sessionRoot,
      diskSessionId: diskSessionId(session),
      mcpKey: mcpKeyOf(mapped.servers),
      replay,
      // Both `load` and `resume` are reconnects: an already-announced child must not replay its
      // history. A child created after this attach is new and does replay.
      skipChildReplay: true,
    });
  };

  app.onRequest(methods.agent.session.load, async (ctx) => {
    const bridge = await resumeSession(
      ctx.params.sessionId,
      true,
      initCaps,
      ctx.params.mcpServers,
      ctx.params.additionalDirectories,
      ctx.params.cwd
    );
    seedAdvertised(bridge);
    return {
      ...sessionSelectorsFor(bridge, options.models),
      // The request may have named a disk id while the live bridge uses a stable handle; tell the
      // client which id its updates will carry (ACP has no other place to say it).
      _meta: { sessionId: bridge.acpId },
    };
  });
  app.onRequest(methods.agent.session.resume, async (ctx) => {
    const bridge = await resumeSession(
      ctx.params.sessionId,
      false,
      initCaps,
      ctx.params.mcpServers,
      ctx.params.additionalDirectories,
      ctx.params.cwd
    );
    seedAdvertised(bridge);
    return {
      ...sessionSelectorsFor(bridge, options.models),
      _meta: { sessionId: bridge.acpId },
    };
  });

  app.onRequest(methods.agent.session.close, async (ctx) => {
    // A child has no top-level bridge; closing it is not a way to destroy a subagent.
    if (await isChildSessionId(ctx.params.sessionId, false)) return {};
    const bridge = findBridge(ctx.params.sessionId);
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
    ...(options.listPersistedSessionsAt ? { listPersistedSessionsAt: options.listPersistedSessionsAt } : {}),
    ...(options.host.deleteSession ? { deleteSession: options.host.deleteSession.bind(options.host) } : {}),
    lookupLive: (id) => {
      const bridge = lookupBridge(id);
      return bridge ? { handle: bridge.acpId, diskId: bridge.diskSessionId } : undefined;
    },
    rootPath,
    closeLive: async (sessionId) => {
      const live = findBridge(sessionId);
      if (!live) return false;
      await closeBridge(live);
      return true;
    },
    note: (text) => process.stderr.write(text),
  });
  app.onRequest(methods.agent.session.list, (ctx) => catalog.list(ctx.params));
  app.onRequest(methods.agent.session.delete, async (ctx) => {
    // `deleteSession` looks the id up as an agent; on a child that would destroy a live subagent.
    // Idempotent no-op keeps ACP's delete contract for an id the client does not own.
    if (await isChildSessionId(ctx.params.sessionId)) return {};
    return catalog.remove(ctx.params);
  });

  app.onRequest(methods.agent.session.fork, async (ctx) => {
    const sourceId = ctx.params.sessionId;

    // Same refusal as every other request type (defined once above) — a fork is exactly as
    // unable to widen the workspace root as a fresh session is.
    rejectAdditionalDirectories(ctx.params.additionalDirectories);

    // A fork of a session this process has not opened is NORMAL for a client forking from
    // `session/list`: restore it first, exactly like `load`, then clone (no replay — the client
    // watches the NEW id from here on).
    const wasLive = Boolean(findBridge(sourceId));
    let bridge = findBridge(sourceId);
    if (!bridge) {
      bridge = await resumeSession(sourceId, false, initCaps, ctx.params.mcpServers, undefined, ctx.params.cwd);
    }
    if (!bridge) throw RequestError.invalidParams(undefined, `Unknown session: ${sourceId}`);

    // `cwd` must match the source for a LIVE source (the conversation continues in that workspace).
    // A cold source was just restored at the request's `cwd` (SessionMeta carries no root), so this
    // is an equality check of the root we restored it into.
    const forkRoot = resolveCwd(ctx.params.cwd, bridge.rootPath);
    if (forkRoot !== bridge.rootPath) {
      throw RequestError.invalidParams(
        undefined,
        `fork cwd ${forkRoot} does not match the source session's workspace root ${bridge.rootPath}`
      );
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
    const sourceDiskId = bridge.diskSessionId;
    const sourceHandle = bridge.acpId;

    // Pause projection while the clone runs: the session switches ids mid-dispatch, and an update
    // emitted during that window would still be tagged with the SOURCE id (the client would see
    // it twice — once on the source, once after the rebind).
    bridge.projector.stop();
    // `session.clone` copies the whole transcript (ACP's fork request carries no fork point).
    // The source session is left intact on disk; core also refuses while a run is active.
    let result: { ok: boolean; error?: string; data?: { sessionId?: string } };
    try {
      result = (await bridge.session.dispatch({ type: "session.clone" })) as typeof result;
    } catch (error) {
      // Never leave the source bridge without a subscription just because the clone threw.
      bridge.projector.start({ primeOnly: true });
      throw error;
    }
    if (!result?.ok) {
      bridge.projector.start({ primeOnly: true });
      throw new Error(result?.error ?? "session/fork failed");
    }
    const newId = result.data?.sessionId ?? diskSessionId(bridge.session);

    // Re-key the SAME bridge: `branchSession` already switched the underlying agent to the new
    // session, so a second bridge would double-subscribe and double-send every update. Set the
    // new key before dropping the old one so no frame lands in a gap, and refresh `acpId`
    // because `emit` closes over `bridge.acpId`.
    bridge.acpId = newId;
    bridge.diskSessionId = newId;
    bridge.runtime.bind(newId);
    bridge.replayed = false;
    // A fork is a new conversation: approvals/answers from the source do not carry over.
    bridge.seenApprovals.clear();
    bridge.seenAskUser.clear();
    bridge.approvalPolicy.clear();
    bridges.set(newId, bridge);
    // Drop every id that pointed at the SOURCE conversation: the handle (which may differ from the
    // disk id after an earlier rebind), the requested source id, and its disk id.
    if (sourceHandle !== newId) bridges.delete(sourceHandle);
    if (newId !== sourceId) bridges.delete(sourceId);
    if (sourceDiskId !== newId && sourceDiskId !== sourceId && sourceDiskId !== sourceHandle) {
      bridges.delete(sourceDiskId);
    }
    // The child projectors captured the SOURCE parent id, and their announcements were sent under
    // it. The cloned conversation is a new parent: stop them and re-announce under `newId` after
    // the response (a child has one immediate parent; it cannot stay announced under a retired id).
    resetChildBridges(bridge);
    // Prime + subscribe on the SAME handle: the cloned messages are already in the snapshot, so a
    // plain replay would duplicate the source transcript under the new id. The fork response carries
    // the new id, so queue its seed until the frame has gone out.
    bridge.projector.start({ primeOnly: true, deferEmits: true });
    setImmediate(() => {
      if (bridges.get(newId) !== bridge) return;
      bridge.projector.flushDeferred();
      // The client already has the child transcripts from the source conversation: re-announce the
      // association, but do not replay the child history.
      bridge.skipChildReplay = true;
      bridge.projector.resyncSubagents();
    });

    const snapshot = bridge.session.getSnapshot();
    seedAdvertised(bridge);
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
    previous: { mode: AgentMode; model?: string; entryIndex?: number; effort?: string }
  ): void => {
    const snapshot = bridge.session.getSnapshot();
    if (
      snapshot.mode === previous.mode &&
      snapshot.model === previous.model &&
      bridge.selectedModelEntryIndex === previous.entryIndex &&
      effortOf(snapshot) === previous.effort
    ) {
      return;
    }
    bridge.lastAdvertisedConfigMode = snapshot.mode;
    bridge.lastAdvertisedConfigModel = snapshot.model;
    bridge.lastAdvertisedConfigEntryIndex = resolveAdvertisedEntryIndex(
      options.models,
      snapshot.model,
      bridge.selectedModelEntryIndex
    );
    bridge.lastAdvertisedConfigEffort = effortOf(snapshot);
    emit(bridge.acpId, {
      sessionUpdate: "config_option_update",
      configOptions: sessionConfigOptions(snapshot, options.models, bridge.selectedModelEntryIndex),
    });
  };

  /** Record what the client's config cache now holds after a response that carried the selectors. */
  const seedAdvertised = (bridge: SessionBridge): void => {
    const snapshot = bridge.session.getSnapshot();
    bridge.lastAdvertisedConfigMode = snapshot.mode;
    bridge.lastAdvertisedConfigModel = snapshot.model;
    // The ADVERTISED entry (first match when the connection entry is unknown), not the raw record:
    // the response names an entry, and re-selecting it must not look like a change.
    bridge.lastAdvertisedConfigEntryIndex = resolveAdvertisedEntryIndex(
      options.models,
      snapshot.model,
      bridge.selectedModelEntryIndex
    );
    bridge.lastAdvertisedConfigEffort = effortOf(snapshot);
  };

  /**
   * The values the client was last told about, so {@link advertise} can tell "changed" from "same".
   *
   * The entry index is compared too: switching between two entries that offer the SAME model id
   * (`0:shared` → `1:shared`) changes the connection while the model string stands still, and a
   * client whose cache said `0:shared` must be told. The same holds for the thinking depth, which is
   * a separate `configOptions` entry and moves independently of both.
   */
  const advertised = (
    bridge: SessionBridge
  ): { mode: AgentMode; model?: string; entryIndex?: number; effort?: string } => ({
    mode: bridge.lastAdvertisedConfigMode ?? bridge.session.getSnapshot().mode,
    model: bridge.lastAdvertisedConfigModel,
    entryIndex: bridge.lastAdvertisedConfigEntryIndex,
    effort: bridge.lastAdvertisedConfigEffort,
  });

  app.onRequest(methods.agent.session.setMode, async (ctx) => {
    const bridge = findBridge(ctx.params.sessionId);
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
    const bridge = findBridge(ctx.params.sessionId);
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
        const applied = await applyModel(
          toTarget(bridge),
          ctx.params.value as string,
          options.models,
          bridge.selectedModelEntryIndex
        );
        // Record the entry the connection came from, so every later advertisement names it instead
        // of first-matching a model id that several entries may share. A bare re-selection of the
        // current model reports no entry and leaves the recorded one alone.
        if (applied.entryIndex !== undefined) bridge.selectedModelEntryIndex = applied.entryIndex;
        break;
      }
      case "thought_level":
        await applyThoughtLevel(toTarget(bridge), ctx.params.value as string);
        break;
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
    handler: (ctx: { params: { sessionId: string; modelId: string } }) => Promise<Record<string, unknown>>
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
      const bridge = findBridge(ctx.params.sessionId);
      if (!bridge) throw RequestError.invalidParams(undefined, `Unknown session: ${ctx.params.sessionId}`);
      const before = advertised(bridge);
      const applied = await applyModel(
        toTarget(bridge),
        ctx.params.modelId,
        options.models,
        bridge.selectedModelEntryIndex
      );
      if (applied.entryIndex !== undefined) bridge.selectedModelEntryIndex = applied.entryIndex;
      // Older clients only read `models` / call `session/set_model`; they still need the
      // `configOptions` cache refreshed, or a client rendering both surfaces shows the old value.
      advertise(bridge, before);
      const snapshot = bridge.session.getSnapshot();
      const models = legacySessionModelState(options.models, snapshot.model, bridge.selectedModelEntryIndex);
      // The legacy response carries the updated state itself: a client whose picker is driven by
      // `models` updates from THIS frame, and an empty `{}` left it showing the previous model.
      return {
        configOptions: sessionConfigOptions(snapshot, options.models, bridge.selectedModelEntryIndex),
        ...(models ? { models } : {}),
      };
    }
  );

  app.onRequest(methods.agent.session.prompt, async (ctx) => {
    if (await isChildSessionId(ctx.params.sessionId, false)) {
      throw RequestError.invalidParams(undefined, `Unknown session: ${ctx.params.sessionId}`);
    }
    const bridge = findBridge(ctx.params.sessionId);
    if (!bridge) throw RequestError.invalidParams(undefined, `Unknown session: ${ctx.params.sessionId}`);
    // A prompt can follow `session/new` before the deferred seed tick ran. Flush the seed first so
    // the client gets `available_commands_update` etc. before this turn's tool/text updates.
    bridge.projector.flushDeferred();
    // A prompt arriving while the turn is SUSPENDED on the client (approval / form elicitation) is
    // force-submit: the answer it waits for was replaced by typing, so queueing waits on a client
    // that will never answer. The ONE exception is a text-mode question (a client without form
    // elicitation): its answer IS a plain prompt, so let `runPrompt` settle the tool instead of
    // cancelling the question and starting a new turn.
    const answerText =
      ctx.params.prompt.length === 1 && ctx.params.prompt[0]?.type === "text"
        ? ctx.params.prompt[0].text.trim()
        : undefined;
    const textAskPending =
      Boolean(answerText) &&
      !answerText?.startsWith("/") &&
      bridge.pendingApprovals.size === 0 &&
      [...bridge.pendingAskUser.values()].every((entry) => entry.mode === "text");
    if (bridge.pending.size > 0 && !textAskPending) await interruptBridge(bridge);
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
   * End the running or suspended turn: `session/cancel`, or a prompt that arrives while it waits.
   *
   * Settling the approvals BEFORE `stop` is what bounds the turn: core's `stop` deliberately skips
   * an approval the user has not answered (`needsApproval && approved === undefined`), so without
   * this the session stays in `waiting` and the next prompt parks behind it forever.
   */
  const interruptBridge = async (bridge: SessionBridge): Promise<void> => {
    bridge.cancelled = true;
    await settlePendingInteractions(bridge);
    for (const controller of bridge.pending) controller.abort();
    bridge.pending.clear();
    bridge.pendingApprovals.clear();
    bridge.pendingAskUser.clear();
    await bridge.session.dispatch({ type: "stop" }).catch(() => undefined);
  };

  app.onNotification(methods.agent.session.cancel, async (ctx) => {
    const bridge = findBridge(ctx.params.sessionId);
    if (!bridge) return;
    await interruptBridge(bridge);
  });

  const runPrompt = async (bridge: SessionBridge, params: PromptRequest): Promise<{ stopReason: StopReason }> => {
    bridge.cancelled = false;
    // The finish reason belongs to the run that just ended; a new prompt must not inherit it.
    bridge.lastFinishReason = undefined;
    const mapping = promptBlocksToContent(params.prompt, bridge.promptCaps);
    if (mapping.error) throw new Error(mapping.error);

    const text = typeof mapping.content === "string" ? mapping.content : undefined;
    // The no-elicitation fallback: a plain-text prompt answers a parked question instead of starting
    // a new turn. A slash command is still a command (the question stays pending).
    if (text && !text.trim().startsWith("/") && bridge.pendingApprovals.size === 0) {
      if (await answerPendingTextAsk(bridge, text.trim())) {
        await waitForTurnEnd(bridge);
        return { stopReason: stopReasonFor(bridge) };
      }
    }
    const parsed = text ? parseSlashCommand(text) : null;
    if (parsed && text) {
      // A slash command can change what the client's `configOptions` cache says — `/models` moves the
      // model AND the thinking depth, and `/mode …` moves the mode. The write handlers
      // (`set_config_option` / `set_mode`) re-advertise themselves, so this path must do it too:
      // without it the client keeps rendering the old selector values until something else happens.
      const before = advertised(bridge);
      // The catalog's `command` is the contract, not the slash token: a rename/alias must keep
      // dispatch and rebinding working. `compact` needs its row opened before the dispatch so the
      // projector can wait for the command result instead of the restored status.
      const command = findBuiltinCommand(parsed.name)?.command;
      if (command === "compact") bridge.projector.beginManualCompaction();
      const result = await dispatchSlashCommand(
        bridge.session,
        bridge.session.getSnapshot(),
        parsed,
        options.models,
        bridge.selectedModelEntryIndex
      );
      if (command === "compact") {
        bridge.projector.finishManualCompaction(
          result.compact?.ok ? "completed" : "failed",
          result.compact?.error ?? (result.compact ? undefined : "compaction did not run")
        );
      }
      if (result.entryIndex !== undefined) bridge.selectedModelEntryIndex = result.entryIndex;
      if (result.handled) {
        // `/new` / `/clone` / `/resume` replace the underlying conversation while the client keeps
        // the same handle. Rebind before advertising, so the next update is tagged correctly.
        if (command === "session.new" || command === "session.clone" || command === "session.resume") {
          bridge.seenApprovals.clear();
          bridge.seenAskUser.clear();
          if (command === "session.new") bridge.approvalPolicy.clear();
          rebindAfterReplacement(bridge, command);
        }
        advertise(bridge, before);
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
      const dispatched = await bridge.session.dispatch({ type: "send", content: mapping.content });
      // A rejected dispatch (queue full, run refused, ...) must reach the client as an error. The
      // old `await` ignored `ok`, so the prompt resolved `end_turn` having done nothing.
      if (!dispatched.ok) throw new Error(dispatched.error ?? "The agent could not start the turn");
      // A suspended turn (approval / ask_user) returns the pump while the SAME turn keeps streaming:
      // resolving here told the client the turn was over. Wait for the TURN. */
      await waitForTurnEnd(bridge);
    } catch (error) {
      if (bridge.cancelled) return { stopReason: "cancelled" };
      throw error;
    }
    // A failed run has no ACP error stop reason. Emit the text before resolving, or the client
    // shows a completed turn with no explanation of what went wrong.
    const snapshot = bridge.session.getSnapshot();
    if (snapshot.status === "error") {
      notify(bridge, snapshot.error?.trim() ? snapshot.error : "The run failed.", "error");
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

/** Re-exported for tests / callers that need the snapshot type. */
export type { AgentSessionSnapshot };
