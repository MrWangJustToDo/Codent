/**
 * ProviderManager — Manages search providers, auto-detection, spreading, and fallback.
 */

import { toError } from "../../../../../utils/errors.js";

import { PROVIDER_KEY_FIELDS } from "./key-fields.js";

import type { SearchOutcome, SearchProvider, SearchOptions, ProviderInfo } from "./types.js";
import type { WebsearchToolConfig } from "../../../tool-config.js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Deterministic index in `[0, length)` derived from a string. Used to spread sessions
 * across the free providers so one unauthenticated public endpoint is not the single
 * dependency for every session. A tiny FNV-1a — the quality bar is "different sessions
 * land on different providers, the same session always lands on the same one", not
 * uniformity.
 */
export function hashToIndex(value: string, length: number): number {
  if (length <= 0) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % length;
}

// ============================================================================
// ProviderManager
// ============================================================================

export class ProviderManager {
  private providers: SearchProvider[] = [];
  private preferredProvider?: string;
  private apiKeys = new Map<string, string>();
  private sessionId?: string;
  /**
   * Serializes configure-and-search. `configure`/`setSessionId` mutate process-global
   * instance state that `search` (and every provider, via `getApiKey`) reads after an
   * `await`; two concurrent runs would otherwise interleave — run A's configure, run B's
   * configure, then A's search reading B's keys. Held only around the call, so searches
   * run one at a time (search is not a hot path; correctness beats parallelism here).
   */
  private mutex: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` with exclusive access to this manager, so a configure+search pair cannot be
   * interleaved by another caller. `fn` receives this manager; any rejection releases the
   * lock.
   */
  async runExclusive<T>(fn: (manager: ProviderManager) => Promise<T>): Promise<T> {
    const previous = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await fn(this);
    } finally {
      release();
    }
  }

  /**
   * Apply host-supplied websearch config (secrets + preferred provider).
   * Call before select/search so availability matches the active agent.
   */
  configure(config?: WebsearchToolConfig): void {
    this.apiKeys.clear();
    // Key wiring comes from PROVIDER_KEY_FIELDS, not a name switch here — adding a keyed
    // provider is a registry + key-fields edit, never a change to selection/transport code.
    const raw = (config ?? {}) as Record<string, unknown>;
    for (const [name, field] of Object.entries(PROVIDER_KEY_FIELDS)) {
      const value = raw[field];
      if (typeof value === "string" && value.trim()) this.apiKeys.set(name, value.trim());
    }

    const preferred = config?.provider?.trim();
    this.preferredProvider = preferred && preferred !== "" ? preferred : undefined;
  }

  /** API key for a provider name from the last {@link configure} call (not CoreEnv). */
  getApiKey(name: string): string | undefined {
    return this.apiKeys.get(name);
  }

  /** Brave API key from the last {@link configure} call (not CoreEnv). */
  getBraveApiKey(): string | undefined {
    return this.getApiKey("brave");
  }

  /**
   * Set the session id used to spread selection across free providers. A single
   * conversation keeps the same provider across calls.
   */
  setSessionId(sessionId?: string): void {
    this.sessionId = sessionId && sessionId !== "" ? sessionId : undefined;
  }

  /**
   * Register a provider. Earlier registrations are preferred in auto mode
   * (first available wins, apart from free-provider spreading).
   */
  register(provider: SearchProvider): void {
    // Avoid duplicate registrations of the same provider instance/name.
    if (this.providers.some((p) => p.name === provider.name)) return;
    this.providers.push(provider);
  }

  /** Registered provider names, in registration order. */
  listProviderNames(): string[] {
    return this.providers.map((p) => p.name);
  }

  /**
   * Get the best available provider.
   *
   * Selection logic:
   * 1. An explicit `provider` preference, when that provider is available
   * 2. Otherwise, a provider with a configured API key (keyed = higher quality / official
   *    tier, so a configured key wins over the free pool: the host-supplied Brave key must run Brave)
   * 3. Otherwise, with more than one free (no-key) provider available, a deterministic pick
   *    from the session id, so different sessions spread across the free providers while one
   *    session stays on a single one
   * 4. Otherwise the first available provider in registration order
   * 5. If none report available, the last registered provider (DuckDuckGo)
   */
  async selectProvider(): Promise<SearchProvider> {
    const preferred = this.preferredProvider;

    if (preferred && preferred !== "auto") {
      const explicit = this.providers.find((p) => p.name === preferred);
      if (explicit && (await this.isProviderAvailable(explicit))) {
        return explicit;
      }
    }

    const available: SearchProvider[] = [];
    for (const provider of this.providers) {
      if (await this.isProviderAvailable(provider)) available.push(provider);
    }

    // A configured key is a deliberate choice of quality: prefer a keyed provider over the
    // free pool. (Without this, the free-provider spread below would swallow a configured
    // Brave key and it would look ignored.)
    const keyed = available.find((p) => this.getApiKey(p.name));
    if (keyed) return keyed;

    // Only free providers (no key configured) are spread across sessions.
    if (available.length > 1 && this.sessionId) {
      return available[hashToIndex(this.sessionId, available.length)];
    }

    if (available.length > 0) return available[0];

    const last = this.providers[this.providers.length - 1];
    if (!last) {
      throw new Error("No search providers registered");
    }
    return last;
  }

  /**
   * Search with automatic fallback across providers.
   *
   * Tries the selected provider first. On failure, falls back to
   * other available providers. Throws only if all providers fail.
   */
  async search(query: string, options?: SearchOptions): Promise<SearchOutcome> {
    const primary = await this.selectProvider();
    let lastError: Error | null = null;
    // Bind the key lookup to THIS manager so a provider reads the keys configured for the
    // agent/runtime this search belongs to, not the process-global manager (see SearchOptions.getApiKey).
    const scopedOptions: SearchOptions = { ...options, getApiKey: (name) => this.getApiKey(name) };

    try {
      const results = await primary.search(query, scopedOptions);
      return { results, provider: primary.name };
    } catch (err) {
      lastError = toError(err);

      // A user abort is not a provider failure: do not fall back to another provider, and do not
      // mask the abort behind an "all providers failed" message. The abort must survive to the
      // caller, which classifies it against the run signal (`isAbortError`). A genuine timeout
      // is different — it aborts the provider's own controller, not `options.signal`, so the
      // fallback still runs for it.
      if (options?.signal?.aborted) throw lastError;

      for (const provider of this.providers) {
        if (provider === primary) continue;
        if (!(await this.isProviderAvailable(provider))) continue;
        try {
          const results = await provider.search(query, scopedOptions);
          return { results, provider: provider.name };
        } catch (fallbackErr) {
          lastError = toError(fallbackErr);
          if (options?.signal?.aborted) throw lastError;
        }
      }
    }

    throw new Error(`All search providers failed. Last error: ${lastError?.message ?? "unknown"}`);
  }

  /**
   * List all registered providers with their availability status.
   */
  async listProviders(): Promise<ProviderInfo[]> {
    const infos: ProviderInfo[] = [];
    for (const p of this.providers) {
      const available = await this.isProviderAvailable(p);
      infos.push({
        name: p.name,
        available,
        description: `${p.name} (${available ? "available" : "unavailable"})`,
      });
    }
    return infos;
  }

  private async isProviderAvailable(provider: SearchProvider): Promise<boolean> {
    return Boolean(await provider.isAvailable({ getApiKey: (name) => this.getApiKey(name) }));
  }
}
