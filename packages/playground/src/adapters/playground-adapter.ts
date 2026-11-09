import { clearAgentStore, createAgentSessionFromConfig } from "@codent/app";
import { CodentAgent } from "@codent/core";

import type { AgentAdapter, AppConfig, ClipboardImageResult, InitResult } from "@codent/app";
import type { AgentSessionHost, CoreEnv, ModelProvider } from "@codent/core";

export class PlaygroundAgentAdapter implements AgentAdapter {
  private agent: CodentAgent | null = null;
  private host: AgentSessionHost | null = null;
  private agentId: string | null = null;
  /** Monotonic token for `initialize` / `destroy` ordering (same race as the CLI/extension hosts). */
  private initGeneration = 0;
  private _env: CoreEnv;
  private _provider: ModelProvider | undefined;

  constructor(options: { env: CoreEnv; provider?: ModelProvider }) {
    this._env = options.env;
    this._provider = options.provider;
  }

  async initialize(config: AppConfig): Promise<InitResult> {
    const generation = ++this.initGeneration;
    // A re-init (config change) must not orphan the previous runtime — release the server-side agent
    // (remote) or the local manager before building the next one.
    const previous = this.agent;
    const previousHost = this.host;
    const previousAgentId = this.agentId;
    this.agent = null;
    this.host = null;
    this.agentId = null;
    if (previousHost && previousAgentId) {
      await previousHost.destroy(previousAgentId).catch(() => undefined);
    }
    if (previous?.getManager()) await previous.dispose();
    if (generation !== this.initGeneration) throw new Error("Initialization superseded by a newer one");

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
    if (generation !== this.initGeneration) {
      await agent.dispose().catch(() => undefined);
      throw new Error("Initialization superseded by a newer one");
    }
    this.agent = agent;
    const result = await createAgentSessionFromConfig({ config, name: "playground-chat", runtime: agent });
    if (generation !== this.initGeneration) {
      if (this.agent === agent) this.agent = null;
      await agent.dispose().catch(() => undefined);
      throw new Error("Initialization superseded by a newer one");
    }
    this.host = agent.host;
    this.agentId = result.session.id;
    return result;
  }

  async destroy(): Promise<void> {
    this.initGeneration += 1;
    if (this.host && this.agentId) {
      await this.host.destroy(this.agentId);
      this.host = null;
      this.agentId = null;
    }
    // Release the local runtime; a remote-session runtime has no manager and its host
    // is the server, so disposing it would DELETE every session the server lists.
    if (this.agent?.getManager()) {
      await this.agent.dispose();
    }
    this.agent = null;
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
