/**
 * CodentAgent — an instantiable agent runtime handle.
 *
 * Owns one {@link AgentRuntime} (env + model provider), one `AgentManager` bound to it,
 * and one `AgentSessionHost` (a local host over the manager, or a supplied remote host
 * for `--remote-session`). Create one per isolated runtime; a process may hold many that
 * do not share workspace or LLM state.
 *
 * `createSession` merges the runtime defaults into every session; `dispose` destroys the
 * runtime's sessions and releases the provider and environment.
 *
 * A session UI conventionally binds one live root session per runtime. `AgentManager` (and a
 * server catalog) can hold several roots; that one-root rule is a host/UI convention, not an
 * enforced invariant of the manager.
 */

import { createLocalAgentSessionHost } from "../agent-session/local-agent-session-host.js";
import { AgentManager } from "../managers/agent-manager.js";
import { createDirectModelProvider } from "../provider/model-provider.js";

import { AgentRuntime } from "./agent-runtime.js";

import type { AgentRuntimeOptions } from "./agent-runtime.js";
import type {
  AgentSessionCreateOptions,
  AgentSessionCreateResult,
  AgentSessionHost,
  AgentSessionListEntry,
} from "../agent-session/host-types.js";
import type { AgentSession } from "../agent-session/types.js";
import type { CoreEnv, ResolvedCoreEnv } from "../env";
import type { LoadedModelsState } from "../models/config/models-config.js";
import type { ModelStyle } from "../models/types.js";
import type { ModelProvider } from "../provider/model-provider.js";

/**
 * What the runtime knows about models: the pipeline's entries (each with its selectable `models`, style and
 * connection). The **catalog**, not a selection — which model a session runs on belongs to that SESSION
 * (`SessionData.model`, the session snapshot), and "which entry" is per session too; the runtime only
 * supplies the list a session chooses from. `config` is deliberately dropped: hosts have no use for the
 * on-disk config, and it carries credentials.
 */
export type ModelCatalogRead = Pick<LoadedModelsState, "entries">;

export interface CodentAgentOptions {
  /**
   * Workspace runtime (filesystem, shell, fetch). Required.
   *
   * TODO(core-init): this options type has no `providerMode`. The mode is a MODEL-provider concept,
   * and `CodentAgent.create` accepts `provider` only, so a host that builds the provider itself
   * (every host does) cannot declare "this provider is remote" — the mode travels back out of
   * `provider.getConnection()` and is re-read by `resolveModelConfigFromProvider`. Noted only
   * because the two names read alike: nothing here is inert, and the `mode` on the provider is the
   * single source.
   */
  env: CoreEnv;
  /** LLM plane. Omit for `--remote-session` (the agent loop runs server-side). */
  provider?: ModelProvider;
  /** Convenience: build a direct provider from these fields. Ignored when `provider` is set. */
  // TODO(core-init): unused by every in-repo caller (each passes `provider`). Only
  // `validate:agent-runtime-instances` uses it. Kept as sugar — but note the "ignored when
  // `provider` is set" rule is silent: passing both drops `direct` with no warning.
  direct?: { model: string; style?: ModelStyle; baseURL?: string; apiKey?: string };
  /**
   * Human label for the runtime (defaults to the workspace root's basename).
   *
   * TODO(core-init): no production reader. It lands on `AgentRuntime.name`, whose only consumer is
   * `CodentAgent.getName()` — and no host calls that (only `validate:agent-runtime-instances`).
   * Kept as an embedder label for a process holding several runtimes; nothing logs it today.
   */
  name?: string;
  /** Advanced/test: inject a manager (must be bound to this runtime's env to isolate). */
  manager?: AgentManager;
  /**
   * Whether this runtime owns an **injected** manager's lifecycle (dispose destroys every root
   * agent on it). Default `false` for `options.manager` — the injector keeps ownership — and
   * `true` for the manager this runtime builds itself.
   */
  ownsManager?: boolean;
  /**
   * Whether this runtime owns the **runtime** it runs on (its provider and env) for dispose.
   * Default `false` when a manager is injected (that runtime is borrowed and may be shared), and
   * `true` when this call built the runtime.
   */
  ownsRuntime?: boolean;
  /** `--remote-session`: a remote AgentSessionHost; skips the local manager. */
  host?: AgentSessionHost;
  /**
   * The resolved model **catalog** — the result of ONE `loadModels(...)` call (or a synthesised single-entry
   * read for the flags/`.env` planes). The runtime carries it and never resolves it again, so two sessions
   * cannot disagree about which models exist and no read can re-fetch a provider. The active model/entry is
   * NOT here: it is the session's, and the list is what a session chooses from.
   *
   * Optional: a runtime with no model plane (tests, `--remote-session` handed no list) reports
   * `readModels()` as `undefined` rather than inventing a list.
   */
  models?: ModelCatalogRead;
  /**
   * Whether this runtime owns the env lifecycle (dispose destroys it). Default `false` —
   * pass `true` only when this runtime built a local env; borrowed/remote envs must not be
   * destroyed by dispose (a remote `destroy()` tears down the server's CoreEnv).
   */
  ownsEnv?: boolean;
}

