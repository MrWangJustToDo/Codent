import { createLogExtension, type LogExtension } from "../agent/log/extension.js";
import { SessionOwnership, sharedSessionOwnership } from "../agent/session/session-ownership.js";
import { getEnv, type ResolvedCoreEnv } from "../env";
import { AGENT_DATA_DIR } from "../utils/workspace-paths.js";

import { AgentEventBusScope } from "./agent-event-bus-scope.js";
import { buildManagedAgent } from "./agent-factory.js";
import { AgentRegistry } from "./agent-registry.js";
import { LifecycleCoordinator } from "./lifecycle-coordinator.js";
import { runManagedAgent, runManagedAgentStream, type RunAgentStreamInput } from "./run-agent.js";
import { emitSessionBootstrapEvents } from "./session-bootstrap-events.js";

import type { ManagedAgent, ManagedAgentConfig } from "./managed-agent.js";
import type { AgentEventListener, AgentEventBus, AgentEventType } from "../agent/agent-event-bus";
import type { AgentLog } from "../agent/agent-log/agent-log.js";
import type { SkillDirectory } from "../agent/skills/skill-registry.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { StreamChunk } from "@tanstack/ai";

export type {
  AgentEvent,
  AgentEventListener,
  AgentEventBus,
  AgentEventPayload,
  AgentEventType,
} from "../agent/agent-event-bus";
export type { ManagedAgent, ManagedAgentConfig } from "./managed-agent.js";
export type { RunAgentStreamInput } from "./run-agent.js";

// ============================================================================
// Types & Schemas
// ============================================================================

/** Environment variable for additional skill directories (comma-separated paths) */
export const SKILL_DIRS_ENV_VAR = "AGENT_SKILL_DIRS";

/**
 * Upper bound on the "wait for an in-flight build" step of `dispose()`.
 *
 * Bootstrap reads workspace files through CoreEnv (agent doc, skill dirs, extension loader) and
 * those reads have no timeout. Waiting without one let a stuck remote read turn `dispose()` — and
 * therefore process exit — into a permanent hang.
 */
const BUILD_WAIT_TIMEOUT_MS = 60_000;

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

  const userSkillDir = e.path.join(await e.homedir(), AGENT_DATA_DIR, "skills");

  dirs.push({ path: userSkillDir, source: "user" });

  dirs.push({ path: `${AGENT_DATA_DIR}/skills`, source: "project" });

  return dirs;
}

// ============================================================================
// AgentManager Class
// ============================================================================

/**
 * Agent registry + lifecycle owner. It supports multiple live roots (the server catalog relies
 * on that); a UI runtime conventionally binds one root, but that is a host convention, not an
 * invariant enforced here.
 */
export class AgentManager {
  /** Live agents + tree queries. */
  private readonly agents = new AgentRegistry();

  /**
   * Runtime this manager belongs to (env + model provider). `undefined` = the ambient runtime
   * (legacy single-instance hosts) until {@link bindRuntime} is called; agents created here inherit
   * it.
   */
  private boundRuntime?: AgentRuntime;

  /** Read-only view of the bound runtime (see {@link bindRuntime}). */
  get runtime(): AgentRuntime | undefined {
    return this.boundRuntime;
  }

  /** Process-local disk-session claims (one live root agent per persisted id, per workspace). */
  private sessionOwnership: SessionOwnership;

  /** Unified root bus + cached per-agent scopes (interceptor error isolation included). */
  private readonly busScope: AgentEventBusScope;

  /**
   * Built-in log extension. It owns log policy (event→entry rules, message formatting, the JSONL
   * sink) while `AgentLog` remains the emission seam.
   */
  private logExtension: LogExtension;

