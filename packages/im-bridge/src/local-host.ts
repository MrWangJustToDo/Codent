/**
 * Local session-plane wiring — in-process {@link AgentSessionHost}, the same
 * bootstrap path as the CLI's local mode:
 *
 * 1. CoreEnv plane: local workspace fs/shell (`createNodeEnv`, SANDBOX_ENV).
 * 2. Provider plane: unified model pipeline — `.agents/config/models.json`
 *    via `loadModels({kind:"file"})` + `registerModelProviderForEntry`, then
 *    `resolveModelConfigFromProvider` for the final connection (same as the
 *    CLI's `createAgentFromConfig`). Falls back to `.env` (MODEL / MODEL_STYLE
 *    / BASE_URL / API_KEY — the field names the server reads) when no usable
 *    models.json exists.
 * 3. Session plane: a `CodentAgent` runtime (own env + provider + manager + host).
 *
 * No `REMOTE_SESSION` ⇒ local mode; the bridge then hosts the agent loop in
 * process instead of talking to an agent server.
 */

import {
  buildDefaultSystemPrompt,
  CodentAgent,
  createDirectModelProvider,
  getModelProvider,
  loadModels,
  registerCoreEnv,
  registerModelProvider,
  registerModelProviderForEntry,
  resolveModelConfig,
  resolveModelConfigFromProvider,
} from "@codent/core";
import { createNodeEnv } from "@codent/node";

import type { BridgeConfig } from "./config.js";
import type { AgentSessionHost, ModelProvider, ModelStyle } from "@codent/core";

function parseModelStyle(value: string | undefined): ModelStyle | undefined {
  return value === "openai" || value === "anthropic" ? value : undefined;
}

/** Same env field names as the server's `readServerModelEnv`. */
function readModelEnv(env: Record<string, string | undefined> = process.env) {
  return {
    model: env.MODEL || env.model || "",
    style: parseModelStyle(env.MODEL_STYLE || env.STYLE),
    baseURL: env.BASE_URL || env.MODEL_BASE_URL || undefined,
    apiKey: env.API_KEY || "",
  };
}

/** Session-create defaults for local mode (remote mode leaves these unset — the server resolves its own). */
export interface LocalSessionDefaults {
  model: string;
  style?: ModelStyle;
  baseURL?: string;
  apiKey?: string;
  modelInfo?: unknown;
  systemPrompt: string;
}

export async function createLocalSessionHost(
  config: BridgeConfig
): Promise<{ host: AgentSessionHost; defaults: LocalSessionDefaults }> {
  // CoreEnv must be registered first — the file pipeline reads models.json
  // through the registered CoreEnv (env.rootPath / env.fs / env.path).
  const env = createNodeEnv({ rootPath: process.cwd(), sandbox: config.sandbox !== "native" });
  registerCoreEnv(env);

  let provider: ModelProvider | undefined;
  let model: string | undefined;
  let style: ModelStyle | undefined;
  let baseURL: string | undefined;
  let apiKey: string | undefined;
  let modelInfo: unknown;

  // 1) `.agents/config/models.json` — unified pipeline, same as the CLI.
  try {
    const loaded = await loadModels({ kind: "file" });
    if (loaded) {
      const entry = loaded.entries[loaded.active.entryIndex];
      const activeModel = loaded.active.model ?? entry?.models[0] ?? "";
      if (entry && activeModel) {
        await registerModelProviderForEntry(loaded);
        provider = getModelProvider();
        // Resolve the final connection through the registered provider (mirrors
        // createAgentFromConfig). IM_BRIDGE_MODEL overrides the active entry.
        const fromProvider = await resolveModelConfigFromProvider(
          config.model ? { model: config.model } : {},
          provider
        );
        model = fromProvider.connection.model;
        style = fromProvider.connection.style;
        baseURL = fromProvider.connection.baseURL;
        apiKey = fromProvider.connection.apiKey;
        modelInfo = fromProvider.modelInfo;
      }
    }
  } catch {
    // Corrupt/unreadable models.json — fall back to `.env`.
  }

  // 2) `.env` fallback when no usable models.json resolved a model.
  if (!model) {
    const envModel = readModelEnv();
    const { connection } = await resolveModelConfig({
      model: config.model || envModel.model,
      style: envModel.style,
      baseURL: envModel.baseURL,
      apiKey: envModel.apiKey,
    });
    if (!connection.model?.trim()) {
      throw new Error(
        "Local mode requires a model — set `.agents/config/models.json` or MODEL (plus BASE_URL / API_KEY) " +
          "in .env / IM_BRIDGE_MODEL, or point REMOTE_SESSION at an agent server."
      );
    }
    provider = createDirectModelProvider({
      model: connection.model,
      style: connection.style,
      baseURL: connection.baseURL,
      apiKey: connection.apiKey,
    });
    registerModelProvider(provider);
    model = connection.model;
    style = connection.style;
    baseURL = connection.baseURL;
    apiKey = connection.apiKey;
    modelInfo = undefined;
  }

  const agent = await CodentAgent.create({ env, ...(provider ? { provider } : {}) });

  return {
    host: agent.host,
    defaults: {
      model,
      style,
      baseURL,
      apiKey,
      modelInfo,
      systemPrompt: await buildDefaultSystemPrompt(),
    },
  };
}