export class CodentAgent {
  private readonly runtime: AgentRuntime;
  private readonly manager?: AgentManager;
  /** Whether {@link dispose} destroys {@link manager}. An injected manager stays its owner's. */
  private readonly ownsManager: boolean;
  /** Whether {@link dispose} destroys the runtime's provider/env. A borrowed runtime's stay. */
  private readonly ownsRuntime: boolean;
  private readonly models?: ModelCatalogRead;
  /** Agent ids this runtime created, and therefore owns for disposal. */
  private readonly ownedSessionIds = new Set<string>();
  /** Guards {@link dispose} against re-running (double session destroy / env destroy). */
  private disposePromise: Promise<void> | undefined;

  /**
   * The runtime's session host.
   *
   * Direct `host.create()` calls are owned by the caller: `dispose()` only destroys
   * ids created through {@link createSession}. Use `createSession()` when this runtime
   * should manage the session lifecycle.
   */
  readonly host: AgentSessionHost;

  private constructor(
    runtime: AgentRuntime,
    host: AgentSessionHost,
    manager: AgentManager | undefined,
    models: ModelCatalogRead | undefined,
    ownsManager: boolean,
    ownsRuntime: boolean
  ) {
    this.runtime = runtime;
    this.host = host;
    this.manager = manager;
    this.models = models;
    this.ownsManager = ownsManager;
    this.ownsRuntime = ownsRuntime;
  }

  /**
   * Build a runtime from its env (+ provider) and a session host.
   *
   * Local/remote-env/remote-provider: owns a manager bound to the runtime.
   * remote-session: pass `host` and no provider (no local manager).
   */
  static async create(options: CodentAgentOptions): Promise<CodentAgent> {
    const provider: ModelProvider | undefined =
      options.provider ?? (options.direct ? createDirectModelProvider(options.direct) : undefined);
    const runtimeOptions: AgentRuntimeOptions = {
      env: options.env,
      ...(provider ? { modelProvider: provider } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.ownsEnv !== undefined ? { ownsEnv: options.ownsEnv } : {}),
      // The catalog travels with the runtime as well as with this handle: agents consult it when
      // they adopt a model they did not choose themselves (resume), and `readModels()` stays the
      // host-facing read of the same value.
      ...(options.models ? { models: options.models } : {}),
    };
    // An injected manager already carries the runtime its agents actually use. Reusing it is the
    // only way `getEnv()` / the provider / the model catalog describe the same workspace as the
    // manager; constructing a second runtime here silently split those two planes.
    if (options.manager?.runtime && options.manager.runtime.env.rootPath !== options.env.rootPath) {
      throw new Error(
        `Injected AgentManager is bound to ${options.manager.runtime.env.rootPath}, not ${options.env.rootPath}.`
      );
    }
    const runtime = options.manager?.runtime ?? new AgentRuntime(runtimeOptions);
    const manager = options.manager ?? (options.host ? undefined : new AgentManager(runtime));
    const host = options.host ?? createLocalAgentSessionHost({ manager: manager! });
    // A manager we built is ours to tear down; an injected one belongs to the injector, and
    // disposing it here would destroy every root agent another runtime is using.
    const ownsManager = options.ownsManager ?? options.manager === undefined;
    const ownsRuntime = options.ownsRuntime ?? options.manager === undefined;
    return new CodentAgent(runtime, host, manager, options.models, ownsManager, ownsRuntime);
  }

