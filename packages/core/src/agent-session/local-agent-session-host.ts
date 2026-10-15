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

import { createLocalAgentSession } from "./local-agent-session.js";

import type {
  AgentSessionCreateOptions,
  AgentSessionCreateResult,
  AgentSessionHost,
  AgentSessionListEntry,
} from "./host-types.js";
import type { LocalAgentSessionManager } from "./local-agent-session.js";
import type { AgentSession } from "./types.js";
import type { AgentManager } from "../managers/agent-manager.js";
import type { ManagedAgent, ManagedAgentConfig } from "../managers/managed-agent.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";

/** Minimal manager surface required by the Local Host (AgentManager satisfies this). */
export interface LocalAgentSessionHostManager extends LocalAgentSessionManager {
  /** Runtime this host's manager belongs to (env scope for session storage). */
  readonly runtime?: AgentRuntime;
  createManagedAgent(config: ManagedAgentConfig, parentId?: string): Promise<ManagedAgent>;
  getAgents(): ManagedAgent[];
  destroyAgent(id: string): void;
  /**
   * Await every in-flight teardown (extension flush/deactivate + the log flush chained
   * after it). Optional so the minimal manager surface stays minimal; when absent, the
   * destroy path simply returns without waiting for the teardown to settle.
   */
  settleTeardowns?(): Promise<void>;
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

/** Default max iterations for the Local AgentSessionHost bootstrap. */
const SESSION_HOST_DEFAULT_MAX_ITERATIONS = 100;

function toManagedConfig(options: AgentSessionCreateOptions): ManagedAgentConfig {
  return {
    name: options.name,
    model: options.model,
    maxIterations: options.maxIterations ?? SESSION_HOST_DEFAULT_MAX_ITERATIONS,
    ...(options.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: options.maxConcurrentTasks } : {}),
    ...(options.modelStyle ? { modelStyle: options.modelStyle } : {}),
    ...(options.modelBaseURL ? { modelBaseURL: options.modelBaseURL } : {}),
    ...(options.modelApiKey ? { modelApiKey: options.modelApiKey } : {}),
    ...(options.modelInfo ? { modelInfo: options.modelInfo } : {}),
    ...(options.providerMode ? { providerMode: options.providerMode } : {}),
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.mcpConfigPath ? { mcpConfigPath: options.mcpConfigPath } : {}),
    ...(options.extensionDirs?.length ? { extensionDirs: options.extensionDirs } : {}),
    ...(options.toolConfig ? { toolConfig: options.toolConfig } : {}),
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
  env: ResolvedCoreEnv
): Promise<string | undefined> {
  if (options.resumeSessionId) return options.resumeSessionId;
  try {
    const store = new SessionStore(env);
    if (options.continueSession) {
      return (await store.getLatest())?.id;
    }
    const empty = await store.getLatestEmpty();
    if (!empty) return undefined;
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
    const targetSessionId = await resolveBootstrapSessionId(options, this.manager.runtime?.env ?? getEnv());
    const managed = await this.manager.createManagedAgent({
      ...toManagedConfig(options),
      ...(targetSessionId ? { initialSessionId: targetSessionId } : {}),
    });
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

    const session = createLocalAgentSession({
      managed,
      manager: this.manager,
    });
    this.sessions.set(session.id, session);

    return { session, ...(initial.length ? { initialMessages: initial } : {}) };
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

  list(): AgentSessionListEntry[] {
    return this.manager.getAgents().map(toListEntry);
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
    // an awaiting caller (CLI exit, `/clear`, tests) is guaranteed the log's final batch is on
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
