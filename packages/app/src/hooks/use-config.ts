import {
  DEFAULT_AGENT_MAX_ITERATIONS,
  DEFAULT_LOCAL_OPENAI_BASE_URL,
  buildDefaultSystemPrompt,
  loadModels,
  mergeModelsConfigToolConfig,
  registerModelProviderForEntry,
  type LoadedModelEntry,
  type LoadedModelsState,
  type ModelStyle,
} from "@codent/core";
import { createState } from "reactivity-store";

import { applyOptionalAppConfig, clearOptionalAppConfig } from "../utils/apply-app-config.js";

import type { AppConfig } from "../adapter/types.js";

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_STYLE: ModelStyle = "openai";

// ============================================================================
// State Hook
// ============================================================================

export const useConfig = createState(
  () => ({
    config: {
      model: "",
      style: DEFAULT_STYLE,
      baseURL: DEFAULT_LOCAL_OPENAI_BASE_URL,
      systemPrompt: "",
      initialPrompt: "",
      maxIterations: DEFAULT_AGENT_MAX_ITERATIONS,
      apiKey: "",
      mcpConfigPath: "",
      extensionDirs: [],
      continueSession: false,
      resumeSession: "",
    } as AppConfig,
    initialized: false,
    helpRequested: false,
    key: "",
    /** Loaded model config (entries + active) after the unified pipeline runs. */
    modelsConfig: null as LoadedModelsState | null,
  }),
  {
    withActions: (state) => ({
      init: async (config: Partial<AppConfig>) => {
        state.config.model = config.model || "";
        state.config.style = config.style || DEFAULT_STYLE;
        state.config.baseURL = config.baseURL || DEFAULT_LOCAL_OPENAI_BASE_URL;
        state.config.systemPrompt =
          config.systemPrompt || (config.remoteSession ? "" : await buildDefaultSystemPrompt());
        state.config.initialPrompt = config.initialPrompt || "";
        state.config.maxIterations = config.maxIterations ?? DEFAULT_AGENT_MAX_ITERATIONS;
        state.config.maxConcurrentTasks = config.maxConcurrentTasks;
        state.config.apiKey = config.apiKey || "";
        state.config.mcpConfigPath = config.mcpConfigPath || "";
        state.config.extensionDirs = config.extensionDirs ?? [];
        state.config.continueSession = config.continueSession ?? false;
        state.config.resumeSession = config.resumeSession || "";
        state.config.serverModel = "";
        applyOptionalAppConfig(state.config, config);

        // Unified model-config pipeline: resolve the config source — the agent
        // server for remote-session hosts (GET /api/agent/models, sanitized);
        // the provider server for remote-provider hosts; the local
        // `.agents/config/models.json` for direct hosts — load it into memory
        // and register the matching ModelProvider so agent creation resolves
        // models through it. Session sources resolve server-side: no client
        // provider registration, and the config.* connection fields stay
        // display-only (the agent runs server-side). Non-fatal — a missing/
        // invalid config just keeps the host-provided defaults.
        const source = config.remoteSession
          ? { kind: "session" as const, serverUrl: config.remoteSession }
          : config.remoteProvider
            ? { kind: "provider" as const, serverUrl: config.remoteProvider }
            : { kind: "file" as const };
        // Explicit model flags (`--model` / `--style` / `--base-url` / `--api-key`) isolate
        // the session from the on-disk `.agents/config/models.json`: the flags are
        // authoritative and `/models` lists nothing. Remote provider/session hosts keep
        // their server-owned list (the flags do not apply there).
        const skipModelsConfig = config.modelExplicit === true && source.kind === "file";
        try {
          const loaded = skipModelsConfig ? null : await loadModels(source);
          if (loaded) {
            if (!config.remoteSession) {
              // `global` carries `toolConfig` only (see `ModelsConfigGlobal`). Apply it UNDER the
              // host value (per field): the CLI/env `toolConfig` wins, the file fills the gaps.
              // Done here (before agent creation / `adapter.initialize`) so `Host.create` sees the
              // merged result. `codent acp` applies the same block in its bootstrap.
              const mergedToolConfig = mergeModelsConfigToolConfig(state.config.toolConfig, loaded.config.global);
              if (mergedToolConfig) state.config.toolConfig = mergedToolConfig;

              await registerModelProviderForEntry(loaded);
              const entry = loaded.entries[loaded.active.entryIndex];
              if (entry) {
                state.config.model = loaded.active.model ?? entry.models[0] ?? state.config.model;
                state.config.style = entry.style;
                state.config.baseURL = entry.baseURL;
                state.config.apiKey = entry.apiKey ?? "";
                state.config.providerMode = entry.type === "remote" ? "remote" : "direct";
              }
            }
            state.modelsConfig = loaded;
          }
        } catch {
          // Ignore — fall back to host-provided model defaults.
        }

        state.initialized = true;

        const { model, baseURL, systemPrompt, style } = state.config;
        state.key = `::${style}::${model}::${baseURL}::${systemPrompt}`;
      },

      setHelpRequested: (help: boolean) => {
        state.helpRequested = help;
      },

      /**
       * Select a model (by `/models`) for THIS process: it updates the in-memory
       * `modelsConfig.active` and the config defaults the next agent creation uses.
       *
       * It does NOT write `models.json` (only the config editor's save path does), so a restart
       * starts a NEW session from the file's last save. The session's own choice still survives a
       * restart through `SessionData.model` (the session snapshot) when that session is resumed.
       *
       * Session entries (remote-session hosts) only update `modelsConfig.active`
       * and the display-only `config.serverModel`: the connection fields are
       * server-owned, and writing `config.model` here would flip the agent-chat
       * effect deps and tear down the live remote session. `config.serverModel`
       * is read by the status surfaces (footer/help/usage) and is deliberately
       * kept out of those deps, so it is safe to refresh after a switch.
       */
      selectModel: (entryIndex: number, model: string, entry: LoadedModelEntry) => {
        if (state.modelsConfig) {
          state.modelsConfig = {
            ...state.modelsConfig,
            active: { entryIndex, model },
          };
        }
        if (entry.type === "session") {
          state.config.serverModel = model;
          return;
        }
        state.config.model = model;
        state.config.style = entry.style;
        state.config.baseURL = entry.baseURL;
        state.config.apiKey = entry.apiKey ?? "";
        state.config.providerMode = entry.type === "remote" ? "remote" : "direct";
      },

      setConfig: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
        state.config[key] = value;
      },

      /**
       * Adopt a freshly loaded models config (entries + active) after a mid-session
       * `models.json` rewrite. The connection fields (`config.model` / `style` /
       * `baseURL` / `apiKey`) are deliberately NOT written here: they are
       * `useAgentChat`'s rebuild deps-adjacent state and the running session keeps
       * its own connection until the user picks a model with `/models` (which
       * routes through `applyModelSelection`). `modelsConfig` is what `/models`
       * lists and what the next `relinkSessionModel` resolves against.
       */
      setModelsConfig: (loaded: LoadedModelsState) => {
        state.modelsConfig = loaded;
      },

      updateConfig: (updates: Partial<AppConfig>) => {
        Object.assign(state.config, updates);
      },

      reset: () => {
        state.config.model = "";
        state.config.style = DEFAULT_STYLE;
        state.config.baseURL = DEFAULT_LOCAL_OPENAI_BASE_URL;
        state.config.systemPrompt = "";
        state.config.initialPrompt = "";
        state.config.maxIterations = DEFAULT_AGENT_MAX_ITERATIONS;
        state.config.maxConcurrentTasks = undefined;
        state.config.apiKey = "";
        state.config.mcpConfigPath = "";
        state.config.extensionDirs = [];
        state.config.continueSession = false;
        state.config.resumeSession = "";
        state.config.serverModel = "";
        clearOptionalAppConfig(state.config);
        state.helpRequested = false;
        state.initialized = false;
        state.key = "";
      },
    }),

    withDeepSelector: false,
    withStableSelector: true,
    withNamespace: "useConfig",
  }
);

export const initConfig = async (config: Partial<AppConfig>): Promise<void> => {
  await useConfig.getActions().init(config);
};
