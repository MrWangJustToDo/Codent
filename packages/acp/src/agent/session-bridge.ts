/**
 * The per-session bridge: one `AgentSession`, the ACP handle it answers on, and the child
 * projectors for the delegations it announced.
 *
 * This module owns the session MAP and its lifecycle — attach (subscribe, replay, defer), close
 * (settle, stop, release), the re-key a replacement conversation needs, and the lookup rules a
 * request uses to find its bridge. The request handlers own protocol semantics; they ask this
 * registry for a bridge rather than touching the map.
 *
 * Four ordering facts are load-bearing, and each was a shipped bug before it was a rule:
 * - replay happens BEFORE `projector.start` subscribes (a session hands its retained values to a
 *   new subscriber, so subscribing first emits the conversation live and the replay repeats it);
 * - an id may never own two live bridges (the second projector keeps its subscription, so every
 *   update goes out twice with two sets of cursors racing);
 * - a child id is announced by the parent projector BEFORE its own frames, and attached after;
 * - a child is parent-owned: closing or removing one only stops projection.
 */

import { createChildProjector, type ChildProjectorHandle } from "../projection/child-projector.js";
import { AcpProjector } from "../projection/projector.js";
import { commandsFromSnapshot } from "../session/commands.js";
import { diskSessionId } from "../session/session-status.js";

import { notify } from "./notice.js";

import type { AcpAgentOptions } from "./options.js";
import type { AcpClientEnv } from "../client-env/environment.js";
import type { InteractionHandlers } from "../interaction/interactions.js";
import type { McpElicitation } from "../interaction/mcp-elicitation.js";
import type { SessionRuntime } from "../session/session-runtime.js";
import type { PromptCaps } from "../wire/content.js";
import type { SessionUpdate } from "../wire/types.js";
import type { ClientCapabilities, McpServer } from "@agentclientprotocol/sdk";
import type { AgentMode, AgentSession, AgentSessionSubagentSummary } from "@codent/core";

/** Per-session bookkeeping. */
export interface SessionBridge {
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
  /**
   * The raw ACP `McpServer[]` this session was created/resumed with (not the mapped core form).
   *
   * Kept so a fork can restore the SOURCE conversation as a second live session with the same
   * servers: the source's agent was switched to the clone, and a plain resume with `undefined` would
   * fall back to the workspace file and silently change its tool set.
   */
  mcpServers?: McpServer[];
  /**
   * This session's MCP elicitation channel, when the client can render a form.
   *
   * Bound to the bridge ITSELF, not to an id: the hook reads `acpId` on every call, so a fork — the
   * one place the outgoing handle changes (`bridge.acpId = newId`) — carries the clone's handle
   * without re-binding, and a question raised mid-fork cannot be scoped to the source's conversation.
   */
  mcpElicitation?: McpElicitation;
  /** `close` is idempotent: `conn.closed` and `session/close` can race. */
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

/** Everything `attach` needs to know about the session it is attaching. */
export interface BridgeAttachOptions {
  /** This session's workspace root (`cwd` from the request). */
  rootPath: string;
  /** The conversation the session is attached to. */
  diskSessionId: string;
  /** The MCP list it was created with, as a comparison key (`mcpKeyOf`). */
  mcpKey?: string;
  /**
   * Replay the transcript. Done HERE, BEFORE `AcpProjector.start` subscribes — a session
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
  /** Raw ACP MCP server list, retained for a fork's source re-attach. */
  mcpServers?: McpServer[];
  /** The session's MCP elicitation channel (absent when the client cannot render a form). */
  mcpElicitation?: McpElicitation;
}

export interface SessionBridgeRegistryDeps {
  options: AcpAgentOptions;
  /** Send one `session/update` under a handle. */
  emit: (acpId: string, update: SessionUpdate) => void;
  /** The permission/question round-trips `close` has to settle. */
  interactions: InteractionHandlers;
  /** Disk session id → workspace root (shared with `session/delete`, which carries no `cwd`). */
  sessionRoots: Map<string, string>;
  /** Every child id ever announced — screened out of the top-level requests. */
  knownChildIds: Set<string>;
}

/**
 * The session map. Every method is about ONE of: attaching a conversation, releasing it, re-keying
 * it after the conversation changed, or finding it from an id the client sent.
 */
export interface SessionBridgeRegistry {
  attach(
    session: AgentSession,
    clientCaps: ClientCapabilities | undefined,
    acpId: string,
    runtime: SessionRuntime,
    opts: BridgeAttachOptions
  ): SessionBridge;
  /** Find a bridge by its stable ACP handle OR its current disk session id. */
  find(id: string): SessionBridge | undefined;
  /** Same lookup without the deferred-flush side effect (for a request that will not emit). */
  lookup(id: string): SessionBridge | undefined;
  /** The bridge registered under exactly this key, if any. */
  get(acpId: string): SessionBridge | undefined;
  /** Register a bridge under `acpId` without touching any other entry (the fork re-key window). */
  set(acpId: string, bridge: SessionBridge): void;
  /** Re-key a forked bridge: it now answers on `nextId`, and every id of the source is dropped. */
  rekey(bridge: SessionBridge, nextId: string, sourceIds: readonly string[]): void;
  close(bridge: SessionBridge): Promise<void>;
  /** Connection close: settle and release every bridge rather than parking them on a dead client. */
  closeAll(): Promise<void>;
  isChild(sessionId: string, deep?: boolean): Promise<boolean>;
  /**
   * Rebind a stable ACP handle after the underlying conversation changed (`/new`, `/clone`,
   * `/resume`). The client keeps using `bridge.acpId`; `session_info_update._meta.diskSessionId`
   * tells a client that can use it which conversation it now is.
   */
  rebindAfterReplacement(bridge: SessionBridge, command: string): void;
  /** Stop every child projector and forget their announcements (a NEW parent conversation). */
  resetChildren(bridge: SessionBridge): void;
  /**
   * Reconcile the child projectors an announced `subagents` snapshot implies.
   *
   * Called by the parent projector AFTER it emitted announcements, so the client always learns a
   * child id before any update tagged with it. This is the only place a child gets a projector, and
   * it never creates or destroys a child session: a removed row just stops projection.
   */
  syncChildren(bridge: SessionBridge, rows: AgentSessionSubagentSummary[]): void;
}

class BridgeRegistry implements SessionBridgeRegistry {
  private readonly bridges = new Map<string, SessionBridge>();

