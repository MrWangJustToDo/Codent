import { createLogExtension, type LogExtension } from "../agent/log/extension.js";
import { getEnv, type ResolvedCoreEnv } from "../env";

import { AgentEventBusScope } from "./agent-event-bus-scope.js";
import { buildManagedAgent } from "./agent-factory.js";
import { AgentRegistry } from "./agent-registry.js";
import { LifecycleCoordinator } from "./lifecycle-coordinator.js";
import { runManagedAgent, runManagedAgentStream, type RunAgentStreamInput } from "./run-agent.js";
import { emitSessionBootstrapEvents } from "./session-bootstrap-events.js";
import { SessionOwnership } from "./session-ownership.js";

import type { ManagedAgent, ManagedAgentConfig } from "./managed-agent.js";
import type { AgentEventListener, AgentEventBus, AgentEventType } from "../agent/agent-event-bus";
import type { SkillDirectory } from "../agent/skills/skill-registry.js";
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
  /** Live agents + tree queries. */
  private readonly agents = new AgentRegistry();

  /**
   * Runtime this manager belongs to (env + model provider). `undefined` = the ambient
   * runtime (legacy single-instance hosts); agents created here inherit it.
   */
  readonly runtime?: AgentRuntime;

  /** Process-local disk-session claims (one live root agent per persisted id). */
  private readonly sessionOwnership = new SessionOwnership();

  /** Unified root bus + cached per-agent scopes (interceptor error isolation included). */
  private readonly busScope: AgentEventBusScope;

  /**
   * Built-in log extension. It owns log policy (event→entry rules, message formatting, the JSONL
   * sink) while `AgentLog` remains the emission seam.
   */
  private logExtension: LogExtension;

  /** Destroy/teardown cascade (recursive children + async flush chain). */
  private readonly lifecycle: LifecycleCoordinator;

  constructor(runtime?: AgentRuntime) {
    this.runtime = runtime;
    this.busScope = new AgentEventBusScope({
      // Log on the agent that owns the scope the interceptor was registered on; root-scoped
      // interceptors fall back to any agent with a log.
      resolveLog: (scopeId) =>
        this.agents.get(scopeId)?.log ?? [...this.agents.values()].find((agent) => agent.log)?.log,
    });
    // The log extension consumes the bus (its policy half) and provides the file sink; agent
    // scopes up-flow to the root, so one subscription covers subagents too.
    this.logExtension = createLogExtension({
      bus: this.busScope.root,
      // Every event is attributed to its owning agent. A child that has already left the registry
      // must NOT fall back to the parent sink: late child events would then look like parent
      // content and violate the index-only contract. The parent index is written explicitly by
      // `logSubagentLifecycle`.
      resolveLog: (event) => this.agents.get(event.agentId)?.log ?? null,
    });
    this.logExtension.start();
    this.lifecycle = new LifecycleCoordinator({
      registry: this.agents,
      ownership: this.sessionOwnership,
      clearAgentScope: (id) => this.busScope.delete(id),
    });
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
    return this.busScope.on(type, listener);
  }

  /**
   * Scoped unified event bus for one agent. Subagents are scoped under their
   * parent, so their events up-flow to the parent and root observers.
   */
  of(agentId: string, parentId?: string): AgentEventBus {
    return this.busScope.of(agentId, parentId);
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
    if (parentId) {
      const parent = this.agents.get(parentId);
      if (!parent) throw new Error(`Parent agent not found: ${parentId}`);
      if (parent.parentId) throw new Error("Subagents cannot spawn subagents");
    }
    const { managed, bootstrap } = await buildManagedAgent({
      config,
      parentId,
      manager: this,
      getDefaultSkillDirs,
      runtime: this.runtime,
      ...(id ? { id } : {}),
    });

    this.agents.register(managed);
    managed.manager = this;

    if (bootstrap) {
      // Attach the JSONL log sink BEFORE bootstrap events so the session
      // timeline includes session:start/doc/skill/memory (persistence-only
      // log — pre-attach entries would be dropped).
      managed.ensureSessionData();
      // A live root agent holds the disk session it is running from the start, not only after a
      // resume. Without this, a fresh session was invisible to the ownership table (and became
      // resumable by another live agent once it hit disk). `restoreSession` re-acquires the same
      // id idempotently when bootstrap resumed one.
      const activeSessionId = managed.getSessionData()?.id;
      if (activeSessionId && !this.acquireSessionOwnership(activeSessionId, managed.id)) {
        // The target is already held by another live agent. Tear down the half-built agent before
        // throwing so it cannot appear in the catalog or share the target's log sink.
        this.lifecycle.destroy(managed.id);
        throw new Error(
          `Session "${activeSessionId}" is already active in another live session and cannot be created here.`
        );
      }
      managed.bindSessionLogSink();
    }

    if (bootstrap) {
      await emitSessionBootstrapEvents(managed, bootstrap);
    }

    if (parentId) this.agents.linkChild(parentId, managed.id);

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
    if (parent.parentId) {
      // The task tool is excluded from child toolsets, but a caller can still reach the manager
      // directly. Keep the supported depth at one child level.
      throw new Error("Subagents cannot spawn subagents");
    }
    // Inherit the parent's *live* model metadata, not just its stored config:
    // `parent.config` is frozen at construction, while a late models.dev lookup or a
    // `/model` switch updates only `parent.modelInfo` (and its usage pricing). Without
    // this the subagent's own tracker has no pricing and books every call at $0.
    const inheritedModelInfo = config.modelInfo ?? parent.getModelInfo();
    const finalConfig = {
      ...parent.config,
      ...config,
      // A child never inherits the parent's toolset. It defaults to explore, or uses the
      // caller's explicit toolset/profile id (internal one-shot workers).
      profileId: config.profileId ?? "explore",
      toolsetProfile: config.toolsetProfile ?? config.profileId ?? "explore",
      ...(inheritedModelInfo ? { modelInfo: inheritedModelInfo } : {}),
    };
    const subagent = await this.createManagedAgent(finalConfig, parentId, subagentId);

    // A per-spawn override wins; otherwise the root agent's configured default applies. `null`
    // remains an explicit "clear all tools" value, so use hasOwn rather than `??`.
    const customTools = Object.prototype.hasOwnProperty.call(config, "subagentTools")
      ? config.subagentTools
      : parent.config.subagentTools;
    // The factory already built the default read-only subagent set; only an override needs to
    // replace it here.
    if (customTools !== undefined) {
      subagent.tools = customTools ?? {};
      subagent.invalidateRunner();
    }

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
    return this.agents.all();
  }

  /**
   * Get root agents (agents without parent)
   */
  getRootAgents(): ManagedAgent[] {
    return this.agents.roots();
  }

  /**
   * Get subagents of a parent
   */
  getSubagents(parentId: string): ManagedAgent[] {
    return this.agents.subagents(parentId);
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
    return this.agents.activeSubagents(rootAgentId);
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
    return this.agents.allSubagents(rootAgentId);
  }

  /**
   * Destroy an agent and its subagents.
   */
  destroyAgent(id: string): void {
    this.lifecycle.destroy(id);
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
    return this.sessionOwnership.acquire(sessionId, agentId);
  }

  /**
   * Release a disk session's ownership if it was held by the given agent.
   * No-op when the session is owned by another agent or unknown.
   */
  releaseSessionOwnership(sessionId: string, agentId: string): void {
    this.sessionOwnership.release(sessionId, agentId);
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
   * Destroy all root agents (and therefore their subagents).
   */
  reset(): void {
    this.lifecycle.reset();
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
    await this.lifecycle.settleTeardowns();
  }

  /** @internal Test seam for the growable-teardown contract. */
  trackTeardown(promise: Promise<void>): void {
    this.lifecycle.trackTeardown(promise);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

/**
 * Default singleton instance for global use
 */
export const agentManager = new AgentManager();