  /** Destroy/teardown cascade (recursive children + async flush chain). */
  private readonly lifecycle: LifecycleCoordinator;
  /**
   * Logs of agents that have LEFT the registry but whose teardown is still running.
   *
   * `destroy()` removes the registry entry synchronously, while `session:shutdown`,
   * extension deactivation, and the final session write are async. Their failures are emitted on
   * the bus and attributed by agent id — a resolver that only reads the registry dropped exactly
   * the diagnostics that explain a bad shutdown.
   */
  private readonly teardownLogs = new Map<string, AgentLog>();
  /**
   * Logs of agents that are still being CONSTRUCTED (bootstrap runs before registration).
   *
   * Symmetric to {@link teardownLogs}, and it exists for the same reason: a `resolveLog` that only
   * reads the registry drops every event emitted between `new ManagedAgent` and `register` — which
   * is when extensions activate, and therefore when their activation failures are reported. Core
   * binds the log here first (see `buildManagedAgent`), and registration hands it to the registry.
   */
  private readonly constructionLogs = new Map<string, AgentLog>();
  /**
   * Envelope identity captured while a log is only retained (construction / teardown).
   *
   * `resolveMeta` cannot consult the registry then: construction runs before registration and
   * teardown deletes the entry synchronously while its async chain still emits. The retained log
   * still receives those rows, so leaving the envelope empty put rows in the right file with no
   * `sessionId` / `runId` — the fields a remote or aggregated reader filters by.
   */
  private readonly retainedMeta = new Map<string, { runId?: string; sessionId?: string }>();
  /**
   * Builds that have started but not returned.
   *
   * `createManagedAgent` reads `this.runtime` when it starts and registers only after an await, so
   * binding a runtime in that window would leave the in-flight agent on the ambient env while the
   * manager reports the bound one. `bindRuntime` refuses while this is non-zero.
   */
  private buildsInFlight = 0;
  /** Resolvers waiting for the last in-flight build to settle (see `disposeInner`). */
  private buildWaiters: Array<() => void> = [];
  /** Guards {@link dispose} against re-running and rejects construction after teardown. */
  private disposed = false;
  /** True only after a teardown COMPLETED; a failed attempt may retry. */
  private tornDown = false;
  /** In-flight teardown shared by concurrent `dispose()` callers. */
  private disposePromise?: Promise<void>;

  constructor(runtime?: AgentRuntime) {
    this.boundRuntime = runtime;
    // A runtime names a workspace, so two managers over the same workspace share one claim table:
    // otherwise both can hold the same session id and interleave their transcript writes. No runtime
    // (legacy ambient manager) keeps a private table — there is no workspace to scope it to.
    this.sessionOwnership = runtime ? sharedSessionOwnership(runtime.env, runtime.sourceEnv) : new SessionOwnership();
    this.busScope = new AgentEventBusScope({
      // Attribute a contained observer/interceptor failure to the agent whose scope registered it.
      // Retained construction/teardown logs keep a scope resolvable before registration and after
      // the registry entry is gone. No fallback: the old `find(first agent with a log)` wrote a
      // root-scoped hook failure into an arbitrary session's file, so in a multi-root host (server,
      // ACP) one conversation's timeline carried an error from another. A scope with no owner is
      // dropped — a missing diagnostic is better than a misattributed one.
      resolveLogOwner: (scopeId) => {
        if (this.agents.get(scopeId)?.log) return scopeId;
        if (this.constructionLogs.get(scopeId)) return scopeId;
        if (this.teardownLogs.get(scopeId)) return scopeId;
        return undefined;
      },
      // Envelope identity is an agent property, not a call-site property: resolve it once for every
      // emitter on the scoped bus (the telemetry funnel, `plan`, `ui`, the extension runner).
      resolveMeta: (agentId) => this.agents.get(agentId)?.getEventContext() ?? this.retainedMeta.get(agentId),
    });
    // The log extension consumes the bus (its policy half) and provides the file sink; agent
    // scopes up-flow to the root, so one subscription covers subagents too.
    this.logExtension = createLogExtension({
      bus: this.busScope.root,
      // Every event is attributed to its owning agent. A child that has already left the registry
      // must NOT fall back to the parent log: late child events would then look like parent
      // content. A construction or retained teardown log keeps the agent's own events attributable
      // while its async work runs (they are dropped once it settles).
      resolveLog: (event) =>
        this.agents.get(event.agentId)?.log ??
        this.constructionLogs.get(event.agentId) ??
        this.teardownLogs.get(event.agentId) ??
        null,
      // A log that cannot be written used to be a `console.error` nobody sees (ACP / remote hosts
      // have no stderr reader) while the agent looked healthy. Attribute it to the owning agent so
      // the fact lands in the session timeline.
      //
      // `session:save-error`, not `session:diagnostic`: the latter has NO session channel, so the
      // only delivery was the log that had just failed — the diagnostic vanished exactly when it
      // mattered (a read-only disk, a full disk, a permanent EIO). `save-error` is the
      // channel-backed shape, and "agent log" is the target that failed.
      onPersistError: (log, info) => {
        const owner = this.agents.all().find((candidate) => candidate.log === log);
        if (owner) {
          owner.emitEvent("session:save-error", {
            target: "agent log",
            error: `${info.error} (stage: ${info.stage}, dropped: ${info.dropped}, consecutive: ${info.consecutiveFailures})`,
          });
          return;
        }
        // Bootstrap/teardown: the agent is not in the registry yet (or no longer), which is exactly
        // why `constructionLogs` / `teardownLogs` exist. Without this branch a read-only or full disk
        // was silent during the phase most likely to explain a broken session.
        const agentId = this.agentIdForLog(log);
        if (!agentId) return;
        const sessionId = this.retainedMeta.get(agentId)?.sessionId;
        this.busScope.root.emit(
          "session:save-error",
          {
            target: "agent log",
            error: `${info.error} (stage: ${info.stage}, dropped: ${info.dropped}, consecutive: ${info.consecutiveFailures})`,
          },
          { agentId, ...(sessionId ? { sessionId } : {}) }
        );
      },
    });
    this.logExtension.start();
    this.lifecycle = new LifecycleCoordinator({
      registry: this.agents,
      // Delegating, not a captured table: `bindRuntime` can replace `sessionOwnership`, and the
      // teardown backstop must release into the table agents are currently claiming from.
      ownership: { releaseAllFor: (id) => this.sessionOwnership.releaseAllFor(id) },
      clearAgentScope: (id) => this.busScope.delete(id),
      retainLog: (id, log, meta) => {
        this.teardownLogs.set(id, log);
        if (meta) this.retainedMeta.set(id, meta);
      },
      releaseLog: (id) => {
        this.teardownLogs.delete(id);
        this.retainedMeta.delete(id);
      },
    });
  }

