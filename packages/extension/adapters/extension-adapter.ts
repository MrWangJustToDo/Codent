import { clearAgentStore, createAgentFromConfig } from "@codent/app";
import { CodentAgent } from "@codent/core";

import type { AgentAdapter, AppConfig, ClipboardImageResult, InitResult } from "@codent/app";
import type { AgentSessionHost, CoreEnv, ModelProvider } from "@codent/core";

export class ExtensionAgentAdapter implements AgentAdapter {
  private agent: CodentAgent | null = null;
  private host: AgentSessionHost | null = null;
  private agentId: string | null = null;
  private _env: CoreEnv;
  private _provider: ModelProvider | undefined;

  constructor(options: { env: CoreEnv; provider?: ModelProvider }) {
    this._env = options.env;
    this._provider = options.provider;
  }

  async initialize(config: AppConfig): Promise<InitResult> {
    // A re-init (config change) must not orphan the previous runtime — release its
    // local manager before building the next one. `dispose` is only safe/owned here
    // when the runtime is local (see destroy).
    if (this.agent?.getManager()) await this.agent.dispose();

    // Session plane: remote HTTP host when configured, else the in-page local
    // manager (agent loop runs against the registered CoreEnv / provider). Both
    // are held by one CodentAgent so the provider/env planes resolve per runtime.
    this.agent = config.remoteSession
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
    const result = await createAgentFromConfig({ config, name: "extension-chat", host: this.agent.host });
    this.host = this.agent.host;
    this.agentId = result.session.id;
    return result;
  }

  async destroy(): Promise<void> {
    if (this.host && this.agentId) {
      await this.host.destroy(this.agentId);
      this.host = null;
      this.agentId = null;
    }
    // Release the local runtime (manager + provider + command jobs). A remote-session
    // runtime has no manager and its host is the server — disposing it would DELETE
    // every session the server lists, not just ours, so only dispose a local runtime.
    if (this.agent?.getManager()) {
      await this.agent.dispose();
    }
    this.agent = null;
    clearAgentStore();
  }

  exit(): void {
    this.destroy().then(() => {
      try {
        window.close();
      } catch {
        window.location.reload();
      }
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
        for (const byte of bytes) binary += String.fromCharCode(byte);
        const data = btoa(binary);
        return { data, mediaType: imageType };
      }
      return null;
    } catch {
      return null;
    }
  }
}
