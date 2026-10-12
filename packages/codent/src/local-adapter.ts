import { CodentAgent } from "@codent/core";

import type { AgentAdapter, AppConfig, ClipboardImageResult, InitResult } from "@codent/app";
import type { CoreEnv, ModelProvider } from "@codent/core";

/**
 * Local-only adapter. The release host has exactly one session plane — the
 * in-process manager inside a {@link CodentAgent} runtime — so there is no
 * `config.remoteSession` branch and therefore no `@codent/server` import.
 */
export class LocalAgentAdapter implements AgentAdapter {
  private agent: CodentAgent | null = null;
  private _exit: () => void;
  private _readClipboardImage: (() => Promise<ClipboardImageResult | null>) | null;
  private _env: CoreEnv;
  private _provider: ModelProvider;

  constructor(options: {
    exit: () => void;
    readClipboardImage?: () => Promise<ClipboardImageResult | null>;
    env: CoreEnv;
    provider: ModelProvider;
  }) {
    this._exit = options.exit;
    this._readClipboardImage = options.readClipboardImage ?? null;
    this._env = options.env;
    this._provider = options.provider;
  }

  async initialize(config: AppConfig): Promise<InitResult> {
    const { createAgentFromConfig } = await import("@codent/app");
    this.agent = await CodentAgent.create({ env: this._env, provider: this._provider, ownsEnv: true });
    const result = await createAgentFromConfig({ config, name: "local-chat", host: this.agent.host });
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
