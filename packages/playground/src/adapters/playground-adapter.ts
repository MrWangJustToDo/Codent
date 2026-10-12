import { clearAgentStore, createAgentFromConfig } from "@codent/app";
import { CodentAgent } from "@codent/core";

import type { AgentAdapter, AppConfig, ClipboardImageResult, InitResult } from "@codent/app";
import type { AgentSessionHost, CoreEnv, ModelProvider } from "@codent/core";

export class PlaygroundAgentAdapter implements AgentAdapter {
  private host: AgentSessionHost | null = null;
  private agentId: string | null = null;
  private _env: CoreEnv;
  private _provider: ModelProvider | undefined;

  constructor(options: { env: CoreEnv; provider?: ModelProvider }) {
    this._env = options.env;
    this._provider = options.provider;
  }

  async initialize(config: AppConfig): Promise<InitResult> {
    // Session plane: remote HTTP host when configured, else the in-browser
    // local manager running against the WebContainer CoreEnv. Both are held by
    // one CodentAgent so the provider/env planes resolve per runtime.
    const agent = config.remoteSession
      ? await CodentAgent.create({
          env: this._env,
          host: (await import("@codent/server/client")).createRemoteAgentSessionHost({
            baseUrl: config.remoteSession,
          }),
        })
      : await CodentAgent.create({
          env: this._env,
          ...(this._provider ? { provider: this._provider } : {}),
        });
    const result = await createAgentFromConfig({ config, name: "playground-chat", host: agent.host });
    this.host = agent.host;
    this.agentId = result.session.id;
    return result;
  }

  async destroy(): Promise<void> {
    if (this.host && this.agentId) {
      await this.host.destroy(this.agentId);
      this.host = null;
      this.agentId = null;
    }
    clearAgentStore();
  }

  exit(): void {
    void this.destroy().then(() => {
      window.location.reload();
    });
  }

  async readClipboardImage(): Promise<ClipboardImageResult | null> {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return { data: btoa(binary), mediaType: imageType };
      }
      return null;
    } catch {
      return null;
    }
  }
}
