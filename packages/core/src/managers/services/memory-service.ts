/**
 * MemoryService — memory index state and per-turn memory operations.
 * Cross-subsystem data is passed in via input objects; no back-references to other services.
 */

import { extractTextFromContent } from "../../agent/compaction/message-utils.js";
import { extractMemories, consolidateMemories } from "../../agent/memory/memory-extractor.js";
import { findRelevantMemories, formatRelevantMemories } from "../../agent/memory/memory-retrieval.js";
import { defaultByteLength } from "../../env";
import { errorMessage } from "../../utils/errors.js";

import type { AgentLog } from "../../agent/agent-log";
import type { MemoryManager } from "../../agent/memory/memory-manager.js";
import type { TextAdapterConfig } from "../../models/adapter/adapter-factory.js";
import type { EmitAgentTelemetryFn } from "../telemetry/emit-agent-telemetry.js";
import type { UsageTracker } from "../telemetry/usage-tracker.js";
import type { ModelMessage } from "@tanstack/ai";

export interface MemoryPrefetchInput {
  messages: ModelMessage[];
  usage: UsageTracker;
  log: AgentLog | null;
  resolveTextAdapter?: () => Promise<TextAdapterConfig | null>;
  emitEvent?: EmitAgentTelemetryFn;
  /** Abort signal from the owning run — lets abort interrupt the selection LLM call. */
  abortSignal?: AbortSignal;
}

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
  private relevantContent = "";
  private alreadySurfaced = new Set<string>();
  private extractionInProgress = false;
  /** Latest extract request while one is running (coalesce; do not drop turns). */
  private pendingExtraction: MemoryExtractionInput | null = null;
  private pendingSurfacedFilenames: string[] = [];

  setManager(manager: MemoryManager): void {
    this.manager = manager;
  }

  getManager(): MemoryManager | null {
    return this.manager;
  }

  getRelevantContent(): string {
    return this.relevantContent;
  }

  clearTurnContext(): void {
    this.relevantContent = "";
  }

  commitSurfacedMemories(): void {
    if (this.pendingSurfacedFilenames.length > 0) {
      for (const f of this.pendingSurfacedFilenames) {
        this.alreadySurfaced.add(f);
      }
      this.pendingSurfacedFilenames = [];
    }
  }

  async prefetchRelevantMemories(input: MemoryPrefetchInput): Promise<void> {
    const { messages, usage, log, resolveTextAdapter, emitEvent, abortSignal } = input;
    if (!this.manager) {
      emitEvent?.("memory:prefetch", { status: "skip-no-manager" });
      return;
    }

    let query = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        query = extractTextFromContent(msg.content);
        break;
      }
    }

    if (!query.trim()) {
      this.relevantContent = "";
      emitEvent?.("memory:prefetch", { status: "skip-no-query" });
      return;
    }

    if (abortSignal?.aborted) {
      this.relevantContent = "";
      this.pendingSurfacedFilenames = [];
      emitEvent?.("memory:prefetch", { status: "aborted" });
      return;
    }

    try {
      const textAdapter = (await resolveTextAdapter?.()) ?? null;
      const relevant = await findRelevantMemories(
        query,
        this.manager,
        textAdapter,
        this.alreadySurfaced,
        {},
        usage,
        log ?? undefined,
        abortSignal,
        this.manager.getEnv()
      );

      if (relevant.length > 0) {
        this.relevantContent = formatRelevantMemories(relevant);
        this.pendingSurfacedFilenames = relevant.map((r) => r.filename);
        // Buffer only — captured into turnContextSnapshot at prepareForRun for system prompt.
        emitEvent?.("memory:prefetch", {
          status: "selected",
          count: relevant.length,
          filenames: this.pendingSurfacedFilenames,
          byteSize: defaultByteLength(this.relevantContent, "utf-8"),
        });
      } else {
        this.relevantContent = "";
        this.pendingSurfacedFilenames = [];
        emitEvent?.("memory:prefetch", { status: "empty" });
      }
    } catch (err) {
      const errorMsg = errorMessage(err);
      this.relevantContent = "";
      this.pendingSurfacedFilenames = [];
      emitEvent?.("memory:prefetch", { status: "error", error: errorMsg });
    }
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

  resetState(): void {
    this.relevantContent = "";
    this.pendingSurfacedFilenames = [];
    this.alreadySurfaced.clear();
    this.pendingExtraction = null;
  }
}
