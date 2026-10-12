/**
 * Local bootstrap for the ACP host — the same model-config pipeline as the CLI's
 * local mode and the IM bridge:
 *
 *  1. CoreEnv plane: local workspace fs/shell (`createNodeEnv`, `SANDBOX_ENV`).
 *  2. Provider plane: `.agents/config/models.json` (via `loadModels`) or `.env`
 *     (MODEL / MODEL_STYLE / BASE_URL / API_KEY), then `registerModelProvider`.
 *  3. Session plane: a `CodentAgent` runtime (own env + provider + manager + host).
 *
 * `cwd` MUST be the workspace root: the local CoreEnv is built from it (`createNodeEnv`),
 * so an ACP client should spawn `codent acp` inside the workspace it wants the agent to see.
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

import type { AcpAgentDefaults, AcpAgentOptions } from "./agent.js";
import type { AgentSessionHost, ModelProvider, ModelStyle } from "@codent/core";

function parseModelStyle(value: string | undefined): ModelStyle | undefined {
  return value === "openai" || value === "anthropic" ? value : undefined;
}

/**
 * Explicit model connection for a directly-configured launch
 * (`codent acp --model … --base-url … --api-key …`). When `model` is set it is
 * authoritative and the on-disk `.agents/config/models.json` is skipped.
 */
export interface AcpModelOverride {
  model?: string;
  style?: ModelStyle;
  baseURL?: string;
  apiKey?: string;
}

export interface LocalAcpBootstrap {
  host: AgentSessionHost;
  defaults: AcpAgentDefaults;
  rootPath: string;
}

/** Register CoreEnv + model provider and return a local host + defaults. */
export async function bootstrapLocalAcp(
  options: { cwd?: string; sandbox?: "local" | "native"; model?: AcpModelOverride } = {}
): Promise<LocalAcpBootstrap> {
  const rootPath = options.cwd ?? process.cwd();
  const sandboxMode = options.sandbox ?? (process.env.SANDBOX_ENV === "native" ? "native" : "local");
  const env = createNodeEnv({ rootPath, sandbox: sandboxMode !== "native" });
  registerCoreEnv(env);

  let provider: ModelProvider | undefined;
  let model: string | undefined;
  let style: ModelStyle | undefined;
  let baseURL: string | undefined;
  let apiKey: string | undefined;
  let modelInfo: AcpAgentDefaults["modelInfo"];

  if (options.model?.model?.trim()) {
    // Explicit CLI override: the flags are authoritative and the on-disk models.json is
    // skipped — same isolation as the TUI's `--model` startup.
    const { connection } = await resolveModelConfig({
      model: options.model.model,
      style: options.model.style,
      baseURL: options.model.baseURL,
      apiKey: options.model.apiKey,
    });
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
  } else {
    try {
      const loaded = await loadModels({ kind: "file" });
      if (loaded) {
        const entry = loaded.entries[loaded.active.entryIndex];
        const activeModel = loaded.active.model ?? entry?.models[0] ?? "";
        if (entry && activeModel) {
          await registerModelProviderForEntry(loaded);
          provider = getModelProvider();
          const fromProvider = await resolveModelConfigFromProvider({}, provider);
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

    if (!model) {
      const { connection } = await resolveModelConfig({
        model: process.env.MODEL ?? process.env.model ?? "",
        style: parseModelStyle(process.env.MODEL_STYLE ?? process.env.STYLE),
        baseURL: process.env.BASE_URL ?? process.env.MODEL_BASE_URL,
        apiKey: process.env.API_KEY ?? "",
      });
      if (connection.model?.trim()) {
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
    }
  }

  if (!model?.trim()) {
    throw new Error(
      "ACP host requires a model — pass --model (with --base-url / --api-key), set `.agents/config/models.json`, or set MODEL/BASE_URL/API_KEY in .env."
    );
  }

  const agent = await CodentAgent.create({ env, ...(provider ? { provider } : {}), ownsEnv: true });

  return {
    host: agent.host,
    rootPath,
    defaults: {
      model,
      ...(style ? { modelStyle: style } : {}),
      ...(baseURL ? { modelBaseURL: baseURL } : {}),
      ...(apiKey ? { modelApiKey: apiKey } : {}),
      ...(modelInfo ? { modelInfo } : {}),
      systemPrompt: await buildDefaultSystemPrompt(),
    },
  };
}

/** Build the full option set by bootstrapping locally. */
export async function bootstrapAcpAgent(
  options: { cwd?: string; sandbox?: "local" | "native"; version?: string; model?: AcpModelOverride } = {}
): Promise<AcpAgentOptions> {
  const boot = await bootstrapLocalAcp(options);
  return {
    host: boot.host,
    defaults: boot.defaults,
    rootPath: boot.rootPath,
    ...(options.version ? { version: options.version } : {}),
  };
}
