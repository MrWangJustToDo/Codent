/**
 * Domain allow/block filtering for search results.
 */

import type { SearchResult } from "./types.js";

function getHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Filter results by allowedDomains and/or blockedDomains (case-insensitive).
 * Hosts that fail URL parsing are dropped when an allowlist is active;
 * with only a blocklist they are kept.
 */
export function filterResultsByDomain(
  results: SearchResult[],
  allowedDomains?: string[],
  blockedDomains?: string[]
): SearchResult[] {
  if (!allowedDomains?.length && !blockedDomains?.length) {
    return results;
  }

  const allowed = allowedDomains?.map((d) => d.toLowerCase()) ?? null;
  const blocked = blockedDomains?.map((d) => d.toLowerCase()) ?? null;

  return results.filter((result) => {
    const host = getHostname(result.url);
    if (!host) return !allowed?.length;

    if (allowed && allowed.length > 0) {
      return allowed.some((domain) => hostMatchesDomain(host, domain));
    }

    if (blocked && blocked.length > 0) {
      return !blocked.some((domain) => hostMatchesDomain(host, domain));
    }

    return true;
  });
}
