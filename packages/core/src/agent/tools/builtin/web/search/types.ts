/**
 * WebSearch Types — Shared types for the multi-provider search architecture.
 */

import type { ResolvedCoreEnv } from "../../../../../env";

// ============================================================================
// Search Result
// ============================================================================

export interface SearchResult {
  /** Title of the search result */
  title: string;
  /** Snippet/description of the result */
  snippet: string;
  /** URL of the result */
  url: string;
}

export interface SearchOutcome {
  results: SearchResult[];
  /** Provider that actually produced the results (after fallback). */
  provider: string;
}

// ============================================================================
// Provider Interface
// ============================================================================

export interface SearchOptions {
  /** Maximum number of results to return */
  maxResults?: number;
  /** Only include results from these domains */
  allowedDomains?: string[];
  /** Exclude results from these domains */
  blockedDomains?: string[];
  /** Timeout in milliseconds */
  timeoutMs?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /**
   * Workspace env of the calling runtime (for `fetch`). Providers fall back to the
   * ambient env when omitted (standalone provider use / tests).
   */
  coreEnv?: ResolvedCoreEnv;
  /**
   * Stable session identifier. Free providers are spread by this value so different
   * conversations use different public endpoints; providers may also forward it as an
   * upstream rate-limit key (Parallel's `session_id`).
   */
  sessionId?: string;
  /**
   * API-key lookup scoped to the {@link ProviderManager} running the search. Providers read
   * keys only from this resolver; there is no process-global key source.
   */
  getApiKey?: (providerName: string) => string | undefined;
}

export interface SearchProvider {
  /** Unique provider name */
  readonly name: string;
  /** Whether this provider is available (e.g., API key configured) */
  isAvailable(options?: Pick<SearchOptions, "getApiKey">): boolean | Promise<boolean>;
  /**
   * Search the web.
   * Should throw on failure so the ProviderManager can fallback.
   */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

// ============================================================================
// Provider Metadata
// ============================================================================

export interface ProviderInfo {
  name: string;
  available: boolean;
  description: string;
}
