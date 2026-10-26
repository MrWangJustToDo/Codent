/**
 * MemoryService — the memory manager holder plus end-of-turn extraction.
 *
 * Selection and injection live in the built-in memory extension (it owns the per-turn query,
 * the surfaced set and the context sections). This service keeps only what the run lifecycle
 * still drives: the manager it was given and the post-turn extraction/consolidation pass.
 */

import { extractMemories, consolidateMemories } from "../../agent/memory/memory-extractor.js";
import { errorMessage } from "../../utils/errors.js";

import type { AgentLog } from "../../agent/agent-log";
import type { MemoryManager } from "../../agent/memory/memory-manager.js";
import type { TextAdapterConfig } from "../../models/adapter/adapter-factory.js";
import type { EmitAgentTelemetryFn } from "../telemetry/emit-agent-telemetry.js";
import type { UsageTracker } from "../telemetry/usage-tracker.js";
import type { ModelMessage } from "@tanstack/ai";

export interface MemoryExtractionInput {
  getMessagesForLLM: () => ModelMessage[];
  log: AgentLog | null;
  /**
   * Owning agent's usage tracker. Extraction and consolidation are real LLM calls, so
   * their tokens belong in the session's lifetime totals — they reached only the global
   * usage store before this. Optional so a host can opt out, but any host with a tracker
   * should pass it.
   */
  usage?: UsageTracker;
  /**
   * Text adapter for the extraction and consolidation queries. Resolved by the
   * host so extraction runs through the same provider/model as the turn.
   */
  resolveTextAdapter?: () => Promise<TextAdapterConfig | null>;
  emitEvent?: EmitAgentTelemetryFn;
  /** Abort signal from the owning run — lets abort interrupt the queries. */
  abortSignal?: AbortSignal;
}

export class MemoryService {
  private manager: MemoryManager | null = null;
  private extractionInProgress = false;
  /** Latest extract request while one is running (coalesce; do not drop turns). */
  private pendingExtraction: MemoryExtractionInput | null = null;

  setManager(manager: MemoryManager): void {
    this.manager = manager;
  }

  getManager(): MemoryManager | null {
    return this.manager;
  }

  runExtraction(input: MemoryExtractionInput): void {
    if (!this.manager) return;
    if (this.extractionInProgress) {
      // Keep only the latest request — rapid turns should not drop the newest extract.
      this.pendingExtraction = input;
      input.emitEvent?.("memory:extract", { status: "queued" });
      return;
    }

    const llmMessages = input.getMessagesForLLM();
    // Prefer projected LLM view; fall back to a longer tail if projection is short.
    const MIN_MESSAGES_FOR_EXTRACT = 8;
    if (llmMessages.length < MIN_MESSAGES_FOR_EXTRACT) {
      input.emitEvent?.("memory:extract", { status: "skip-short", count: llmMessages.length });
      return;
    }

    const messages = llmMessages.slice(-80);
    const memoryManager = this.manager;
    const { emitEvent, log, resolveTextAdapter, abortSignal, usage } = input;

    this.extractionInProgress = true;
    emitEvent?.("memory:extract", { status: "start" });

    (async () => {
      try {
        const textAdapter = (await resolveTextAdapter?.()) ?? null;
        if (!textAdapter) {
          // No provider configured — skip rather than report a memory error.
          emitEvent?.("memory:extract", { status: "skip-no-adapter" });
          return;
        }

        const count = await extractMemories(messages, memoryManager, textAdapter, log ?? undefined, abortSignal, usage);
        if (count > 0) {
          await memoryManager.flushIndex();
          emitEvent?.("memory:extract", { status: "complete", count });
        } else {
          emitEvent?.("memory:extract", { status: "empty" });
        }

        const memoryCount = await memoryManager.getMemoryCount();
        if (memoryCount >= memoryManager.getConsolidateThreshold()) {
          emitEvent?.("memory:consolidate", { status: "start", count: memoryCount });
          const result = await consolidateMemories(memoryManager, textAdapter, log ?? undefined, usage);
          if (result.changed) {
            await memoryManager.flushIndex();
            emitEvent?.("memory:consolidate", {
              status: "complete",
              before: memoryCount,
              after: result.count,
            });
          } else {
            emitEvent?.("memory:consolidate", { status: "skip", count: memoryCount });
          }
        }
      } catch (err) {
        const errorMsg = errorMessage(err);
        emitEvent?.("memory:extract", { status: "error", error: errorMsg });
      } finally {
        this.extractionInProgress = false;
        const pending = this.pendingExtraction;
        this.pendingExtraction = null;
        if (pending) {
          this.runExtraction(pending);
        }
      }
    })();
  }

  /** Drop a queued extraction that has not started (session switch / new). */
  resetState(): void {
    this.pendingExtraction = null;
  }
}
