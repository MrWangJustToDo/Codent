/**
 * Local AgentSessionHost — wraps AgentManager + LocalAgentSession.
 *
 * Bootstrap resume (`continueSession` / `resumeSessionId` on create) resolves the
 * target id first, adopts it via `initialSessionId` (so the session-scoped log
 * sink is correct from the start), then calls the same
 * {@link ManagedAgent.restoreSession} path as Session command `session.resume`.
 * Mid-session switches should use `session.dispatch({ type: "session.resume", ... })`.
 */

import { SessionStore } from "../agent/persistence/session-store.js";
import { getEnv, type ResolvedCoreEnv } from "../env";
import { DEFAULT_AGENT_MAX_ITERATIONS } from "../runtime-types/agent-limits.js";

import { createLocalAgentSession } from "./local-agent-session.js";

import type {
  AgentSessionCreateOptions,
  AgentSessionCreateResult,
  AgentSessionHost,
  AgentSessionListEntry,
} from "./host-types.js";
import type { LocalAgentSessionManager } from "./local-agent-session.js";
import type { AgentSession } from "./types.js";
import type { SessionMeta } from "../agent/persistence/types.js";
import type { AgentManager } from "../managers/agent-manager.js";
import type { ManagedAgent, ManagedAgentConfig } from "../managers/managed-agent.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";

/** Minimal manager surface required by the Local Host (AgentManager satisfies this). */
export interface LocalAgentSessionHostManager extends LocalAgentSessionManager {
  /** Runtime this host's manager belongs to (env scope for session storage). */
  readonly runtime?: AgentRuntime;
  createManagedAgent(
    config: ManagedAgentConfig,
    parentId?: string,
    id?: string,
    options?: { deferBootstrapEvents?: boolean }
  ): Promise<ManagedAgent>;
  getAgents(): ManagedAgent[];
  destroyAgent(id: string): void;
  /**
   * Await every in-flight teardown (extension flush/deactivate + the log flush chained
   * after it). Optional so the minimal manager surface stays minimal; when absent, the
   * destroy path simply returns without waiting for the teardown to settle.
   */
  settleTeardowns?(): Promise<void>;
  /**
   * Drop this agent's claim on a disk session id (`sessionId → agentId`). Optional so the
   * minimal manager surface stays minimal.
   */
  releaseSessionOwnership?(sessionId: string, agentId: string): void;
}

export interface CreateLocalAgentSessionHostOptions {
  manager: LocalAgentSessionHostManager;
}

function toListEntry(managed: ManagedAgent): AgentSessionListEntry {
  return {
    agentId: managed.id,
    name: managed.name,
    ...(managed.parentId ? { parentId: managed.parentId } : {}),
    status: managed.getStatus(),
    ...(managed.getSessionData?.()?.id ? { activeSessionId: managed.getSessionData()!.id } : {}),
    createdAt: managed.createdAt,
    updatedAt: managed.updatedAt,
  };
}