  constructor(private readonly deps: SessionBridgeRegistryDeps) {}

  attach(
    session: AgentSession,
    clientCaps: ClientCapabilities | undefined,
    acpId: string,
    runtime: SessionRuntime,
    opts: BridgeAttachOptions
  ): SessionBridge {
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
      selectedModelEntryIndex: this.seededModelEntryIndex(session.getSnapshot().model),
      lastAdvertisedConfigEntryIndex: undefined,
      lastAdvertisedConfigEffort: undefined,
      replayed: false,
      mcpKey: opts.mcpKey ?? "",
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
      // Bound to the bridge: the hook reads `acpId` per call, so `/new` (same handle) and
      // `session/fork` (re-keyed handle) need no re-binding.
      ...(opts.mcpElicitation ? { mcpElicitation: opts.mcpElicitation } : {}),
      closed: false,
      projector: undefined as unknown as AcpProjector,
    };
    // The hook asks through the handle this bridge emits under — the only id a client can address.
    bridge.mcpElicitation?.bind(bridge);
    bridge.projector = new AcpProjector(session, {
      rootPath: opts.rootPath,
      emit: (update) => this.deps.emit(bridge.acpId, update),
      commands: () => commandsFromSnapshot(session.getSnapshot()),
      client: {
        compaction: Boolean(clientCaps?.session?.compaction),
        notices: Boolean(clientCaps?.session?.notices),
        subagents: Boolean(clientCaps?.subagents),
      },
      onSubagents: (rows) => this.syncChildren(bridge, rows),
      onInteraction: (payload) =>
        void this.deps.interactions.handleInteractions(bridge, payload).catch(() => undefined),
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
    this.bridges.get(acpId)?.projector.stop();
    this.bridges.set(acpId, bridge);
    return bridge;
  }

  find(id: string): SessionBridge | undefined {
    const found = this.lookup(id);
    // Any request that reaches a session is followed by updates the client must see in order; a
    // deferred `session/new` seed must not be reordered behind them.
    found?.projector.flushDeferred();
    return found;
  }

  lookup(id: string): SessionBridge | undefined {
    const direct = this.bridges.get(id);
    if (direct) return direct;
    for (const bridge of this.bridges.values()) {
      if (bridge.diskSessionId === id) return bridge;
      try {
        if (diskSessionId(bridge.session) === id) return bridge;
      } catch {
        // A bridge between replacements may have no active id; skip it.
      }
    }
    return undefined;
  }

  get(acpId: string): SessionBridge | undefined {
    return this.bridges.get(acpId);
  }

  set(acpId: string, bridge: SessionBridge): void {
    this.bridges.set(acpId, bridge);
  }

  rekey(bridge: SessionBridge, nextId: string, sourceIds: readonly string[]): void {
    this.bridges.set(nextId, bridge);
    for (const id of sourceIds) {
      if (id !== nextId) this.bridges.delete(id);
    }
  }

  async close(bridge: SessionBridge): Promise<void> {
    if (bridge.closed) return;
    bridge.closed = true;
    // Settle before stopping: an approval is a question the client can no longer answer.
    await this.deps.interactions.settlePendingInteractions(bridge);
    for (const controller of bridge.pending) controller.abort();
    bridge.pending.clear();
    bridge.pendingApprovals.clear();
    bridge.pendingAskUser.clear();
    bridge.approvalPolicy.clear();
    await bridge.session.dispatch({ type: "stop" }).catch(() => undefined);
    // Parent-owned: stop projecting the children, but never destroy them here (`delete`/`close` of a
    // child are screened out by the request handlers; a parent close must not kill a subagent another
    // surface watches).
    for (const child of bridge.subagents.values()) child.stop();
    bridge.subagents.clear();
    bridge.projector.stop();
    for (const [id, candidate] of this.bridges) if (candidate === bridge) this.bridges.delete(id);
    await bridge.runtime.host.destroy(bridge.session.id);
    // Release the per-session env/runtime. A no-op without `--client-env`, and idempotent with it
    // (a fork moves the bridge to a new id, but the runtime instance does not change).
    await bridge.runtime.dispose().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    for (const bridge of [...this.bridges.values()]) {
      await this.close(bridge).catch(() => undefined);
    }
  }

  /**
   * Is this id a child of a live session?
   *
   * The announced set is authoritative: a child has no top-level bridge, so an unannounced id still
   * fails as unknown on the hot paths. `deep` additionally asks the host listing, because a child
   * that was never announced (internal workers are filtered out of `subagents`) must not be
   * resurrected as a root session by `delete`.
   */
  async isChild(sessionId: string, deep = true): Promise<boolean> {
    if (this.deps.knownChildIds.has(sessionId)) return true;
    // Hot paths (prompt/close) only need the announced set: no child has a top-level bridge, so an
    // unannounced id still fails as unknown. `deep` is for anything that could DESTROY a child.
    if (!deep) return false;
    try {
      const entries = await this.deps.options.host.list();
      return entries.some((entry) => entry.agentId === sessionId && entry.parentId !== undefined);
    } catch {
      return false;
    }
  }

  rebindAfterReplacement(bridge: SessionBridge, command: string): void {
    const next = bridge.session.getSnapshot().activeSessionId;
    if (!next || next === bridge.diskSessionId) return;
    bridge.diskSessionId = next;
    bridge.runtime.bind(next);
    bridge.replayed = false;
    // `session/delete` has no cwd, so the new conversation's root must be recorded here too (the
    // id is disclosed to the client via `_meta.diskSessionId` and may be used for a later delete).
    this.deps.sessionRoots.set(next, bridge.rootPath);
    this.deps.emit(bridge.acpId, {
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
        this.deps.emit,
        bridge,
        `This session now refers to conversation ${next}. ACP clients cannot clear the rendered transcript; ` +
          `start a new thread if you need a clean view.`,
        "info"
      );
    }
  }

  resetChildren(bridge: SessionBridge): void {
    for (const child of bridge.subagents.values()) child.stop();
    bridge.subagents.clear();
    bridge.projector.resetSubagents();
  }

  syncChildren(bridge: SessionBridge, rows: AgentSessionSubagentSummary[]): void {
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
      this.deps.knownChildIds.add(row.id);
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
          this.deps.emit(childId, update);
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
  }

  /**
   * The entry a session's connection comes from, when the config tells us: the active entry, and
   * only when it actually holds that session's model. Anything else stays unrecorded rather than
   * guessed — see {@link SessionBridge.selectedModelEntryIndex}.
   */
  private seededModelEntryIndex(model: string | undefined): number | undefined {
    const seeded = this.deps.options.modelsDefaultEntryIndex;
    if (!model || seeded === undefined) return undefined;
    return this.deps.options.models?.entries[seeded]?.models.includes(model) ? seeded : undefined;
  }
}

export function createSessionBridgeRegistry(deps: SessionBridgeRegistryDeps): SessionBridgeRegistry {
  return new BridgeRegistry(deps);
}
