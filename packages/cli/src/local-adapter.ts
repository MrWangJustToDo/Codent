import { useConfig } from "@codent/app";
import { CodentAgent } from "@codent/core";

import type { AgentAdapter, AppConfig, ClipboardImageResult, InitResult } from "@codent/app";
import type { AgentSessionHost, CoreEnv, LoadedModelsState, ModelProvider } from "@codent/core";

/**
 * Local adapter — shared by the development host (`@codent/cli`) and the
 * self-contained release host (`codent-cli`). Builds the process's
 * {@link CodentAgent} runtime from the host-owned env / provider planes.
 *
 * `--remote-session` binds a remote AgentSession host into the same runtime
 * handle (no local manager). The host factory is injected rather than imported
 * from `@codent/server/client` so this module stays server-free — the release
 * host can inline it without pulling in `@codent/server`.
 */
export class LocalAgentAdapter implements AgentAdapter {
  private agent: CodentAgent | null = null;
  private _exit: (report?: readonly string[]) => void;
  private _readClipboardImage: (() => Promise<ClipboardImageResult | null>) | null;
  private _env: CoreEnv;
  private _provider: ModelProvider | undefined;
  private _ownsEnv: boolean;
  private _createRemoteSessionHost: ((opts: { baseUrl: string }) => AgentSessionHost) | undefined;

  constructor(options: {
    exit: (report?: readonly string[]) => void;
    readClipboardImage?: () => Promise<ClipboardImageResult | null>;
    env: CoreEnv;
    provider?: ModelProvider;
    /** True only for a locally-built env; a borrowed remote env must not be destroyed on exit. */
    ownsEnv?: boolean;
    /** Injected remote AgentSession host factory (`@codent/server/client` in the dev host). */
    createRemoteAgentSessionHost?: (opts: { baseUrl: string }) => AgentSessionHost;
  }) {
    this._exit = options.exit;
    this._readClipboardImage = options.readClipboardImage ?? null;
    this._env = options.env;
    this._provider = options.provider;
    this._ownsEnv = options.ownsEnv ?? false;
    this._createRemoteSessionHost = options.createRemoteAgentSessionHost;
  }

  async initialize(config: AppConfig): Promise<InitResult> {
    const { createAgentSessionFromConfig } = await import("@codent/app");
    // Session-plane wiring is host-process owned: a local manager, or a remote HTTP
    // host when --remote-session is configured (agent loop runs server-side). Both
    // are held by one CodentAgent so the provider/env planes resolve per runtime.
    if (config.remoteSession) {
      if (!this._createRemoteSessionHost) {
        throw new Error(
          "--remote-session is not available in this build (no remote AgentSession host injected). " +
            "Use the development host (@codent/cli) for remote sessions."
        );
      }
      const host = this._createRemoteSessionHost({ baseUrl: config.remoteSession });
      this.agent = await CodentAgent.create({ env: this._env, host });
    } else {
      // The model CATALOG comes from the SAME `loadModels` run the app's config load did (`initConfig` runs
      // before this) — carried onto the runtime so the TUI, `/models` and any ACP host on this process all
      // project one instance-level read instead of re-deriving it. `loaded.active` is NOT part of it: it is
      // the persisted DEFAULT, already applied to `config.model`/style/baseURL/apiKey above; the running
      // session's own model lives on the session.
      const loaded = useConfig.getReadonlyState().modelsConfig as LoadedModelsState | null;
      this.agent = await CodentAgent.create({
        env: this._env,
        ...(this._provider ? { provider: this._provider } : {}),
        ...(loaded ? { models: { entries: loaded.entries } } : {}),
        ...(this._ownsEnv ? { ownsEnv: true } : {}),
      });
    }
    const result = await createAgentSessionFromConfig({ config, name: "local-chat", runtime: this.agent });
    return result;
  }

  async destroy(): Promise<void> {
    // Tear down the runtime's live agent(s) and release its provider/env.
    // `dispose` iterates the host so nothing leaks on exit.
    if (this.agent) {
      await this.agent.dispose();
      this.agent = null;
    }
    const { clearAgentStore } = await import("@codent/app");
    clearAgentStore();
  }

  exit(report?: readonly string[]): void {
    this._exit(report);
  }

  async readClipboardImage(): Promise<ClipboardImageResult | null> {
    if (this._readClipboardImage) {
      return this._readClipboardImage();
    }
    return null;
  }
}
