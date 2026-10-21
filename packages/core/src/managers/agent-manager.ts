import { createAgentEventBus } from "../agent/agent-event-bus";
import { createLogExtension, type LogExtension } from "../agent/log/extension.js";
import { SUBAGENT_ABORT_REASONS } from "../agent/subagent/subagent-stop-reason.js";
import { createSubagentTools } from "../agent/subagent/subagent-tools.js";
import { unregisterStreamingEventBus } from "../agent/tools/util/streaming-callback.js";
import { getEnv, type ResolvedCoreEnv } from "../env";
import { ACTIVE_STATUSES } from "../runtime-types/agent-status.js";
import { errorMessage } from "../utils/errors.js";

import { buildManagedAgent } from "./agent-factory.js";
import { runManagedAgent, runManagedAgentStream, type RunAgentStreamInput } from "./run-agent.js";
import { emitSessionBootstrapEvents } from "./session-bootstrap-events.js";

import type { ManagedAgent, ManagedAgentConfig } from "./managed-agent.js";
import type { AgentEventListener, AgentEventBus, AgentEventType } from "../agent/agent-event-bus";
import type { ResumeResult, SessionData } from "../agent/persistence/types.js";
import type { SkillDirectory } from "../agent/skills/skill-registry.js";
import type { ToolsRecord } from "../agent/tools/runtime/tools-record.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { StreamChunk } from "@tanstack/ai";

export type { AgentEvent, AgentEventListener, AgentEventBus, AgentEventType } from "../agent/agent-event-bus";
export type { ManagedAgent, ManagedAgentConfig } from "./managed-agent.js";
export type { RunAgentStreamInput } from "./run-agent.js";

// ============================================================================
// Types & Schemas
// ============================================================================

/** Environment variable for additional skill directories (comma-separated paths) */
export const SKILL_DIRS_ENV_VAR = "AGENT_SKILL_DIRS";

/**
 * Default skill directories to load, tagged with the source they are attributed to.
 *
 * Load order (first loaded wins for duplicate skill names):
 * 1. Environment variable paths (AGENT_SKILL_DIRS, comma-separated) — `user`
 * 2. User home directory: ~/.agents/skills — `user`
 * 3. Current project directory: .agents/skills — `project`
 *
 * Built-ins are registered **after** these (see `agent-factory.ts`), so they have the
 * lowest priority and a same-named user/project skill always wins.
 *
 * @returns Array of tagged skill directories (absolute or relative)
 */
export async function getDefaultSkillDirs(env?: ResolvedCoreEnv): Promise<SkillDirectory[]> {
  const e = env ?? getEnv();
  const dirs: SkillDirectory[] = [];

  const runEnv = await e.getEnv();

  const envDirs = runEnv[SKILL_DIRS_ENV_VAR];
  if (envDirs) {
    const parsedDirs = envDirs
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    dirs.push(...parsedDirs.map((path) => ({ path, source: "user" as const })));
  }

  const userSkillDir = e.path.join(await e.homedir(), ".agents", "skills");

  dirs.push({ path: userSkillDir, source: "user" });

  dirs.push({ path: ".agents/skills", source: "project" });

  return dirs;
}

// ============================================================================
// AgentManager Class
// ============================================================================

export class AgentManager {
  /** Managed agents by ID */
  private agents: Map<string, ManagedAgent> = new Map();

  /**
   * Runtime this manager belongs to (env + model provider). `undefined` = the ambient
   * runtime (legacy single-instance hosts); agents created here inherit it.
   */
  readonly runtime?: AgentRuntime;

  /**
   * Disk session ownership registry: maps a persisted session id to the live
   * agent id that currently holds (has resumed/owns) it. Because each root
   * agent owns an independent SessionStore, a second live agent would otherwise
   * resume the same disk session with no mutual exclusion. Live ownership is
   * intentionally process-local (not persisted) — a crashed process leaves no
   * stale owner, matching the "live exclusive" semantics.
   */
  private sessionOwners: Map<string, string> = new Map();

  /**
   * Unified event bus root — single source for every agent event. An interceptor
   * that throws is reported to the owning agent's log rather than surfacing as a
   * tool failure (see `DefaultAgentEventBus.intercept`).
   */
  private readonly rootEventBus = createAgentEventBus("root", ({ pattern, event, scopeId, error }) => {
    const message = errorMessage(error);
    // Log on the agent that owns the scope the interceptor was registered on, so
    // the failure lands next to the run it affected. Falls back to any agent with
    // a log (root-scoped interceptors belong to no single agent).
    const owner = this.agents.get(scopeId) ?? [...this.agents.values()].find((agent) => agent.log);
    owner?.log?.warn("hooks", "interceptor threw; continuing without it", { pattern, event, error: message });
  });

