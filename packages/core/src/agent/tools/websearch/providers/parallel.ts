/**
 * Parallel Provider — Web search via Parallel's MCP endpoint (free) or its keyed tier.
 *
 * Endpoint: `https://search.parallel.ai/mcp`, tool `web_search`, whose required arguments
 * are `objective` (natural-language goal) and `search_queries` (1+ keyword queries).
 * Without an API key this is the free public endpoint; with a configured Parallel key the same
 * call carries `?apiKey=` and runs on the keyed tier. `session_id` is sent so the free
 * tier can rate-limit per conversation.
 *
 * The tool returns results as a JSON string nested in its text content:
 * `{ results: [{ url, title, excerpts: string[] }] }`.
 *
 * @see https://parallel.ai
 */

import { filterResultsByDomain } from "../domain-filter.js";
import { getProviderManager } from "../provider.js";

import { callMcpTool } from "./mcp-client.js";

import type { SearchProvider, SearchResult, SearchOptions } from "../types.js";

// ============================================================================
// Constants
// ============================================================================

const PROVIDER_NAME = "parallel";
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const PARALLEL_TOOL_NAME = "web_search";

// ============================================================================
// Result Parsing
// ============================================================================

interface ParallelResponse {
  results?: Array<{
    url?: string;
    title?: string;
    excerpts?: string[];
  }>;
}

export function parseParallelResults(text: string): SearchResult[] {
  let parsed: ParallelResponse;
  try {
    parsed = JSON.parse(text) as ParallelResponse;
  } catch {
    // A payload that is not our JSON contract is a protocol failure, not an empty result set:
    // throwing lets ProviderManager fall back instead of reporting a successful 0-result search.
    throw new Error("Parallel search returned a malformed payload");
  }

  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const raw of parsed.results ?? []) {
    const url = raw.url?.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const snippet = (raw.excerpts ?? []).join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
    results.push({ title: raw.title?.trim() || url, url, snippet });
  }

  return results;
}

// ============================================================================
// Parallel Provider
// ============================================================================

export const parallelProvider: SearchProvider = {
  name: PROVIDER_NAME,

  isAvailable(): boolean {
    return true;
  },

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const maxResults = options?.maxResults ?? 10;
    const timeoutMs = options?.timeoutMs ?? 30000;
    const apiKey = getProviderManager().getApiKey(PROVIDER_NAME);
    const sessionId = options?.sessionId;

    const url = apiKey ? `${PARALLEL_MCP_URL}?apiKey=${encodeURIComponent(apiKey)}` : PARALLEL_MCP_URL;
    const text = await callMcpTool({
      url,
      toolName: PARALLEL_TOOL_NAME,
      args: {
        objective: query,
        // Parallel's schema wants 1-3 concise queries. The agent gives one search string,
        // so the query is sent once (a genuine second variation would be guessed, not known).
        search_queries: [query.slice(0, 200)],
        ...(sessionId ? { session_id: sessionId.slice(0, 100) } : {}),
      },
      timeoutMs,
      signal: options?.signal,
    });

    let results = parseParallelResults(text);
    results = filterResultsByDomain(results, options?.allowedDomains, options?.blockedDomains);

    if (options?.maxResults && results.length > options.maxResults) {
      results = results.slice(0, options.maxResults);
    }
    return results.slice(0, maxResults);
  },
};
