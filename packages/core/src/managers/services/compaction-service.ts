/**
 * CompactionService — compaction domain state: configuration, auto-compact
 * trigger evaluation, and the reactive-compact retry budget.
 *
 * Extracted from ManagedAgent (config field + trigger method) and
 * RunCoordinator (run-scoped retry counter). Orchestration — persisting the
 * token limit to UsageTracker, running manual/reactive compaction — lives in
 * `managers/compact-facet.ts` (`runManualCompact` / `handleManagedReactiveCompact`),
 * which `ManagedAgent` calls directly.
 */

import { shouldTriggerAutoCompact } from "../../agent/compaction/auto-compact.js";
import { getMaxReactiveRetries } from "../../agent/compaction/reactive-compact.js";
import { createCompactionConfig } from "../../agent/compaction/types.js";

import type { CompactionConfig } from "../../agent/compaction/types.js";
import type { ModelMessage } from "@tanstack/ai";

const MAX_REACTIVE_RETRIES = getMaxReactiveRetries();

export class CompactionService {
  private config: CompactionConfig | null = null;

  private reactiveCompactRetries = 0;

  setConfig(config: CompactionConfig): void {
    this.config = config;
  }

  getConfig(): CompactionConfig | null {
    return this.config;
  }

  /** Evaluate the auto-compact trigger against the agent's live usage/window. */
  shouldTriggerAutoCompact(options: {
    contextFillTokens?: number;
    messages?: ModelMessage[];
    contextWindow?: number;
  }): boolean {
    return shouldTriggerAutoCompact(this.config ?? createCompactionConfig(), options);
  }

  // ---------------------------------------------------------------------------
  // Reactive-compact retry budget (reset per run)
  // ---------------------------------------------------------------------------

  resetReactiveCompactRetries(): void {
    this.reactiveCompactRetries = 0;
  }

  canRetryReactiveCompact(): boolean {
    return this.reactiveCompactRetries < MAX_REACTIVE_RETRIES;
  }

  recordReactiveCompactRetry(): number {
    this.reactiveCompactRetries += 1;
    return this.reactiveCompactRetries;
  }

  /**
   * Give a retry slot back when no compaction was attempted.
   *
   * `begin()` can refuse (a pending wait, a manual compaction, a destroyed agent). Without the
   * refund the budget was consumed by a claim that never ran, and the next real overflow saw
   * `max-retries` with zero attempts made.
   */
  refundReactiveCompactRetry(): void {
    if (this.reactiveCompactRetries > 0) this.reactiveCompactRetries -= 1;
  }

  getMaxReactiveCompactRetries(): number {
    return MAX_REACTIVE_RETRIES;
  }
}