  /** Process-wide observer bus (the unified root; events up-flow from agent scopes). */
  private readonly eventBus: AgentEventBus = this.rootEventBus;

  /** Per-agent scoped buses (cached by agent id). */
  private readonly agentBusScopes = new Map<string, AgentEventBus>();

  /**
   * Built-in log extension. It owns log policy (event→entry rules, message formatting, the JSONL
   * sink) while `AgentLog` remains the emission seam.
   */
  private logExtension: LogExtension;

  /**
   * In-flight awaited extension teardowns (`destroyAgent`). Teardown is async
   * (extensions may flush/await on deactivate), but `destroyAgent` keeps a
   * synchronous signature for its callers. The log flush is therefore chained
   * onto this promise so it can never race the teardown, and `settleTeardowns()`
   * lets an ordered shutdown (SessionHost close) wait for the whole sequence.
   */
  private pendingTeardowns = new Set<Promise<void>>();

  constructor(runtime?: AgentRuntime) {
    this.runtime = runtime;
    // The log extension consumes the bus (its policy half) and provides the file sink; agent
    // scopes up-flow to the root, so one subscription covers subagents too.
    this.logExtension = createLogExtension({
      bus: this.eventBus,
      resolveLog: (event) =>
        this.agents.get(event.agentId)?.log ?? (event.parentId ? this.agents.get(event.parentId)?.log : null) ?? null,
    });
    this.logExtension.start();
  }

  /** The root log extension (sink provider + event→entry consumer). */
  getLogExtension(): LogExtension {
    return this.logExtension;
  }

  // ============================================================================
  // Event Emitter
  // ============================================================================

  /**
   * Advanced: subscribe to the process-wide lifecycle bus (cross-agent / `"*"` telemetry).
   * For a single managed agent’s UI wiring, use AgentSession (`lifecycle` channel).
   *
   * @param type - Event type or `"*"` for all events
   * @param listener - Callback function
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * // Process-wide telemetry
   * const unsubscribe = agentManager.on("*", (event) => {
   *   console.log(`Event: ${event.type}`, event.agentId);
   * });
   * unsubscribe();
   * ```
   */
  on(type: AgentEventType | "*", listener: AgentEventListener): () => void {
    return this.eventBus.on(type, listener);
  }

  /**
   * Scoped unified event bus for one agent. Subagents are scoped under their
   * parent, so their events up-flow to the parent and root observers.
   */
  of(agentId: string, parentId?: string): AgentEventBus {
    const cached = this.agentBusScopes.get(agentId);
    if (cached) return cached;
    const parent = parentId ? this.of(parentId) : this.rootEventBus;
    const bus = parent.scope(agentId);
    this.agentBusScopes.set(agentId, bus);
    return bus;
  }

  // ============================================================================
  // Agent Lifecycle
  // ============================================================================

  /**
   * Create a new agent
   */
  /**
   * Create a root agent (`parentId` undefined) or a subagent.
   *
   * `id` is the internal provenance seam: core passes it when IT chose the id (a spawned subagent);
   * hosts cannot reach it, because `ManagedAgentConfig` has no id.
   */
  async createManagedAgent(config: ManagedAgentConfig, parentId?: string, id?: string): Promise<ManagedAgent> {
    const { managed, bootstrap } = await buildManagedAgent({
      config,
      parentId,
      manager: this,
      getDefaultSkillDirs,
      runtime: this.runtime,
      ...(id ? { id } : {}),
    });

    if (this.agents.has(managed.id)) {
      throw new Error(`Agent id already registered: ${managed.id}`);
    }

    this.agents.set(managed.id, managed);
    managed.manager = this;

    if (!parentId && bootstrap) {
      // Attach the JSONL log sink BEFORE bootstrap events so the session
      // timeline includes session:start/doc/skill/memory (persistence-only
      // log — pre-attach entries would be dropped).
      managed.ensureSessionData();
      managed.bindSessionLogSink();
    }

    if (bootstrap) {
      await emitSessionBootstrapEvents(managed, bootstrap);
    }

    if (parentId) {
      const parent = this.agents.get(parentId);
      if (parent) {
        parent.childIds.push(managed.id);
        parent.updatedAt = Date.now();
      }
    }

    return managed;
  }

