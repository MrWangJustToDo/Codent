/**
 * Shared session bootstrap — binds the runtime's root {@link AgentSession} into the app.
 *
 * The host process owns the runtime: it builds a `CodentAgent` (which carries the CoreEnv
 * and model provider) and passes that runtime's `host` here. This module only turns the
 * resolved config into the root session and wires it into the app store — it creates no
 * agent itself and reads no core runtime singleton.
 *
 * Extension slash commands are deliberately NOT synced here: they are a UI-layer concern
 * and are kept current by `useAgentChat`'s session subscription (the `extensions` channel).
 */

import { buildDefaultSystemPrompt, resolveModelConfigFromProvider } from "@codent/core";

import { useAgent } from "../hooks/use-agent.js";
import { useConfig } from "../hooks/use-config.js";

import type { AppConfig, InitResult } from "./types.js";
import type {
  AgentSession,
  AgentSessionCreateOptions,
  AgentSessionCreateResult,
  AgentSessionHost,
  CoreEnv,
  ModelCatalogRead,
  ModelProvider,
} from "@codent/core";

/**
 * The minimal runtime surface the bootstrap needs to create + bind the root session.
 *
 * Structurally satisfied by `CodentAgent`, so the UI stays decoupled from the runtime class
 * while session creation still goes through the runtime's `createSession` — applying the
 * runtime's defaults instead of the raw host.
 */
export interface AgentRuntimePort {
  /** The runtime's session host (bound into the app store). */
  readonly host: AgentSessionHost;
  /** Create a root session, applying the runtime's defaults. */
  createSession(options: AgentSessionCreateOptions): Promise<AgentSessionCreateResult>;
  /** The runtime's workspace env (default system prompt). */
  getEnv(): CoreEnv;
  /** The runtime's model provider, or `undefined` (remote-session / no local provider). */
  getModelProvider(): ModelProvider | undefined;
  /**
   * The models this runtime may run — the read it was created with (one `loadModels` result). Optional so a
   * host that cannot supply it keeps its previous behaviour instead of inventing a list; when present it is
   * the ONLY source for model lists (`/models`, the selector), so no second pipeline runs.
   */
  readModels?(): ModelCatalogRead | undefined;
}

/** Wire the runtime's root AgentSession (+ Host) into the app store. */
export function bindAgentSession(session: AgentSession | null, host?: AgentSessionHost | null): void {
  useAgent.getActions().setSession(session);
  if (host !== undefined) {
    useAgent.getActions().setHost(host);
  }
}

export interface CreateAgentSessionOptions {
  config: AppConfig;
  name: string;
  /**
   * The owning runtime (required) — `CodentAgent` satisfies {@link AgentRuntimePort}. Built
   * by the host process (a local runtime, or one wrapping a remote
   * `createRemoteAgentSessionHost(baseUrl)`); the app never constructs it.
   */
  runtime: AgentRuntimePort;
}

export async function createAgentSessionFromConfig({
  config,
  name,
  runtime,
}: CreateAgentSessionOptions): Promise<InitResult> {
  const { connection, modelInfo, providerMode } = await resolveModelConfigFromProvider(
    {
      model: config.model,
      style: config.style,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      modelInfo: config.modelInfo,
    },
    // The runtime's provider — so a CodentAgent's LLM keys/baseURL resolve from its own
    // runtime (remote-session / no-provider runtimes leave ambient resolution).
    runtime.getModelProvider()
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

  const { session, initialMessages } = await runtime.createSession({
    name,
    model: connection.model,
    systemPrompt:
      config.systemPrompt ||
      (config.remoteSession ? undefined : await buildDefaultSystemPrompt(undefined, runtime.getEnv())),
    maxIterations: config.maxIterations,
    // Optional: pass only when set, so the runtime/agent default (4) applies otherwise.
    ...(config.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: config.maxConcurrentTasks } : {}),
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
  useAgent.getActions().setHost(runtime.host);

  return { host: runtime.host, session, ...(initial.length ? { initialMessages: initial } : {}) };
}

export function clearAgentStore(): void {
  useAgent.getActions().setHost(null);
  useAgent.getActions().setSession(null);
}
