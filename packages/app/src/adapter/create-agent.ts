/**
 * Shared agent initialization — binds an {@link AgentSession} into the app.
 *
 * The host process owns session-plane wiring: it constructs the
 * {@link AgentSessionHost} (local via `@codent/core`'s
 * `createLocalAgentSessionHost`, or remote via `@codent/server`'s
 * `createRemoteAgentSessionHost`) and injects it here. CoreEnv / model
 * provider registration likewise happens in the host process before render —
 * this module stays free of core runtime singletons.
 */

import { buildDefaultSystemPrompt, resolveModelConfigFromProvider } from "@codent/core";

import { clearExtensionCommands, syncExtensionCommands } from "../commands";
import { useAgent } from "../hooks/use-agent.js";
import { useConfig } from "../hooks/use-config.js";

import type { AppConfig, InitResult } from "./types.js";
import type { AgentSession, AgentSessionHost } from "@codent/core";

/** Wire the runtime's root AgentSession (+ Host) into the app store. */
export function bindAgentSession(session: AgentSession | null, host?: AgentSessionHost | null): void {
  useAgent.getActions().setSession(session);
  if (host !== undefined) {
    useAgent.getActions().setHost(host);
  }
}

export interface CreateAgentOptions {
  config: AppConfig;
  name: string;
  /**
   * Session plane owner, constructed by the host process (required).
   * Local: `createLocalAgentSessionHost({ manager: agentManager })`.
   * Remote: `createRemoteAgentSessionHost(baseUrl)` (`@codent/server`).
   */
  host: AgentSessionHost;
}

export async function createAgentFromConfig({ config, name, host }: CreateAgentOptions): Promise<InitResult> {
  const { connection, modelInfo, providerMode } = await resolveModelConfigFromProvider(
    {
      model: config.model,
      style: config.style,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      modelInfo: config.modelInfo,
    },
    // Prefer the session host's runtime provider over the process-global registry,
    // so a CodentAgent's LLM keys/baseURL resolve from its own runtime. Remote hosts
    // omit it, falling back to the ambient provider (legacy behavior).
    host.getModelProvider?.()
  );

  if (!connection.model?.trim() && !config.remoteSession) {
    throw new Error(
      "No model configured. Set MODEL / --model, use --remote-provider so the provider server supplies MODEL, " +
        "or use --remote-session so the agent server's provider supplies MODEL."
    );
  }

  useConfig.getActions().updateConfig({
    model: connection.model,
    style: connection.style,
    baseURL: connection.baseURL,
    apiKey: providerMode === "remote" ? "" : connection.apiKey,
    modelInfo,
    providerMode,
  });

  const { session, initialMessages } = await host.create({
    name,
    model: connection.model,
    systemPrompt: config.systemPrompt || (config.remoteSession ? undefined : await buildDefaultSystemPrompt()),
    maxIterations: config.maxIterations,
    mcpConfigPath: config.mcpConfigPath || undefined,
    extensionDirs: config.extensionDirs?.length ? config.extensionDirs : undefined,
    modelStyle: connection.style,
    modelBaseURL: connection.baseURL,
    modelApiKey: connection.apiKey,
    modelInfo,
    providerMode,
    continueSession: config.continueSession || undefined,
    resumeSessionId: config.resumeSession && config.resumeSession !== "__picker__" ? config.resumeSession : undefined,
    // Survives `initConfig` via applyOptionalAppConfig (CLI BRAVE_API_KEY / WEBSEARCH_PROVIDER).
    ...(config.toolConfig ? { toolConfig: config.toolConfig } : {}),
  });

  const snap = session.getSnapshot();
  const initial = initialMessages ?? [];

  // Remote Agent Session without an explicit local model: the agent server
  // resolves the model from its own `.env`. Surface that resolved model so the
  // UI shows the real model name instead of a blank one.
  if (!connection.model?.trim() && snap.model) {
    // Display-only: writing `model` here would flip useAgentChat's effect dep and
    // tear down (DELETE) the remote session we just created via adapter.destroy().
    // Keep it out of the session-rebuild deps (see use-agent-chat effect).
    useConfig.getActions().updateConfig({ serverModel: snap.model });
  }

  // Session binding is the caller's job (`bindAgentSession`), NOT done here.
  // Binding inside this async function races with use-agent-chat's effect rebuild:
  // `updateConfig` above flips the effect deps (config.model/baseURL/...), and the
  // old init's session could overwrite the store unconditionally (no currentInitId
  // guard here). The caller binds after its initId guard, so a stale init's session
  // never enters the store.
  useAgent.getActions().setHost(host);
  syncExtensionCommands(session);

  return { host, session, ...(initial.length ? { initialMessages: initial } : {}) };
}

export function clearAgentStore(): void {
  clearExtensionCommands();
  useAgent.getActions().setHost(null);
  useAgent.getActions().setSession(null);
}