  /**
   * Spawn a subagent from a parent agent
   */
  /**
   * Spawn a subagent under `parentId`.
   *
   * `subagentId` is the id core assigned to this delegation (`subagent_…`); it is an argument rather
   * than a config field because a host must not be able to choose an agent id — see
   * `ManagedAgentConfig` and the `core-minted agent ids` requirement.
   */
  async spawnSubagent(
    parentId: string,
    config: Partial<ManagedAgentConfig>,
    subagentId?: string
  ): Promise<ManagedAgent> {
    const parent = this.agents.get(parentId);
    if (!parent) {
      throw new Error(`Parent agent not found: ${parentId}`);
    }
    // Inherit the parent's *live* model metadata, not just its stored config:
    // `parent.config` is frozen at construction, while a late models.dev lookup or a
    // `/model` switch updates only `parent.modelInfo` (and its usage pricing). Without
    // this the subagent's own tracker has no pricing and books every call at $0.
    const inheritedModelInfo = config.modelInfo ?? parent.getModelInfo();
    const finalConfig = {
      ...parent.config,
      ...config,
      ...(inheritedModelInfo ? { modelInfo: inheritedModelInfo } : {}),
    };
    const subagent = await this.createManagedAgent(finalConfig, parentId, subagentId);

    const customTools = (config as { subagentTools?: ToolsRecord | null }).subagentTools;
    if (customTools !== undefined) {
      subagent.tools = customTools ?? {};
    } else {
      subagent.tools = createSubagentTools(subagent);
    }
    subagent.invalidateRunner();

    // Subagents share the parent's session log directory but write an
    // independent file ({subagentId}.log) so per-agent entries stay attributable.
    // Bound through the log extension (not `log.attachFileSink`) so the sink is registered for
    // teardown: a subagent has no extension runner, so nothing else would release it.
    const parentLogDir = parent.getLog()?.getFileSinkDir?.();
    const subagentLog = subagent.getLog();
    if (parentLogDir && subagentLog) {
      subagent.setLogSinkDetach(
        this.logExtension.attachSink(subagentLog, {
          dir: parentLogDir,
          filename: `${subagent.id}.log`,
          env: this.runtime?.env,
        })
      );
    }

    return subagent;
  }

  /**
   * Get an agent by ID
   */
  getAgent(id: string): ManagedAgent | undefined {
    return this.agents.get(id);
  }

  /**
   * Get all agents
   */
  getAgents(): ManagedAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get root agents (agents without parent)
   */
  getRootAgents(): ManagedAgent[] {
    return this.getAgents().filter((a) => !a.parentId);
  }

  /**
   * Get subagents of a parent
   */
  getSubagents(parentId: string): ManagedAgent[] {
    const parent = this.agents.get(parentId);
    if (!parent) return [];
    return parent.childIds.map((id) => this.agents.get(id)).filter((a): a is ManagedAgent => a !== undefined);
  }

  /**
   * Recursively collect all *active* subagents under the given root agent.
   *
   * "Active" means the subagent's status indicates it is currently doing work
   * (running / thinking / responding / waiting / compacting). Subagents that
   * have already terminated (idle / completed / aborted / error) are skipped.
   *
   * Results are ordered deepest-first so that the most recently spawned
   * subagent is cancelled first (LIFO), matching the natural call stack.
   *
   * This is used by the app layer to implement layered cancellation:
   * when subagents are active, cancelling targets only the subagents
   * (one by one) and leaves the root agent's abort signal untouched.
   *
   * @param rootAgentId The root agent to search under
   * @returns Active subagents, deepest-first
   */
  getActiveSubagents(rootAgentId: string): ManagedAgent[] {
    return this._collectSubagents(rootAgentId, {
      filter: (managed) => managed.parentId != null && ACTIVE_STATUSES.has(managed.getStatus()),
    });
  }

  /**
   * Recursively collect all subagents (completed and active) under the given
   * root agent, ordered deepest-first.
   *
   * Unlike {@link getActiveSubagents}, this includes subagents that have
   * already terminated (completed, aborted, error, idle). This is useful for
   * the app layer's task panel, which should show the full history of all
   * subagent tasks in the current session.
   *
   * @param rootAgentId The root agent to search under
   * @returns All subagents, deepest-first
   */
  getAllSubagents(rootAgentId: string): ManagedAgent[] {
    return this._collectSubagents(rootAgentId, {
      filter: (managed) => managed.parentId != null,
    });
  }

