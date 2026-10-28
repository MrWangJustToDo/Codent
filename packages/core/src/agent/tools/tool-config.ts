/**
 * Agent tool configuration — secrets and provider prefs passed explicitly by hosts.
 * Core tools MUST NOT dig credentials from CoreEnv.getEnv().
 */

export interface WebsearchToolConfig {
  /** Brave Search API key (when set, Brave may be selected). */
  braveApiKey?: string;
  /** Exa API key. When set, Exa uses its official API instead of the public MCP endpoint. */
  exaApiKey?: string;
  /** Parallel API key. When set, Parallel uses its keyed tier on the MCP endpoint. */
  parallelApiKey?: string;
  /** Tavily API key. Tavily has no free transport, so it is unavailable without this. */
  tavilyApiKey?: string;
  /**
   * Preferred provider name (`brave`, `parallel`, `exa`, `tavily`, `duckduckgo`, …) or `auto`.
   * When omitted or `auto`, free providers are spread by session id and the first available
   * provider wins — see `ProviderManager.selectProvider`.
   */
  provider?: string;
}

export interface AgentToolConfig {
  websearch?: WebsearchToolConfig;
}

/**
 * Build the websearch tool config from an EXPLICIT environment record.
 *
 * Every host that can carry secrets through `.env` shares this mapping: the CLI TUI
 * (`parseCliArgs`) and the ACP bootstrap. A host-specific copy is how a key that works in one
 * host stayed dead in the other (`codent acp` read `models.json` but not `BRAVE_API_KEY`).
 *
 * The caller supplies the record — core still never reads `CoreEnv.getEnv()` for credentials.
 */
export function websearchToolConfigFromEnv(env: Record<string, string | undefined>): AgentToolConfig | undefined {
  const values: WebsearchToolConfig = {
    ...(env.BRAVE_API_KEY ? { braveApiKey: env.BRAVE_API_KEY } : {}),
    ...(env.EXA_API_KEY ? { exaApiKey: env.EXA_API_KEY } : {}),
    ...(env.PARALLEL_API_KEY ? { parallelApiKey: env.PARALLEL_API_KEY } : {}),
    ...(env.TAVILY_API_KEY ? { tavilyApiKey: env.TAVILY_API_KEY } : {}),
    ...(env.WEBSEARCH_PROVIDER ? { provider: env.WEBSEARCH_PROVIDER } : {}),
  };
  return Object.keys(values).length > 0 ? { websearch: values } : undefined;
}

/**
 * Merge the websearch `toolConfig` from a loaded `models.json` (`global.toolConfig`) into the
 * host-provided `toolConfig`.
 *
 * Precedence is **per field**: the host value wins, the file fills the gaps. A file that sets
 * `provider: "parallel"` while the host supplies a Brave key yields both. The file's
 * `websearchProvider` spelling is already normalized to `provider` by `loadModels` (see
 * `normalizeGlobalToolConfig`), so this only deals with the new name.
 *
 * Consumers: the TUI config load (`use-config.ts`) and the ACP bootstrap, both merging the file
 * UNDER their own env-derived value. Returns the host config unchanged (by reference) when the
 * file declares nothing, and a fresh object when it does — the inputs are not mutated.
 */
export function mergeModelsConfigToolConfig(
  hostConfig: AgentToolConfig | undefined,
  fileConfig: { toolConfig?: { provider?: string; [key: string]: unknown } } | undefined
): AgentToolConfig | undefined {
  const file = fileConfig?.toolConfig;
  if (!file) return hostConfig;

  const merged: WebsearchToolConfig = { ...(file as WebsearchToolConfig) };
  for (const [key, value] of Object.entries(hostConfig?.websearch ?? {})) {
    if (value !== undefined && value !== "") {
      (merged as Record<string, unknown>)[key] = value;
    }
  }

  return { ...hostConfig, websearch: merged };
}
