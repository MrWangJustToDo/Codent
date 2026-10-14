/**
 * Name slugification — one composition, per-caller policy.
 *
 * The memory store and the plan store each kept a slug skeleton that agreed on "lowercase, replace
 * runs with `-`, trim, fall back to a timestamp" but disagreed on everything else: memory keeps
 * Unicode letters (CJK names) and does not cap the length, the plan store is ASCII-only and caps at
 * 48 characters. Two skeletons is how a fix to one is forgotten in the other, so the shape lives
 * here and each caller passes the policy that actually differs.
 */

export interface SlugifyOptions {
  /** Keep Unicode letters and numbers (CJK-safe) instead of the ASCII-only class. */
  unicode?: boolean;
  /** Cap the produced slug at this many characters. `0` or omitted means uncapped. */
  maxLength?: number;
  /** Prefix for the timestamp-based fallback when the input slugs to nothing. */
  fallbackPrefix: string;
}

/** Produce a URL-safe slug from a human name, per the caller's policy. */
export function slugifyName(input: string, options: SlugifyOptions): string {
  const lowered = input.toLowerCase();
  const collapsed = options.unicode
    ? lowered
        .replace(/\s+/g, "-")
        .replace(/[^\p{L}\p{N}-]/gu, "")
        .replace(/-{2,}/g, "-")
        .replace(/^-|-$/g, "")
    : lowered.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  const capped = options.maxLength && options.maxLength > 0 ? collapsed.slice(0, options.maxLength) : collapsed;
  if (!capped) return `${options.fallbackPrefix}-${Date.now().toString(36)}`;
  return capped;
}