  /**
   * Shared internal walker that recursively collects subagents under a root
   * agent, applying an optional filter predicate. Results are ordered
   * deepest-first (most recently spawned subagent first).
   */
  private _collectSubagents(
    rootAgentId: string,
    options?: { filter?: (managed: ManagedAgent) => boolean }
  ): ManagedAgent[] {
    const result: ManagedAgent[] = [];
    const seen = new Set<string>();
    const { filter } = options ?? {};

    const walk = (agentId: string) => {
      const managed = this.agents.get(agentId);
      if (!managed) return;
      // Recurse into children first (deepest-first ordering)
      for (const childId of [...managed.childIds].reverse()) {
        walk(childId);
      }
      // Include this node if it passes the filter (or no filter) and is not yet seen
      if ((!filter || filter(managed)) && !seen.has(managed.id)) {
        seen.add(managed.id);
        result.push(managed);
      }
    };

    walk(rootAgentId);
    return result;
  }

  /**
   * Destroy an agent and its subagents
   */
  destroyAgent(id: string): void {
    const managedAgent = this.agents.get(id);
    if (!managedAgent) return;

    unregisterStreamingEventBus(id);
    this.agentBusScopes.delete(id);

    // Release any disk-session ownership this agent held (root agents own one).
    const ownedSessionId = managedAgent.getSessionData?.()?.id;
    if (ownedSessionId) {
      this.releaseSessionOwnership(ownedSessionId, id);
    }

    // Force-kill MCP child processes synchronously to prevent orphans on exit
    managedAgent.getMcpManager()?.forceKill();

    managedAgent.abort(SUBAGENT_ABORT_REASONS.agentDestroyed);

    // Destroy all subagents first
    for (const childId of [...managedAgent.childIds]) {
      this.destroyAgent(childId);
    }

    // Remove from parent's childIds
    if (managedAgent.parentId) {
      const parent = this.agents.get(managedAgent.parentId);
      if (parent) {
        parent.childIds = parent.childIds.filter((cid) => cid !== id);
        parent.updatedAt = Date.now();
      }
      managedAgent.emitEvent(
        "subagent:destroyed",
        { subagentId: id, parentTaskToolCallId: managedAgent.parentTaskId },
        { parentId: managedAgent.parentId }
      );
    }

    // Teardown extensions: emit interceptable session:shutdown first (so extensions can
    // release resources, e.g. kill LSP daemons), then deactivate/destroy all extensions.
    // This fixes a pre-existing leak where extensionRunner.destroyAll() was never called.
    //
    // The flush is chained onto the teardown promise rather than called here: teardown is
    // async, and landing the log sink while a deactivate() flush could still be pending
    // loses the final batch. Chaining also keeps `destroyAgent` synchronous for its
    // subagent/dispose callers while making the order unconditional.
    //
    // ⚠️ The sink must stay bound across the whole chain. `session:shutdown` is how an
    // extension lands its final work through `ctx.logger`, so releasing the binding before
    // the interception runs sends that write into the seam's retained buffer, where nothing
    // can ever drain it — the log file then lags `destroy()` by one entry or more.
    // Release therefore happens exactly once, at the end of the chain (via
    // `flushLogOnDestroy`), never up front.
    const runner = managedAgent.getExtensionRunner();
    const teardown = (async () => {
      if (runner) {
        // Awaited: the shutdown hook is how an extension lands final work, and the
        // teardown below unregisters its interceptor — so it must not still be running.
        await runner.emitSessionShutdown(id);
        await runner.destroyAll();
      }
    })()
      .catch(() => {
        // Teardown failures are reported per phase on the bus; never block the flush below.
      })
      // Kill this agent's background jobs (each agent owns its own registry) so a disposed
      // runtime does not leak child processes; awaited so `settleTeardowns` guarantees it.
      .then(() => managedAgent.destroyBackgroundWork())
      .then(() => {
        // Land the buffered teardown/abort entries before the sink is dropped, so a
        // process exit immediately after destroy does not lose them to the batch timer.
        managedAgent.flushLogOnDestroy();
      });
    this.trackTeardown(teardown);

    this.agents.delete(id);
  }

