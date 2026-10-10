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