  /**
   * Bind a runtime to a manager that was constructed without one.
   *
   * A host may inject `new AgentManager()` into `CodentAgent.create({ manager, env, provider })`.
   * Without this binding the manager keeps using the ambient env for every agent it creates while
   * the handle reports its own env/provider/catalog — two planes for one runtime (and in a
   * multi-runtime process, the wrong workspace). `CodentAgent.create` calls this with the runtime it
   * just built, so the manager and the handle describe the same workspace.
   *
   * Refuses to rebind, to run after agents exist, or while an agent build is in flight — each would
   * move live agents between runtime planes mid-flight.
   * @internal
   */
  bindRuntime(runtime: AgentRuntime): void {
    if (this.boundRuntime === runtime) return;
    if (this.disposed) throw new Error("Cannot bind a runtime to a disposed AgentManager.");
    if (this.boundRuntime) {
      throw new Error(
        `AgentManager is already bound to ${this.boundRuntime.env.rootPath}, not ${runtime.env.rootPath}.`
      );
    }
    if (this.agents.all().length > 0) {
      throw new Error("Cannot bind a runtime to an AgentManager that already created agents.");
    }
    if (this.buildsInFlight > 0) {
      throw new Error("Cannot bind a runtime while an agent build is in flight; retry after it settles.");
    }
    this.boundRuntime = runtime;
    this.sessionOwnership = sharedSessionOwnership(runtime.env, runtime.sourceEnv);
  }

  /** The root log extension (sink provider + event→entry consumer). */
  getLogExtension(): LogExtension {
    return this.logExtension;
  }

  /**
   * Live construction bindings.
   *
   * Must return to 0 after registration (handed to the registry), after a failed construction
   * (released by the factory), and after teardown. Exposed for the bootstrap validator: removing the
   * release leaves every other assertion green while the map holds a log (and its sink) forever.
   * @internal
   */
  getConstructionLogCount(): number {
    return this.constructionLogs.size;
  }

