/**
 * Exa Provider — Free web search via Exa's public MCP endpoint, or its keyed MCP tier.
 *
 * Calls the `web_search_exa` tool over JSON-RPC at https://mcp.exa.ai/mcp and parses the
 * SSE/JSON payload. The public endpoint needs no key and is the default free provider
 * (the DuckDuckGo HTML endpoint is increasingly blocked by anti-bot challenges); when
 * `?exaApiKey=` and runs on the keyed tier when the host configures an Exa key.
 *
 * `isAvailable` always returns true; failures surface as thrown errors so the
 * ProviderManager can fall back.
 *
 * @see https://exa.ai
 */

import { filterResultsByDomain } from "../domain-filter.js";
import { getProviderManager } from "../provider.js";

import { callMcpTool } from "./mcp-client.js";

import type { SearchProvider, SearchResult, SearchOptions } from "../types.js";

// ============================================================================
// Constants
// ============================================================================

const PROVIDER_NAME = "exa";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const EXA_TOOL_NAME = "web_search_exa";

// ============================================================================
// Result Parsing
// ============================================================================

/**
 * Collapse the free-form body that follows `Highlights:` / `Content:` into a
 * bounded single-line snippet.
 */
function extractBody(block: string): string {
  // Exa's formatter emits `Highlights:` / `Content:` / `Text:` depending on the result.
  const match = block.match(/^(?:Highlights|Content|Text):[ \t]*([\s\S]*)$/m);
  const body = match?.[1] ?? block;
  return body
    .replace(/^(?:Title|URL|Published|Author):.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/**
 * Parse Exa's text payload into results. Entries are separated by `---`, each
 * with `Title:` / `URL:` header lines and an optional `Highlights:`/`Content:`
 * body. Falls back to markdown links and bare URLs when the header format is
 * absent.
 */
export function parseExaResults(text: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const block of text.split(/\n-{3,}\n/g)) {
    const urlMatch = block.match(/^URL:\s*(https?:\/\/\S+)$/m);
    if (!urlMatch) continue;

    const url = urlMatch[1].trim();
    if (seen.has(url)) continue;
    seen.add(url);

    // Exa emits `Title: N/A` for a result with no title; fall back to the URL.
    const rawTitle = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    const title = rawTitle && rawTitle.toUpperCase() !== "N/A" ? rawTitle : url;
    results.push({ title, url, snippet: extractBody(block) });
  }

  if (results.length === 0) {
    const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
    let match;
    while ((match = markdownLinkPattern.exec(text)) !== null) {
      const url = match[2].trim();
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({ title: match[1].trim(), url, snippet: "" });
    }
  }

  return results;
}

// ============================================================================
// Exa Provider
// ============================================================================

export const exaProvider: SearchProvider = {
  name: PROVIDER_NAME,

  isAvailable(): boolean {
    return true;
  },

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const maxResults = options?.maxResults ?? 10;
    const timeoutMs = options?.timeoutMs ?? 30000;
    const apiKey = getProviderManager().getApiKey(PROVIDER_NAME);

    const url = apiKey ? `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(apiKey)}` : EXA_MCP_URL;
    const text = await callMcpTool({
      url,
      toolName: EXA_TOOL_NAME,
      args: { query, numResults: maxResults },
      timeoutMs,
      signal: options?.signal,
    });

    let results = parseExaResults(text);
    results = filterResultsByDomain(results, options?.allowedDomains, options?.blockedDomains);

    if (options?.maxResults && results.length > options.maxResults) {
      results = results.slice(0, options.maxResults);
    }

    return results;
  },
};
