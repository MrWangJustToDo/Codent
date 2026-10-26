/**
 * MemoryService — memory state and the two operations the agent drives:
 *
 * - per-turn selection (`prefetchRelevantMemories`) — the query, the surfaced set, the pending
 *   commit and the telemetry all live here, so a session switch resets them through the same
 *   lifecycle hook as the rest of the conversation state. The built-in memory extension calls
 *   this per user turn and publishes the returned body as its `selection` section.
 * - end-of-turn extraction / consolidation (needs the finished turn's window + post-finalize
 *   scheduling, which an extension cannot express).
 */

import { extractMemories, consolidateMemories } from "../../agent/memory/memory-extractor.js";
import { extractUserQuery, findRelevantMemories, formatRelevantMemories } from "../../agent/memory/memory-retrieval.js";
import { defaultByteLength } from "../../env";
import { errorMessage } from "../../utils/errors.js";

import type { AgentLog } from "../../agent/agent-log";
import type { MemoryManager } from "../../agent/memory/memory-manager.js";
import type { MemoryPrefetchInput, MemorySelectionPort, MemoryTelemetry } from "../../agent/memory/types.js";
import type { TextAdapterConfig } from "../../models/adapter/adapter-factory.js";
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
  /** Abort signal from the owning run — lets abort interrupt the queries. */
  abortSignal?: AbortSignal;
}

export class MemoryService implements MemorySelectionPort {
  /**
   * Telemetry sink for the memory events, owned by the agent (the service is constructed by
   * `ManagedAgent`, which injects `emitEvent`). A standalone service (tests) may omit it.
   */
  constructor(private readonly emitEvent?: MemoryTelemetry) {}

  private manager: MemoryManager | null = null;
  private extractionInProgress = false;
  /** Latest extract request while one is running (coalesce; do not drop turns). */
  private pendingExtraction: MemoryExtractionInput | null = null;

  // ---- per-turn selection state (owned here, reset by the session lifecycle) ----
  private relevantContent = "";
  /** Filenames already injected in this session. */
  private alreadySurfaced = new Set<string>();
  /** This turn's selection, committed only once the model actually started responding. */
  private pendingSurfacedFilenames: string[] = [];

  setManager(manager: MemoryManager): void {
    this.manager = manager;
  }

  getManager(): MemoryManager | null {
    return this.manager;
  }

  // ==========================================================================
  // Per-turn selection (called by the built-in memory extension)
  // ==========================================================================

  getRelevantContent(): string {
    return this.relevantContent;
  }

  /**
   * Turn finalize: the injected body belongs to the turn that produced it, and so does an
   * uncommitted pending set. Clearing both here closes the window where a turn that never
   * produced an assistant message could have its selection committed by a later pump that
   * skips prepare.
   */
  clearTurnContext(): void {
    this.relevantContent = "";
    this.discardPendingSurfaced();
  }

  commitSurfacedMemories(): void {
    if (this.pendingSurfacedFilenames.length === 0) return;
    for (const filename of this.pendingSurfacedFilenames) this.alreadySurfaced.add(filename);
    this.pendingSurfacedFilenames = [];
  }

  /** The turn ended before it produced a message — do not mark its selection as shown. */
  discardPendingSurfaced(): void {
    this.pendingSurfacedFilenames = [];
  }

