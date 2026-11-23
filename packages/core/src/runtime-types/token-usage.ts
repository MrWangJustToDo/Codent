// ============================================================================
// Token Usage
// ============================================================================

import type { ModelPricing } from "../models/types.js";

export interface TokenUsage {
  /**
   * Prompt tokens, in the upstream's own convention: the whole prompt when the cache
   * counters are a subset of it (OpenAI, Gemini, gateways), or only the cache-*miss* part
   * when they are disjoint (Anthropic native, DeepSeek native). Never read it as "the
   * prompt" — use {@link promptTokensOf}, which resolves the convention per sample.
   */
  inputTokens: number;
  outputTokens: number;
  /**
   * Lifetime total = billed prompt + output. **Not** `inputTokens + outputTokens`, which
   * omits every cached token (see {@link totalTokensOf}).
   */
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/**
 * Calculate the cost of a token usage entry given pricing info.
 * Accounts for cache read/write tokens billed at their own rates.
 * Returns cost in USD.
 *
 * The uncached share is resolved the same way {@link promptTokensOf} resolves the prompt:
 * `cache > inputTokens` means the counters are *disjoint* from `inputTokens` (exclusive
 * upstream), so nothing may be subtracted from it. The previous form subtracted
 * unconditionally — `max(0, input - cache - cacheWrite)` — on the inclusive assumption, which
 * clamps the fresh input to **0** on every exclusive sample (a real row:
 * `input=307, cacheRead=337920`), billing those tokens at nothing while `promptTokensOf`, in
 * this same module, counted them in the prompt. One reading of one `TokenUsage`, twice.
 *
 * The share billed at the cache rate is the counter itself, never `inputTokens`:
 * an inclusive upstream reports the cached prefix *inside* `inputTokens` **and** in the
 * counter, and the counter is the authoritative one (it is the value the endpoint bills at
 * the cache rate, and it survives an upstream that under-reports it).
 */
export function calculateCost(usage: TokenUsage, pricing: ModelPricing): number {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const disjointCache = cacheRead + cacheWrite > usage.inputTokens;
  const normalInput = disjointCache ? usage.inputTokens : Math.max(0, usage.inputTokens - cacheRead - cacheWrite);

  const inputCost = normalInput * pricing.inputPerM;
  const cacheReadCost = cacheRead * (pricing.cacheReadPerM ?? pricing.inputPerM);
  const cacheWriteCost = cacheWrite * (pricing.cacheWritePerM ?? pricing.inputPerM);
  const outputCost = usage.outputTokens * pricing.outputPerM;

  return (inputCost + cacheReadCost + cacheWriteCost + outputCost) / 1_000_000;
}

/**
 * Billed prompt tokens: the one convention-aware reading of "how much prompt was sent".
 *
 * **This is the "billed prompt" the whole repo refers to.** The name differs by where it is
 * carried, which is worth knowing before grepping for one of them: the *rule* is
 * `promptTokensOf`, the accumulated field is `UsageTracker.billedInputTotal`, the read accessor
 * is `getBilledInputTokens()`, and the snapshot / subagent-output field is
 * `billedInputTokens` (`UsageChangeSnapshot`, `SubagentResult.usage`). One concept, one value —
 * only the spelling moves with the layer, because each is already published to hosts or
 * persisted in a session file and none of them may be renamed unilaterally.
 *
 * `inputTokens` alone is not it, because the field means two different things depending
 * on the upstream, and both conventions are in this repo's own logs:
 *
 * - **inclusive** (OpenAI, Gemini, most gateways) — `cacheReadTokens` is a *subset* of
 *   `inputTokens`, so the prompt is `inputTokens`.
 * - **exclusive** (Anthropic native, DeepSeek native) — the cache counters are *disjoint*
 *   from `inputTokens`, so the prompt is the sum.
 *
 * The cache counters cannot exceed a prompt that already contains them, so `cache >
 * inputTokens` identifies the disjoint convention. The judgement is made **per sample**: a
 * gateway can switch conventions between requests with no notice (observed mid-process
 * between two adjacent calls), which is why this is applied to each call rather than to a
 * config or a session.
 *
 * The heuristic can only ever *under*-count (an exclusive sample whose fresh tokens
 * outweigh its cached ones reads as inclusive), never over-count — and over-counting is
 * what would misfire compaction. Applying it to an *aggregate* is a different thing and a
 * weaker one: sums of a mixed session land on one side, which is why lifetime totals must
 * accumulate per sample (see `UsageTracker`).
 *
 * Lives here, beside {@link calculateCost}, so both the tracker and the usage store can
 * share it without an `agent → managers` or `models → agent` edge.
 */
export function promptTokensOf(usage: TokenUsage): number {
  const cache = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return cache > usage.inputTokens ? usage.inputTokens + cache : usage.inputTokens;
}

/**
 * Lifetime total tokens for one usage sample: the billed prompt plus the output.
 *
 * Deliberately **not** `inputTokens + outputTokens`, which omits every cached prompt token
 * and therefore reports ~1% of a cache-heavy session's real volume (measured here: 0.78M
 * against 50.88M on one session, and 1.4× understated across the whole global store).
 */
export function totalTokensOf(usage: TokenUsage): number {
  return promptTokensOf(usage) + (usage.outputTokens ?? 0);
}

/**
 * Tokens a delegated run reports as spent: the billed prompt plus output.
 *
 * Prefers the tracker's exact per-sample `billedInputTokens`; {@link totalTokensOf} is the
 * convention-aware fallback for records written before that value existed. One definition because the
 * `task` result and the `subagent:*` event used to report two different numbers for one run — the
 * event used `TokenUsage.totalTokens`, which omits the cached prompt entirely (one real run: 1.95k
 * reported against 2.70M sent).
 */
export function reportedRunTokens(usage: TokenUsage, billedInputTokens?: number): number {
  return (billedInputTokens ?? promptTokensOf(usage)) + (usage.outputTokens ?? 0);
}

/**
 * Extract the provider id reported by AG-UI `SpecTokenUsage[]` entries
 * (first non-empty). Single-object usage carries no provider — returns
 * undefined. Lets timeline events attribute usage/cost to a provider.
 */
export function extractTanStackProvider(
  usage:
    | {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      }
    | Array<{
        provider?: string;
      }>
): string | undefined {
  if (!Array.isArray(usage)) return undefined;
  for (const entry of usage) {
    if (entry.provider) return entry.provider;
  }
  return undefined;
}

/**
 * Map TanStack usage from `@tanstack/ai` RUN_FINISHED to core TokenUsage.
 *
 * TanStack 0.48+ allows `usage` to be either a single `TokenUsage` or an
 * AG-UI `SpecTokenUsage[]` array (one entry per model iteration). Arrays are
 * summed into one TokenUsage so multi-iteration runs report cumulative tokens.
 */
export function extractTanStackUsage(
  usage:
    | {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        promptTokensDetails?: { cachedTokens?: number };
        completionTokensDetails?: { reasoningTokens?: number };
      }
    | Array<{
        provider?: string;
        model?: string;
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        reasoningTokens?: number;
        cachedInputTokens?: number;
      }>
): TokenUsage {
  if (Array.isArray(usage)) {
    let input = 0;
    let output = 0;
    let total = 0;
    let cacheRead = 0;
    let reasoning = 0;
    for (const entry of usage) {
      input += entry.inputTokens ?? 0;
      output += entry.outputTokens ?? 0;
      total += entry.totalTokens ?? 0;
      cacheRead += entry.cachedInputTokens ?? 0;
      reasoning += entry.reasoningTokens ?? 0;
    }
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: total || input + output,
      cacheReadTokens: cacheRead || undefined,
      reasoningTokens: reasoning || undefined,
    };
  }

  const input = usage.promptTokens ?? 0;
  const output = usage.completionTokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage.totalTokens ?? input + output,
    cacheReadTokens: usage.promptTokensDetails?.cachedTokens ?? undefined,
    reasoningTokens: usage.completionTokensDetails?.reasoningTokens ?? undefined,
  };
}
