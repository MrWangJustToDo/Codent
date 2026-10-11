// Types
export type {
  ModelCapability,
  ModelId,
  ModelInfo,
  ModelOption,
  ModelPricing,
  ModelStyle,
  ReasoningConfig,
  ReasoningEffort,
} from "./types.js";

// Connection + env resolution (primary entry)
export {
  DEFAULT_BASE_URLS,
  DEFAULT_LOCAL_OPENAI_BASE_URL,
  parseModelStyle,
  resolveModelConfig,
  resolveModelConnection,
  type ModelConnection,
  type ResolveModelConfigInput,
  type ResolvedModelConfig,
} from "./config/model-config.js";

export {
  resolveModelConfigFromProvider,
  type ResolvedModelConfigFromProvider,
} from "../provider/resolve-from-provider.js";

export {
  MODELS_CONFIG_DIR,
  MODELS_CONFIG_FILE,
  loadModelEntries,
  loadModels,
  loadModelsConfigFromFile,
  normalizeGlobalToolConfig,
  normalizeRawGlobalToolConfig,
  parseModelsConfig,
  readModelsConfigFile,
  registerModelProviderForEntry,
  resolveModelInfoFromModelsDev,
  resolveModelsConfig,
  resolveModelsConfigFromProvider,
  saveModelsConfig,
  writeModelsConfigFile,
  type DirectModelsConfigEntry,
  type LoadedModelEntry,
  type LoadedModelsState,
  type ModelsConfig,
  type ModelsConfigActive,
  type ModelsConfigEntry,
  type ModelsConfigGlobal,
  type ModelsConfigSource,
  type ProviderInfo,
  type RawModelsConfig,
  type RemoteProviderConfigEntry,
} from "./config/models-config.js";

export {
  registerModelProvider,
  clearModelProvider,
  getModelProvider,
  hasModelProvider,
} from "../provider/model-provider-registry.js";

export {
  createDirectModelProvider,
  type ModelProviderMode,
  type ModelProviderConnection,
  type ModelProvider,
} from "../provider/model-provider.js";

export { createRemoteProvider, REMOTE_PROVIDER_API_KEY } from "../provider/remote-model-provider.js";

// models.dev metadata lookup
export {
  fetchModelsDev,
  getModelsByProviderFromModelsDev,
  lookupModelFromModelsDev,
  MODELS_DEV_URL,
} from "../provider/models-dev.js";

// TanStack text adapter (+ provider-specific protocol quirks live here only)
export { createTextAdapter, type TextAdapterConfig, type ModelAdapterConfig } from "./adapter/adapter-factory.js";
export {
  createChatCompletions,
  ChatCompletionsTextAdapter,
  type ChatCompletionsTextAdapterConfig,
} from "./adapter/chat-completions-text-adapter.js";
export { liftToolMediaForChatCompletions } from "./adapter/lift-tool-media-for-chat-completions.js";
export {
  buildReasoningContentFromThinking,
  extractReasoningContentFromStreamChunk,
  shouldEchoReasoningContent,
} from "./adapter/reasoning-echo.js";
export { ReasoningContentCache } from "./cache/reasoning-content-cache.js";
export { resolveReasoningContentForAssistant } from "./adapter/resolve-reasoning-content.js";
export {
  createReasoningChatCompletions,
  ReasoningChatCompletionsTextAdapter,
  type ReasoningChatCompletionsConfig,
} from "./adapter/reasoning-chat-completions-adapter.js";

export {
  runSideTextQuery,
  type SideTextQueryOptions,
  type SideTextQueryResult,
  type StructuredQueryOptions,
  type StructuredQueryResult,
} from "./adapter/side-text-query.js";

export { maxTokensOption } from "./max-tokens-option.js";