  async prefetchRelevantMemories(input: MemoryPrefetchInput): Promise<void> {
    const { messages, complete, signal, log } = input;
    const manager = this.manager;
    if (!manager) {
      this.emitEvent?.("memory:prefetch", { status: "skip-no-manager" });
      return;
    }

    if (signal?.aborted) {
      this.relevantContent = "";
      this.pendingSurfacedFilenames = [];
      this.emitEvent?.("memory:prefetch", { status: "aborted" });
      return;
    }

    const query = extractUserQuery(messages);
    if (!query.trim()) {
      this.relevantContent = "";
      this.pendingSurfacedFilenames = [];
      this.emitEvent?.("memory:prefetch", { status: "skip-no-query" });
      return;
    }

    try {
      const relevant = await findRelevantMemories(
        query,
        manager,
        complete,
        this.alreadySurfaced,
        {},
        manager.getEnv(),
        log
      );

      // An abort mid-call makes the helper fall back to keyword selection; that result belongs
      // to a turn nobody is waiting for, so drop it instead of injecting it.
      if (signal?.aborted) {
        this.relevantContent = "";
        this.pendingSurfacedFilenames = [];
        this.emitEvent?.("memory:prefetch", { status: "aborted" });
        return;
      }

      if (relevant.length === 0) {
        this.relevantContent = "";
        this.pendingSurfacedFilenames = [];
        this.emitEvent?.("memory:prefetch", { status: "empty" });
        return;
      }

      const content = formatRelevantMemories(relevant);
      this.relevantContent = content;
      this.pendingSurfacedFilenames = relevant.map((memory) => memory.filename);
      this.emitEvent?.("memory:prefetch", {
        status: "selected",
        count: relevant.length,
        filenames: this.pendingSurfacedFilenames,
        byteSize: defaultByteLength(content, "utf-8"),
      });
    } catch (err) {
      this.relevantContent = "";
      this.pendingSurfacedFilenames = [];
      this.emitEvent?.("memory:prefetch", { status: "error", error: errorMessage(err) });
    }
  }

  runExtraction(input: MemoryExtractionInput): void {
    if (!this.manager) return;
    if (this.extractionInProgress) {
      // Keep only the latest request — rapid turns should not drop the newest extract.
      this.pendingExtraction = input;
      this.emitEvent?.("memory:extract", { status: "queued" });
      return;
    }

    const llmMessages = input.getMessagesForLLM();
    // Prefer projected LLM view; fall back to a longer tail if projection is short.
    const MIN_MESSAGES_FOR_EXTRACT = 8;
    if (llmMessages.length < MIN_MESSAGES_FOR_EXTRACT) {
      this.emitEvent?.("memory:extract", { status: "skip-short", count: llmMessages.length });
      return;
    }

    const messages = llmMessages.slice(-80);
    const memoryManager = this.manager;
    const { log, resolveTextAdapter, abortSignal, usage } = input;

    this.extractionInProgress = true;
    this.emitEvent?.("memory:extract", { status: "start" });

    (async () => {
      try {
        const textAdapter = (await resolveTextAdapter?.()) ?? null;
        if (!textAdapter) {
          // No provider configured — skip rather than report a memory error.
          this.emitEvent?.("memory:extract", { status: "skip-no-adapter" });
          return;
        }

        const count = await extractMemories(messages, memoryManager, textAdapter, log ?? undefined, abortSignal, usage);
        if (count > 0) {
          await memoryManager.flushIndex();
          this.emitEvent?.("memory:extract", { status: "complete", count });
        } else {
          this.emitEvent?.("memory:extract", { status: "empty" });
        }

        const memoryCount = await memoryManager.getMemoryCount();
        if (memoryCount >= memoryManager.getConsolidateThreshold()) {
          this.emitEvent?.("memory:consolidate", { status: "start", count: memoryCount });
          const result = await consolidateMemories(memoryManager, textAdapter, log ?? undefined, usage);
          if (result.changed) {
            await memoryManager.flushIndex();
            this.emitEvent?.("memory:consolidate", {
              status: "complete",
              before: memoryCount,
              after: result.count,
            });
          } else {
            this.emitEvent?.("memory:consolidate", { status: "skip", count: memoryCount });
          }
        }
      } catch (err) {
        const errorMsg = errorMessage(err);
        this.emitEvent?.("memory:extract", { status: "error", error: errorMsg });
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

  /**
   * Reset conversation-scoped memory state for a new/restored session: the surfaced set, the
   * pending commit and the injected body must not leak across the switch. A queued extraction
   * that has not started is dropped too.
   */
  resetState(): void {
    this.relevantContent = "";
    this.pendingSurfacedFilenames = [];
    this.alreadySurfaced.clear();
    this.pendingExtraction = null;
  }
}