  /**
   * Tear down every live agent, wait for their async extension/log teardown, then
   * dispose the root log extension (which detaches the sinks and process-exit hook).
   * Idempotent; a disposed manager cannot create new agents.
   */
  async dispose(): Promise<void> {
    // Cache the in-flight teardown: a second caller must await the same completion, not observe a
    // half-finished shutdown because `disposed` was set before the first await. A FAILED teardown
    // drops the cache so a retry can finish whatever is still owned.
    if (!this.disposePromise) {
      const attempt = this.disposeInner();
      this.disposePromise = attempt;
      void attempt.catch(() => {
        if (this.disposePromise === attempt) this.disposePromise = undefined;
      });
    }
    return this.disposePromise;
  }

  private async disposeInner(): Promise<void> {
    if (this.tornDown) return;
    this.disposed = true;
    // A build in flight (extension activation, MCP connect) may still hold child processes and
    // isolate handles. Waiting for it means `dispose()` resolving really means "nothing is left",
    // instead of leaving cleanup to a microtask the host may never reach before process.exit.
    if (this.buildsInFlight > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, BUILD_WAIT_TIMEOUT_MS);
        // A disposed host is trying to exit: the bound must not keep the loop alive on its own.
        // Cast: core compiles with DOM lib where `setTimeout` returns `number`.
        (timer as { unref?: () => void }).unref?.();
        // A build that does finish clears the timer; a timeout leaves the waiter in place, and a
        // second `resolve` is a no-op.
        this.buildWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    // Each stage runs even when an earlier one throws. A stage that FAILS leaves the manager
    // retryable: `dispose()` drops the cached promise on rejection, and `tornDown` stays false so
    // the next call re-runs the (idempotent) stages instead of reporting success over leaked work.
    // The old nested `finally` set `tornDown` unconditionally, which made the documented retry a
    // no-op after the first partial failure.
    let firstError: unknown;
    const stage = async (fn: () => void | Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        firstError ??= error;
      }
    };
    await stage(() => this.lifecycle.reset());
    await stage(() => this.lifecycle.settleTeardowns());
    await stage(() => this.logExtension.dispose());
    await stage(() => this.busScope.dispose());
    if (firstError !== undefined) throw firstError;
    // A build that exceeded BUILD_WAIT_TIMEOUT_MS may still hold a construction binding (log +
    // retained envelope identity). The maps are only cleared on a COMPLETE teardown: a failed
    // dispose is retryable, and until then `agentIdForLog` must still be able to attribute a
    // persist failure to the half-torn-down agent.
    this.constructionLogs.clear();
    this.retainedMeta.clear();
    this.teardownLogs.clear();
    this.tornDown = true;
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

  /**
   * Release a scope minted for an agent that never finished construction. Registered
   * agents release their scope through {@link LifecycleCoordinator.destroy}.
   * @internal
   */
  releaseAgentScope(agentId: string): void {
    this.busScope.delete(agentId);
  }

  /**
   * Bind an agent's log before it is registered, so bootstrap events resolve to it.
   *
   * Call order is the contract: `buildManagedAgent` creates the agent + log, binds here, and only
   * then runs bootstrap (extensions, MCP, memory). Registration removes the binding.
   * @internal
   */
  bindConstructionLog(agentId: string, log: AgentLog, meta?: { runId?: string; sessionId?: string }): void {
    this.constructionLogs.set(agentId, log);
    if (meta) this.retainedMeta.set(agentId, meta);
  }

  /**
   * Drop a construction-time log binding (registration or a failed build). @internal
   *
   * `log` makes it identity-checked: a FAILED build can carry the same id as a healthy registered
   * agent (a duplicate-id error), and only the binding that failed may be released. Without the
   * check the caller had to guard on `!agents.has(id)`, which skipped the release for the failed
   * build itself — leaking its log and making `resolveLog` serve a detached sink to the healthy
   * agent's later teardown events.
   */
  releaseConstructionLog(agentId: string, log?: AgentLog): void {
    if (log !== undefined && this.constructionLogs.get(agentId) !== log) return;
    this.constructionLogs.delete(agentId);
    this.retainedMeta.delete(agentId);
  }