  /**
   * Acquire exclusive ownership of a persisted disk session for a live agent.
   * Returns `false` (and leaves ownership unchanged) when the session is already
   * held by a *different* live agent. Idempotent for the same agent.
   *
   * The table is `sessionId → agentId`, i.e. many sessions to one agent is representable — what
   * keeps it one-to-one today is the caller releasing the previous session on switch
   * (`session.resume` / `session.new` / teardown). Supporting several live sessions per agent is
   * therefore a change to *that* release, plus moving the conversation state off the agent
   * (`uiChannel` / `sessionData` / todos / plan / approvals / queues) — not a change to this table.
   *
   * Scope: this is per-`AgentManager`, so it guards one process. Two runtimes over the same
   * workspace do not see each other's claims (the store's `reservedAt` only covers reusing an empty
   * session).
   */
  acquireSessionOwnership(sessionId: string, agentId: string): boolean {
    const owner = this.sessionOwners.get(sessionId);
    if (owner !== undefined && owner !== agentId) {
      return false;
    }
    this.sessionOwners.set(sessionId, agentId);
    return true;
  }

  /**
   * Release a disk session's ownership if it was held by the given agent.
   * No-op when the session is owned by another agent or unknown.
   */
  releaseSessionOwnership(sessionId: string, agentId: string): void {
    if (this.sessionOwners.get(sessionId) === agentId) {
      this.sessionOwners.delete(sessionId);
    }
  }

  /**
   * Resume a session by ID. Restores uiMessages, usage, and todos.
   * Returns UIMessages for the client to display.
   */
  async resumeSession(agentId: string, sessionId: string): Promise<ResumeResult> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent not found: ${agentId}`);

    const session = await managed.restoreSession(sessionId);

    return {
      uiMessages: session.uiMessages,
      session: {
        id: session.id,
        name: session.name,
        version: session.version,
        modelStyle: session.modelStyle,
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    };
  }

  /**
   * Continue the most recent session. Returns null if no sessions exist.
   */
  async continueLatestSession(agentId: string): Promise<ResumeResult | null> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent not found: ${agentId}`);

    const store = managed.getSessionStore();
    if (!store) throw new Error("Session store not available");

    const latest = await store.getLatest();
    if (!latest) return null;

    return this.resumeSession(agentId, latest.id);
  }

  /**
   * List all sessions for a given agent's session store.
   */
  async listSessions(agentId: string): Promise<SessionData[]> {
    const managed = this.agents.get(agentId);
    if (!managed) throw new Error(`Agent not found: ${agentId}`);

    const store = managed.getSessionStore();
    if (!store) return [];

    return (await store.list()) as SessionData[];
  }

  /**
   * Lazy streaming entry — an {@link AsyncIterable} of AG-UI chunks for one run.
   * `prepareForRun` runs on the first iteration. Updates {@link ManagedAgent.status}
   * and {@link ManagedAgent.usage} via lifecycle middleware. UI consume / outcome
   * finalization use `runAgentOnce`.
   */
  runAgentStream(agentId: string, input: RunAgentStreamInput): AsyncIterable<StreamChunk> {
    return runManagedAgentStream(this, agentId, input);
  }

  /**
   * Awaiting entry — a promise resolving to the AG-UI chunk stream. Awaiting runs
   * `prepareForRun` eagerly, so setup failures reject here instead of at the first
   * iteration. Same stream as {@link runAgentStream}.
   */
  runAgent(agentId: string, input: RunAgentStreamInput): Promise<AsyncIterable<StreamChunk>> {
    return runManagedAgent(this, agentId, input);
  }

  /**
   * Destroy all agents
   */
  reset(): void {
    // Destroy root agents (which will cascade to subagents)
    for (const agent of this.getRootAgents()) {
      this.destroyAgent(agent.id);
    }
  }

  /**
   * Wait for every in-flight `destroyAgent` teardown (extension flush/deactivate +
   * the log flush chained after it) to settle.
   *
   * Synchronous destroy paths cannot await their own teardown, so an ordered
   * shutdown that must not exit mid-flush awaits this instead — otherwise a buffered
   * final batch can be lost when the process goes down right after closing a session.
   */
  async settleTeardowns(): Promise<void> {
    // `destroyAgent` can enqueue more teardowns while these settle (subagent cascades),
    // so drain until the set stops growing.
    while (this.pendingTeardowns.size > 0) {
      await Promise.allSettled([...this.pendingTeardowns]);
    }
  }

  /** Track a teardown promise so {@link settleTeardowns} can await it. */
  private trackTeardown(promise: Promise<void>): void {
    this.pendingTeardowns.add(promise);
    void promise.finally(() => this.pendingTeardowns.delete(promise));
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

/**
 * Default singleton instance for global use
 */
export const agentManager = new AgentManager();
