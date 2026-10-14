/**
 * AgentRuntime — one isolated runtime instance.
 *
 * Holds the environment (workspace fs/shell/fetch) and the model provider for a
 * single runtime. Agents, tools, and stores of one runtime resolve their env/provider
 * from it; a process may hold many runtimes (different workspaces / keys / local vs
 * remote) that do not share state. Non-tool code reads `runtime.env` /
 * `runtime.modelProvider`; tools read the run context's `coreEnv`.
 *
 * Internal: `CodentAgent` is the public constructor; the runtime is reached in-repo
 * via `dev.ts` for tests.
 */

import { basename } from "pathe";

import { resolveCoreEnv } from "../env";

import type { CoreEnv, ResolvedCoreEnv } from "../env";
import type { ModelProvider } from "../provider/model-provider.js";

export interface AgentRuntimeOptions {
  /** Workspace runtime (filesystem, shell, fetch, platform). */
  env: CoreEnv;
  /** LLM plane for this runtime. Omitted in remote-session (the agent loop runs server-side). */
  modelProvider?: ModelProvider;
  /** Human label; defaults to the workspace root's basename. */
  name?: string;
  /** Override the workspace root used for display/naming (env carries the real root). */
  rootPath?: string;
  /**
   * Whether this runtime owns the env lifecycle. Default `false`: the host that built the
   * env (a borrowed remote env for `--remote-env` / `--remote-session`, or a host-supplied
   * env) owns it, so `dispose` must not destroy it — a remote env's `destroy()` POSTs a
   * destructive teardown to the server.
   */
  ownsEnv?: boolean;
}

export class AgentRuntime {
  readonly env: ResolvedCoreEnv;
  readonly modelProvider?: ModelProvider;
  readonly name: string;
  readonly rootPath: string;
  /** True when `dispose` may call `env.destroy()`. See {@link AgentRuntimeOptions.ownsEnv}. */
  readonly ownsEnv: boolean;

  constructor(options: AgentRuntimeOptions) {
    // Resolve defaults once so tools read a fully-formed env off the runtime.
    this.env = resolveCoreEnv(options.env);
    this.modelProvider = options.modelProvider;
    this.rootPath = options.rootPath ?? this.env.rootPath;
    this.name = options.name?.trim() || basename(this.rootPath) || "agent";
    this.ownsEnv = options.ownsEnv ?? false;
  }
}