  /**
   * Reverse-resolve a log to its owning agent id.
   *
   * The persist-error path needs "whose log failed", and during bootstrap/teardown the agent is
   * absent from the registry. This reads the same three tables `resolveLog` reads, in the same order.
   */
  private agentIdForLog(log: AgentLog): string | undefined {
    for (const agent of this.agents.all()) {
      if (agent.log === log) return agent.id;
    }
    for (const [agentId, candidate] of this.constructionLogs) {
      if (candidate === log) return agentId;
    }
    for (const [agentId, candidate] of this.teardownLogs) {
      if (candidate === log) return agentId;
    }
    return undefined;
  }

  // ============================================================================
  // Agent Lifecycle
  // ============================================================================

  /**
   * Create a root agent (`parentId` undefined) or a subagent.
   *
   * `id` is the internal provenance seam: core passes it when IT chose the id (a spawned subagent);
   * hosts cannot reach it, because `ManagedAgentConfig` has no id.
   */
  async createManagedAgent(
    config: ManagedAgentConfig,
    parentId?: string,
    id?: string,
    options: { deferBootstrapEvents?: boolean } = {}
  ): Promise<ManagedAgent> {
    if (this.disposed) throw new Error("AgentManager has been disposed");
    if (parentId) {
      const parent = this.agents.get(parentId);
      if (!parent) throw new Error(`Parent agent not found: ${parentId}`);
      if (parent.parentId) throw new Error("Subagents cannot spawn subagents");
    }
    let managed: ManagedAgent | undefined;
    // Whether THIS build reached the registry. `agents.has(managed.id)` cannot answer it: on a
    // duplicate id it is true for the OLD agent, so the catch used to destroy a healthy agent and
    // leak the half-built one (no dispose, no log/scope release).
    let registered = false;
    this.buildsInFlight += 1;
    try {
      const built = await buildManagedAgent({
        config,
        parentId,
        manager: this,
        getDefaultSkillDirs,
        runtime: this.runtime,
        ...(id ? { id } : {}),
      });
      managed = built.managed;
      const { bootstrap } = built;

      // A build can await extension activation and MCP connects; the parent may be torn down in
      // that window (session switch / Esc cascade). `linkChild` silently ignores a missing parent,
      // which left the child registered with a dead `parentId`: neither a root (`roots()` filters
      // it out) nor reachable through `parent.childIds`, so nothing would ever destroy it.
      if (parentId && !this.agents.get(parentId)) {
        throw new Error(`Parent agent "${parentId}" was destroyed while building this agent`);
      }

      // A build can await extension activation and MCP connects; a concurrent `dispose()` may have
      // run in that window. Registering now would leave a live agent (and its child processes) in
      // a registry nothing will ever tear down. The catch below disposes it.
      if (this.disposed) throw new Error("AgentManager has been disposed");

      this.agents.register(managed);
      registered = true;
      managed.manager = this;
      // The registry now resolves this agent, so the construction-time binding has done its job.
      // Dropping it here keeps one owner per log (registry → teardown), never two.
      this.releaseConstructionLog(managed.id, managed.log);

      if (bootstrap) {
        // The JSONL sink is already bound by `agent-factory.ts` (`bindLogSink`, before
        // `bootstrapRoot`), so the session timeline includes session:start/doc/skill/memory. This
        // call only guarantees the session DATA exists; it attaches no sink.
        managed.ensureSessionData();
        // A live root agent holds the disk session it is running from the start, not only after a
        // resume. Without this, a fresh session was invisible to the ownership table (and became
        // resumable by another live agent once it hit disk). `restoreSession` re-acquires the same
        // id idempotently when bootstrap resumed one.
        const activeSessionId = managed.getSessionData()?.id;
        if (
          activeSessionId &&
          !managed.sessionLease.claim(activeSessionId, {
            reserved: managed.config.initialSessionReserved === true,
          })
        ) {
          // The target is already held by another live agent. The catch below tears down the
          // half-built agent so it cannot appear in the catalog or share the target's log sink.
          throw new Error(
            `Session "${activeSessionId}" is already active in another live session and cannot be created here.`
          );
        }
        if (activeSessionId) managed.sessionLease.commit();
      }

      if (bootstrap) {
        if (options.deferBootstrapEvents) {
          // Local hosts restore the transcript and initialize chat after this method
          // returns. Emitting session:start first made extension handlers see an empty
          // transcript and a half-initialized chat controller.
          managed.setBootstrapEvents(() => emitSessionBootstrapEvents(managed!, bootstrap));
        } else {
          await emitSessionBootstrapEvents(managed, bootstrap);
        }
      }

      if (parentId) this.agents.linkChild(parentId, managed.id);

      return managed;
    } catch (error) {
      // A lease claim may have been made above; release its ownership/reservation before the
      // half-built agent is torn down (the teardown path only releases ownership).
      managed?.sessionLease.release();
      if (managed) {
        if (registered) {
          this.lifecycle.destroy(managed.id);
          await this.lifecycle.settleTeardowns();
        } else {
          await managed.disposeBuiltResources();
          // Release only what THIS build created. The `registered` flag already keeps `destroy`
          // away from a healthy agent with the same id; the scope/log release needs the same guard,
          // because `busScope.of(id)` returns the LIVE agent's cached scope for that id — deleting
          // it by id would silently cut off a healthy agent's session projection and subagent
          // up-flow while the registry still looked complete.
          // The construction binding belongs to THIS build: a healthy agent with the same id
          // released its own at registration, so releasing identity-checked is always safe.
          this.releaseConstructionLog(managed.id, managed.log);
          // The bus scope, by contrast, may be the LIVE agent's (`busScope.of(id)` returns its
          // cached node), so it is only released when this build is not that agent.
          if (!this.agents.has(managed.id)) this.releaseAgentScope(managed.id);
        }
      }
      throw error;
    } finally {
      this.buildsInFlight -= 1;
      if (this.buildsInFlight === 0 && this.buildWaiters.length > 0) {
        const waiters = this.buildWaiters;
        this.buildWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

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
    // Session-scoped task rows: a completed `autoDestroy:false` child from an earlier
    // conversation must not appear after the root switches sessions.
    subagent.setSessionScopeId(parent.getSessionData()?.id);

    // A per-spawn override wins; otherwise the root agent's configured default applies. `null`
    // remains an explicit "clear all tools" value, so use hasOwn rather than `??`.
    const customTools = Object.prototype.hasOwnProperty.call(config, "subagentTools")
      ? config.subagentTools
      : parent.config.subagentTools;
    // The factory already built the default read-only subagent set; only an override needs to
    // replace it here.
    if (customTools !== undefined) {
      // Replace the record AND rebuild the registry from it. Assigning the field alone left the
      // registry resolving the factory's explore toolset while the runner executed this one.
      // A subagent never loads extensions (`bootstrapRoot` runs for roots only), so there are no
      // owner claims for `useTools` to refuse.
      subagent.tools = customTools ?? {};
      subagent.toolService.useTools(subagent.tools);
      subagent.invalidateRunner();
    }

    // Subagents share the root's workspace timeline; `buildManagedAgent` binds the same shared
    // sink, so every entry (root or child) lands in `.agents/logs/agent.log` with its own scope.

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
   * already terminated (completed, aborted, error, idle).
   *
   * `sessionId` scopes the result to the current conversation. A session
   * switch aborts `autoDestroy: false` task children but does not destroy them,
   * so an unfiltered walk would still expose their command buffers to the next
   * conversation. Omit it only for a deliberately cross-session inspection.
   *
   * @param rootAgentId The root agent to search under
   * @param sessionId Current disk session id; legacy unscoped children remain included
   * @returns All subagents, deepest-first
   */
  getAllSubagents(rootAgentId: string, sessionId?: string): ManagedAgent[] {
    return this.agents.allSubagents(rootAgentId, sessionId);
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
   * Scope: a manager bound to a runtime shares the table with every other manager over the same
   * workspace (a local env by root path, a remote env per client connection — see
   * `sharedSessionOwnership`). Two runtimes over the same workspace must not both write one
   * session's transcript, so they see each other's claims. Only a legacy manager constructed
   * without a runtime keeps a private table.
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
   * The agent holding `sessionId` in the shared ownership table, or undefined.
   *
   * Exposed so the session host reads the SAME table the manager claims into. Recomputing
   * `sharedSessionOwnership(env)` from a resolved env copy is a different table for a remote env
   * (`sourceEnv` identity), which made the delete guard inert exactly where it was needed.
   */
  getSessionOwner(sessionId: string): string | undefined {
    return this.sessionOwnership.ownerOf(sessionId);
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