  /** The runtime's workspace env (fs/shell/fetch), with defaults resolved. */
  getEnv(): ResolvedCoreEnv {
    return this.runtime.env;
  }

  /** The runtime's display name. */
  getName(): string {
    return this.runtime.name;
  }

  /** The runtime's workspace root. */
  getRootPath(): string {
    return this.runtime.rootPath;
  }

  /** The runtime's model provider (undefined for remote-session runtimes). */
  getModelProvider(): ModelProvider | undefined {
    return this.runtime.modelProvider;
  }

  /**
   * The model catalog this runtime may run: the read it was created with, unchanged (`undefined` when it
   * was created without one). A host projects it instead of deriving an available-model list of its own;
   * the selected entry/model is read from the SESSION, never from here.
   */
  readModels(): ModelCatalogRead | undefined {
    return this.models;
  }

  /**
   * Create a root session through this runtime's host.
   *
   * The options are forwarded as given (the host owns builtins/alias mapping). Unlike a direct
   * {@link host.create}, the returned session is recorded as owned by this runtime and will be
   * destroyed by {@link dispose}.
   */
  async createSession(options: AgentSessionCreateOptions): Promise<AgentSessionCreateResult> {
    const result = await this.host.create(options);
    this.ownedSessionIds.add(result.session.id);
    return result;
  }

  /** Bind to a live agent id (root or subagent) of this runtime. */
  getSession(agentId: string): AgentSession | undefined {
    return this.host.connect(agentId) ?? undefined;
  }

  /**
   * List live agents visible through this runtime's host. Local runtimes return their own
   * agents; a remote-session host returns the SERVER's catalog. Ownership for teardown is
   * tracked separately by {@link ownedSessionIds} (see {@link dispose}).
   */
  async listSessions(): Promise<AgentSessionListEntry[]> {
    return await this.host.list();
  }

  /** Destroy one live agent (cascades to children). */
  async destroySession(agentId: string): Promise<void> {
    await this.host.destroy(agentId);
    this.ownedSessionIds.delete(agentId);
  }

  /**
   * Destroy every session this runtime created and release the provider — and the environment
   * only when this runtime owns it ({@link CodentAgentOptions.ownsEnv}). Idempotent.
   *
   * Deliberately never calls `host.list()`: a remote host's catalog is the SERVER's live agents,
   * not this client's ownership. Enumerating and destroying it would delete other clients'
   * sessions (and the server's own agents) when a remote CLI exits or rebuilds its adapter.
   */
  async dispose(): Promise<void> {
    // Cache the in-flight teardown: a second caller must await the same completion, not observe
    // a half-finished shutdown because `disposed` was set before the first await.
    return (this.disposePromise ??= this.disposeInner());
  }

  private async disposeInner(): Promise<void> {
    const owned = [...this.ownedSessionIds];
    this.ownedSessionIds.clear();
    let firstError: unknown;
    for (const agentId of owned) {
      try {
        await this.host.destroy(agentId);
      } catch (error) {
        firstError ??= error;
      }
    }

    if (this.ownsManager) {
      try {
        // A local runtime owns the manager it built (sessions, log extension and its sinks).
        // Remote-session runtimes have no manager; an INJECTED manager belongs to the injector
        // (`ownsManager`), because disposing it destroys every root agent on it.
        await this.manager?.dispose();
      } catch (error) {
        firstError ??= error;
      }
    }

    if (this.ownsRuntime) {
      try {
        await this.runtime.modelProvider?.destroy?.();
      } catch (error) {
        firstError ??= error;
      }
      if (this.runtime.ownsEnv) {
        try {
          await this.runtime.env.destroy?.();
        } catch (error) {
          firstError ??= error;
        }
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  /** @internal The owning manager (local runtimes only). */
  getManager(): AgentManager | undefined {
    return this.manager;
  }
}
