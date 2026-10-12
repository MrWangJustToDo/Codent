import { CodentAgent } from "@codent/core";

import type { AgentAdapter, AppConfig, ClipboardImageResult, InitResult } from "@codent/app";
import type { CoreEnv, ModelProvider } from "@codent/core";

/**
 * Local adapter. Builds the process's {@link CodentAgent} runtime from the host-owned
 * env / provider planes and drives model resolution through its {@link AgentSessionHost}.
 * `--remote-session` binds a remote host into the same runtime handle (no local manager).
 */
export class LocalAgentAdapter implements AgentAdapter {
  private agent: CodentAgent | null = null;
  private _exit: () => void;
  private _readClipboardImage: (() => Promise<ClipboardImageResult | null>) | null;
  private _env: CoreEnv;
  private _provider: ModelProvider | undefined;

  constructor(options: {
    exit: () => void;
    readClipboardImage?: () => Promise<ClipboardImageResult | null>;
    env: CoreEnv;
    provider?: ModelProvider;
  }) {
    this._exit = options.exit;
    this._readClipboardImage = options.readClipboardImage ?? null;
    this._env = options.env;
    this._provider = options.provider;
  }

  async initialize(config: AppConfig): Promise<InitResult> {
    const { createAgentFromConfig } = await import("@codent/app");
    // Session-plane wiring is host-process owned: a local manager, or a remote HTTP
    // host when --remote-session is configured (agent loop runs server-side). Both
    // are held by one CodentAgent so the provider/env planes resolve per runtime.
    if (config.remoteSession) {
      const host = (await import("@codent/server/client")).createRemoteAgentSessionHost({
        baseUrl: config.remoteSession,
      });
      this.agent = await CodentAgent.create({ env: this._env, host });
    } else {
      this.agent = await CodentAgent.create({
        env: this._env,
        ...(this._provider ? { provider: this._provider } : {}),
      });
    }
    const result = await createAgentFromConfig({ config, name: "local-chat", host: this.agent.host });
    return result;
  }

  async destroy(): Promise<void> {
    // Tear down every live agent owned by this host (the bootstrap session plus
    // any additional sessions created via /session new), then release the runtime's
    // provider/env. `dispose` iterates the host so no live agent leaks on exit.
    if (this.agent) {
      await this.agent.dispose();
      this.agent = null;
    }
    const { clearAgentStore } = await import("@codent/app");
    clearAgentStore();
  }

  exit(): void {
    this._exit();
  }

  async readClipboardImage(): Promise<ClipboardImageResult | null> {
    if (this._readClipboardImage) {
      return this._readClipboardImage();
    }
    return null;
  }
}
