/**
 * Brave Search API Provider — Uses the Brave Search API for reliable web search.
 *
 * Brave Search API:
 * - Free tier: 2,000 queries/month
 * - Paid: $5 per 1,000 queries
 * - Independent search index (not Google/Bing dependent)
 * - Returns: title, url, description (snippet)
 *
 * @see https://brave.com/search/api/
 */

import { getEnv } from "../../../../env";
import { createTimeoutAbort } from "../../util/abort-timeout.js";
import { filterResultsByDomain } from "../domain-filter.js";
import { getProviderManager } from "../provider.js";

import type { SearchProvider, SearchResult, SearchOptions } from "../types.js";

// ============================================================================
// Constants
// ============================================================================

const PROVIDER_NAME = "brave";
const BRAVE_SEARCH_API = "https://api.search.brave.com/res/v1/web/search";

// ============================================================================
// Brave API Response Types
// ============================================================================

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
  query?: {
    original: string;
  };
}

// ============================================================================
// Brave Provider
// ============================================================================

export const braveProvider: SearchProvider = {
  name: PROVIDER_NAME,

  async isAvailable(): Promise<boolean> {
    return Boolean(getBraveApiKey());
  },

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const apiKey = getBraveApiKey();
    if (!apiKey) {
      throw new Error(
        "Brave Search API key not configured. Pass toolConfig.websearch.braveApiKey when creating the agent."
      );
    }

    const maxResults = options?.maxResults ?? 10;
    const timeoutMs = options?.timeoutMs ?? 30000;
    const { controller, cleanup } = createTimeoutAbort({ timeoutMs, signal: options?.signal });

    try {
      const url = new URL(BRAVE_SEARCH_API);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(maxResults, 20)));
      url.searchParams.set("safesearch", "moderate");

      const response = await getEnv().fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Brave Search API: invalid or expired API key");
        }
        if (response.status === 429) {
          throw new Error("Brave Search API: rate limit exceeded");
        }
        throw new Error(`Brave Search API failed with status: ${response.status}`);
      }

      const data = (await response.json()) as BraveSearchResponse;
      const rawResults = data.web?.results ?? [];

      let results: SearchResult[] = rawResults
        .map((r) => ({
          title: r.title ?? "",
          snippet: r.description ?? "",
          url: r.url ?? "",
        }))
        .filter((r) => r.title && r.url);

      results = filterResultsByDomain(results, options?.allowedDomains, options?.blockedDomains);

      if (options?.maxResults && results.length > options.maxResults) {
        results = results.slice(0, options.maxResults);
      }

      return results;
    } finally {
      cleanup();
    }
  },
};

// ============================================================================
// Helpers
// ============================================================================

function getBraveApiKey(): string | undefined {
  return getProviderManager().getBraveApiKey();
}
