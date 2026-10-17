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
 */

import { createLocalAgentSessionHost } from "../agent-session/local-agent-session-host.js";
import { AgentManager } from "../managers/agent-manager.js";
import { createDirectModelProvider } from "../provider/model-provider.js";

import { AgentRuntime } from "./agent-runtime.js";

import type { AgentRuntimeOptions } from "./agent-runtime.js";
import type { AgentToolConfig } from "../agent/tools/tool-config.js";
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

/** Defaults merged into every {@link CodentAgent.createSession} call. */
export interface CodentAgentDefaults {
  systemPrompt?: string;
  maxIterations?: number;
  maxConcurrentTasks?: number;
  mcpConfigPath?: string;
  extensionDirs?: string[];
  toolConfig?: AgentToolConfig;
}

/**
 * What the runtime knows about models: the pipeline's entries (each with its selectable `models`, style and
 * connection). The **catalog**, not a selection — which model a session runs on belongs to that SESSION
 * (`SessionData.model`, the session snapshot), and "which entry" is per session too; the runtime only
 * supplies the list a session chooses from. `config` is deliberately dropped: hosts have no use for the
 * on-disk config, and it carries credentials.
 */
export type ModelCatalogRead = Pick<LoadedModelsState, "entries">;

export interface CodentAgentOptions {
  /** Workspace runtime (filesystem, shell, fetch). Required. */
  env: CoreEnv;
  /** LLM plane. Omit for `--remote-session` (the agent loop runs server-side). */
  provider?: ModelProvider;
  /** Convenience: build a direct provider from these fields. Ignored when `provider` is set. */
  direct?: { model: string; style?: ModelStyle; baseURL?: string; apiKey?: string };
  /** Human label for the runtime (defaults to the workspace root's basename). */
  name?: string;
  /** Display/log root override (env carries the real root). */
  rootPath?: string;
  /** Defaults merged into every session created by this runtime. */
  defaults?: CodentAgentDefaults;
  /** Advanced/test: inject a manager (must be bound to this runtime's env to isolate). */
  manager?: AgentManager;
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
  private readonly defaults: CodentAgentDefaults;
  private readonly models?: ModelCatalogRead;
  /** Guards {@link dispose} against re-running (double session destroy / env destroy). */
  private disposed = false;

  /** The runtime's session host. */
  readonly host: AgentSessionHost;

  private constructor(
    runtime: AgentRuntime,
    host: AgentSessionHost,
    manager: AgentManager | undefined,
    defaults: CodentAgentDefaults,
    models: ModelCatalogRead | undefined
  ) {
    this.runtime = runtime;
    this.host = host;
    this.manager = manager;
    this.defaults = defaults;
    this.models = models;
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
      ...(options.rootPath ? { rootPath: options.rootPath } : {}),
      ...(options.ownsEnv !== undefined ? { ownsEnv: options.ownsEnv } : {}),
    };
    const runtime = new AgentRuntime(runtimeOptions);
    const manager = options.manager ?? (options.host ? undefined : new AgentManager(runtime));
    const host = options.host ?? createLocalAgentSessionHost({ manager: manager! });
    return new CodentAgent(runtime, host, manager, options.defaults ?? {}, options.models);
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

  /** Create a root session, applying the runtime defaults. */
  createSession(options: AgentSessionCreateOptions): Promise<AgentSessionCreateResult> {
    return this.host.create({ ...this.defaults, ...options });
  }

  /** Bind to a live agent id (root or subagent) of this runtime. */
  getSession(agentId: string): AgentSession | undefined {
    return this.host.connect(agentId) ?? undefined;
  }

  /** List live agents owned by this runtime. */
  async listSessions(): Promise<AgentSessionListEntry[]> {
    return await this.host.list();
  }

  /** Destroy one live agent (cascades to children). */
  async destroySession(agentId: string): Promise<void> {
    await this.host.destroy(agentId);
  }

  /**
   * Destroy every session and release the provider — and the environment only when this
   * runtime owns it ({@link CodentAgentOptions.ownsEnv}). Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const entries = await this.host.list();
    for (const entry of entries) {
      await this.host.destroy(entry.agentId);
    }
    await this.runtime.modelProvider?.destroy?.();
    if (this.runtime.ownsEnv) {
      await this.runtime.env.destroy?.();
    }
  }

  /** @internal The owning manager (local runtimes only). */
  getManager(): AgentManager | undefined {
    return this.manager;
  }
}