function toManagedConfig(options: AgentSessionCreateOptions): ManagedAgentConfig {
  // Forward every declared option generically. The old field-by-field copy silently dropped any
  // option the host contract gained but this function did not (temperature / maxTokens /
  // reasoningEffort / compaction / skillDirs / … did nothing through `host.create`).
  //
  // Only the host-owned keys are destructured out: `continueSession` / `resumeSessionId` are
  // consumed by `create()` before this point, and `builtins` is an alias group for five
  // `ManagedAgentConfig` keys.
  const { builtins, continueSession: _continueSession, resumeSessionId: _resumeSessionId, ...forwarded } = options;
  // `undefined` inside the alias group means "keep the built-in default", not "set undefined" —
  // spreading it directly would overwrite a `false` that a runtime default merged in.
  const { lsp, skills, memory, mcp, codeMode } = builtins ?? {};
  return {
    ...forwarded,
    // `AgentConfig` types this as required (the schema's `.default()` makes the parsed output
    // non-optional), so the host materializes the ONE default constant rather than restating it.
    maxIterations: options.maxIterations ?? DEFAULT_AGENT_MAX_ITERATIONS,
    ...(lsp !== undefined ? { lsp } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(memory !== undefined ? { memory } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
    ...(codeMode !== undefined ? { codeMode } : {}),
  };
}

/**
 * Resolve the on-disk session to restore at bootstrap (before the managed agent
 * is created, so its id is fixed before the log sink attaches):
 * - explicit `resumeSessionId`
 * - `continueSession` → most recently updated session
 * - default → most recently updated *empty* session (no user messages), reserved
 *   here so a concurrent process skips it and picks a different one
 *
 * The empty-session branch is **defensive**: a session is written to disk only on its
 * first content save, so a fresh launch has no leftover empty file to reuse and this
 * normally resolves to `undefined` (a new session). It still covers a leftover empty
 * file from an older build or one written empty by `SessionStore.reserveSession`.
 *
 * Returns `undefined` when a fresh session should be created. Best-effort: a
 * degraded/missing CoreEnv fs falls back to a fresh session.
 */
async function resolveBootstrapSessionId(
  options: AgentSessionCreateOptions,
  env: ResolvedCoreEnv,
  /**
   * Whether a disk session is already being run by a live agent in this manager.
   *
   * An IDLE agent's session is an empty, unreserved file as soon as anything persists it (a rename
   * is enough), so `getLatestEmpty()` used to hand that file to the next `create()` — which then hit
   * the ownership table and failed with a 500 ("already active in another live session") instead of
   * starting the fresh session the caller asked for. The reuse is for a session NOBODY is running.
   */
  isTaken: (sessionId: string) => boolean = () => false
): Promise<string | undefined> {
  if (options.resumeSessionId) return options.resumeSessionId;
  try {
    const store = new SessionStore(env);
    if (options.continueSession) {
      const latest = await store.getLatest();
      // The same ownership rule as the empty branch: a session another live root is running is not
      // a candidate, or `create` would fail with "already active in another live session" instead
      // of starting the fresh session the caller asked for.
      if (!latest || isTaken(latest.id)) return undefined;
      return latest.id;
    }
    const empty = await store.getLatestEmpty();
    if (!empty || isTaken(empty.id)) return undefined;
    await store.reserveSession(empty.id);
    return empty.id;
  } catch {
    return undefined;
  }
}

class LocalAgentSessionHostImpl implements AgentSessionHost {
  private readonly manager: LocalAgentSessionHostManager;
  private readonly sessions = new Map<string, AgentSession>();

  constructor(options: CreateLocalAgentSessionHostOptions) {
    this.manager = options.manager;
  }

  async create(options: AgentSessionCreateOptions): Promise<AgentSessionCreateResult> {
    // Resolve the reuse/resume target up front and pass it through as
    // `initialSessionId`, so the managed agent's session id (and thus the
    // session-scoped log sink) is correct before any bootstrap log entry.
    const targetSessionId = await resolveBootstrapSessionId(options, this.storeEnv, (sessionId) =>
      this.manager.getAgents().some((agent) => agent.getSessionData?.()?.id === sessionId)
    );
    let managed: ManagedAgent | undefined;
    try {
      managed = await this.manager.createManagedAgent(
        {
          ...toManagedConfig(options),
          ...(targetSessionId ? { initialSessionId: targetSessionId } : {}),
        },
        undefined,
        undefined,
        { deferBootstrapEvents: true }
      );
      // Full disk restore — same `restoreSession` path as `session.resume`
      // (queues cleared + approval/ask_user reconciled inside restore).
      const restored = targetSessionId ? await managed.restoreSession(targetSessionId) : undefined;
      const initial = restored?.uiMessages ?? [];

      // Fix the session id before the first persist (in-memory only; no disk
      // write until the first save()). The JSONL log sink is attached by the
      // manager before bootstrap events fire, so the timeline includes them.
      managed.ensureSessionData();

      // Chat controller stays behind Session; adapters must not call ManagedAgent.initChat.
      managed.initChat(this.manager as AgentManager, initial);
      managed.syncInteractionStateFromUIMessages(initial);

      // Bootstrap telemetry is deferred until the transcript and chat controller exist:
      // session:start handlers inspect the live session, not the empty pre-restore shell.
      await managed.emitBootstrapEvents?.();

      const session = createLocalAgentSession({
        managed,
        manager: this.manager,
      });
      this.sessions.set(session.id, session);

      return { session, ...(initial.length ? { initialMessages: initial } : {}) };
    } catch (error) {
      // Once createManagedAgent returns, the agent is registered and holds its
      // session claim/log sink. A later restore/chat/bootstrap failure must not
      // leave that half-live agent visible to the manager or owning the session.
      if (managed) {
        try {
          await this.destroy(managed.id);
        } catch {
          // Preserve the original construction error; teardown is best-effort.
        }
      }
      throw error;
    }
  }

  connect(agentId: string): AgentSession | null {
    const cached = this.sessions.get(agentId);
    if (cached) return cached;
    const managed = this.manager.getAgent(agentId);
    if (!managed) return null;
    const session = createLocalAgentSession({
      managed,
      manager: this.manager,
    });
    this.sessions.set(agentId, session);
    return session;
  }

  async list(): Promise<AgentSessionListEntry[]> {
    return this.manager.getAgents().map(toListEntry);
  }

  /** Disk catalog: the workspace's persisted sessions, not the live agents `list()` reports. */
  async listPersistedSessions(): Promise<SessionMeta[]> {
    const store = new SessionStore(this.storeEnv);
    return store.list();
  }

  /**
   * Remove a persisted session.
   *
   * Success is "it was live, or its file is gone". A session minted by `create` and not yet
   * persisted exists only in memory, so `store.delete` returns false for it and reporting that
   * as "not found" would deny the deletion of a session the caller is currently holding.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    // `sessionId` here is the DISK id, while `manager.getAgent` is keyed by AGENT id — so this
    // lookup always misses. It is kept only as a cheap exact-hit probe; the lookup that actually
    // resolves a disk id to its owning agent is `sessionOwningAgent` below.
    const live = this.manager.getAgent(sessionId) ?? this.sessionOwningAgent(sessionId);
    if (live) {
      // Do NOT release the disk-session claim here. `destroy` below releases it at the END of
      // teardown (after the pump is aborted, writes drained, log flushed). Releasing first opened
      // a window where another live agent could resume a session that is about to be deleted,
      // adopt it, and then have every later save silently refused by the tombstone.
      //
      // Do NOT close the session store here either. `destroy` runs the ordered teardown —
      // `session:shutdown` → extension destroy → `close()` → drain → log flush — and awaits it
      // (`destroyAgent` is sync, but `settleTeardowns` is not). Closing first made every write a
      // shutdown handler performs a no-op (`persistSession` refuses after close), so the final
      // extension work was silently dropped on the delete path only. The file is removed after
      // that teardown returns, so the ordering this barrier was protecting still holds.
      // Record the deletion in the session's own log before teardown flushes it; a session with no
      // live agent has no sink to write to (and no log that would outlive the delete).
      live.emitEvent?.("session:deleted", { sessionId });
      await this.destroy(live.id);
      // `destroy` is NOT enough on its own: it releases a still-empty session's startup
      // reservation but leaves the log file in place, so without this delete a live session that
      // had already been persisted would survive `deleteSession` and keep appearing in
      // `listPersistedSessions`.
      await new SessionStore(this.storeEnv).delete(sessionId).catch(() => undefined);
      // The session was live, so the caller's delete succeeded whether or not it had a file yet.
      return true;
    }
    return new SessionStore(this.storeEnv).delete(sessionId);
  }

  /** Find the live root agent currently holding `sessionId` (ownership table lookup). */
  private sessionOwningAgent(sessionId: string): ManagedAgent | undefined {
    for (const managed of this.manager.getAgents()) {
      if (managed.parentId) continue;
      if (managed.getSessionData?.()?.id === sessionId) return managed;
    }
    return undefined;
  }

  private get storeEnv(): ResolvedCoreEnv {
    return this.manager.runtime?.env ?? getEnv();
  }

  getModelProvider() {
    return this.manager.runtime?.modelProvider;
  }

  getEnv() {
    return this.manager.runtime?.env;
  }

  async destroy(agentId: string): Promise<void> {
    // Capture the root session's store/id before the manager drops the agent.
    const managed = this.manager.getAgent(agentId);
    const store = !managed?.parentId ? (managed?.getSessionStore?.() ?? null) : null;
    const sessionId = store ? managed?.getSessionData()?.id : undefined;

    // Cascade: drop cached sessions for the agent and any children (the manager
    // already removes them from its registry). Child sessions expose their
    // parent via snapshot.parentId.
    for (const [id, entry] of [...this.sessions.entries()]) {
      const parentId = entry.getSnapshot().parentId;
      if (id === agentId || parentId === agentId) {
        this.sessions.delete(id);
      }
    }
    this.manager.destroyAgent(agentId);

    // `destroyAgent` is synchronous but tears extensions down asynchronously; settle here so
    // an awaiting caller (CLI exit, `/new`, tests) is guaranteed the log's final batch is on
    // disk before this returns. Without it the flush races session teardown.
    await this.manager.settleTeardowns?.();

    // Release the startup reservation for a still-empty root session so a later
    // launch reuses it instead of piling up a fresh empty session. Best-effort:
    // a crash keeps the reservation and it expires on its own.
    if (store && sessionId) {
      await store.releaseReservation(sessionId).catch(() => {});
    }
  }
}

/**
 * Create an in-process AgentSessionHost backed by an AgentManager (or test double).
 */
export function createLocalAgentSessionHost(options: CreateLocalAgentSessionHostOptions): AgentSessionHost {
  return new LocalAgentSessionHostImpl(options);
}
