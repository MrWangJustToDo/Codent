/**
 * DuckDuckGo Provider — Free HTML-based search (no API key required).
 *
 * Parses DuckDuckGo HTML search results. Used as a fallback when no
 * API-based providers are configured.
 */

import { getEnv } from "../../../../../../env";
import { createTimeoutAbort } from "../../../../shared/abort-timeout.js";
import { DEFAULT_MAX_BODY_BYTES, readBodyTextBounded } from "../../fetch/bounded-body.js";
import { filterResultsByDomain } from "../domain-filter.js";

import type { SearchProvider, SearchResult, SearchOptions } from "../types.js";

// ============================================================================
// Constants
// ============================================================================

const PROVIDER_NAME = "duckduckgo";

// ============================================================================
// URL Cleaning
// ============================================================================

function cleanDuckDuckGoUrl(url: string): string {
  if (url.startsWith("https://duckduckgo.com/l/?uddg=")) {
    try {
      const parsedUrl = new URL(url);
      const actualUrl = parsedUrl.searchParams.get("uddg");
      if (actualUrl) {
        return decodeURIComponent(actualUrl);
      }
    } catch {
      // Fall through to return original
    }
  }
  return url;
}

// ============================================================================
// HTML Text Extraction
// ============================================================================

function extractText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================================
// HTML Parsing
// ============================================================================

function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  const resultBlockPattern = /<div[^>]*class="[^"]*result[^"]*web-result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div|$)/gi;
  const titleLinkPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i;

  let blockMatch;
  while ((blockMatch = resultBlockPattern.exec(html)) !== null) {
    const block = blockMatch[1];

    const titleMatch = titleLinkPattern.exec(block);
    if (!titleMatch) continue;

    const rawUrl = titleMatch[1];
    const rawTitle = titleMatch[2];
    if (!rawUrl || !rawTitle) continue;

    const url = cleanDuckDuckGoUrl(rawUrl);
    const title = extractText(rawTitle);
    if (!title || title.length < 2) continue;

    const snippetMatch = snippetPattern.exec(block);
    const snippet = snippetMatch ? extractText(snippetMatch[1]) : "";

    results.push({ title, url, snippet });
  }

  if (results.length === 0) {
    const titlePattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetPatternGlobal = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

    const titles: Array<{ url: string; title: string }> = [];
    let match;
    while ((match = titlePattern.exec(html)) !== null) {
      const url = cleanDuckDuckGoUrl(match[1]);
      const title = extractText(match[2]);
      if (url && title && title.length >= 2) {
        titles.push({ url, title });
      }
    }

    const snippets: string[] = [];
    while ((match = snippetPatternGlobal.exec(html)) !== null) {
      snippets.push(extractText(match[1]));
    }

    for (let i = 0; i < titles.length; i++) {
      results.push({
        title: titles[i].title,
        url: titles[i].url,
        snippet: snippets[i] || "",
      });
    }
  }

  if (results.length === 0) {
    const linkPattern = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const seen = new Set<string>();
    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      const url = cleanDuckDuckGoUrl(match[1]);
      const title = extractText(match[2]);
      if (
        url &&
        title &&
        !url.includes("duckduckgo.com") &&
        !seen.has(url) &&
        title.length > 5 &&
        !url.includes("javascript:")
      ) {
        seen.add(url);
        results.push({ title, url, snippet: "" });
      }
    }
  }

  return results;
}

// ============================================================================
// DuckDuckGo Provider
// ============================================================================

export const duckduckgoProvider: SearchProvider = {
  name: PROVIDER_NAME,

  isAvailable(): boolean {
    return true;
  },

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const timeoutMs = options?.timeoutMs ?? 30000;
    const { controller, cleanup } = createTimeoutAbort({ timeoutMs, signal: options?.signal });

    try {
      const response = await (options?.coreEnv ?? getEnv()).fetch(searchUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!response.ok) {
        throw new Error(`DuckDuckGo search failed with status: ${response.status}`);
      }

      const html = await readBodyTextBounded(response, DEFAULT_MAX_BODY_BYTES);
      let results = parseDuckDuckGoResults(html);
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
