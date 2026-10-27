/**
 * Memory Types - Type definitions for the persistent memory system.
 *
 * Memories are cross-session knowledge files stored in `.agents/memory/`.
 * Each memory is a markdown file with YAML frontmatter (same format as skills).
 */

import { z } from "zod";

import { AGENT_DATA_DIR } from "../../utils/workspace-paths.js";

import type { ResolvedCoreEnv } from "../../env";
import type { AgentEventPayloadMap } from "../../runtime-types/agent-event-payloads.js";
import type { ModelMessage } from "@tanstack/ai";

// ============================================================================
// Constants
// ============================================================================

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

export const DEFAULT_MEMORY_DIR = `${AGENT_DATA_DIR}/memory`;

export const MEMORY_INDEX_FILENAME = "MEMORY.md";

export const DEFAULT_CONSOLIDATE_THRESHOLD = 25;

/** Hard cap on memory count. If consolidation leaves more than this, oldest
 * memories (by updatedAt) are evicted. Prevents unbounded growth when the LLM
 * doesn't merge aggressively enough. */
export const DEFAULT_HARD_MAX_MEMORIES = 80;

export const DEFAULT_MAX_INDEX_LINES = 200;

export const DEFAULT_MAX_INDEX_BYTES = 25 * 1024; // 25 KB

/** Max relevant memories to inject per turn */
export const DEFAULT_MAX_RELEVANT_MEMORIES = 5;

/** Max lines per memory file when injecting full content */
export const DEFAULT_MAX_MEMORY_LINES_PER_FILE = 200;

/** Max bytes per memory file when injecting full content */
export const DEFAULT_MAX_MEMORY_BYTES_PER_FILE = 4096;

/** Max total bytes of injected memory content per session */
export const DEFAULT_MAX_SESSION_MEMORY_BYTES = 60 * 1024; // 60 KB

// ============================================================================
// Ports used by the memory queries (the extension's `ctx.llm`)
// ============================================================================

/**
 * One structured one-shot completion. The host owns the connection, the catalog, usage
 * attribution and the per-run budget — the memory code only supplies prompt + schema and reads
 * the validated value back.
 */
export interface MemoryCompletionRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  /** Zod (or Standard Schema) schema for the structured reply. */
  schema: unknown;
}

/** Resolve the completion to the schema-validated value; reject on transport/schema failure. */
export type MemoryCompletion = (request: MemoryCompletionRequest) => Promise<unknown>;

/** Minimal log port so the selection helpers stay independent of the extension logger. */
export interface MemoryLog {
  info(message: string): void;
  warn(message: string): void;
}

/** The telemetry events the memory service publishes through the agent's sink. */
export type MemoryTelemetryEvent = "memory:prefetch" | "memory:extract" | "memory:consolidate";

/** Host telemetry sink, typed by the same payload map the bus validates. */
export type MemoryTelemetry = <T extends MemoryTelemetryEvent>(type: T, data: AgentEventPayloadMap[T]) => void;

/**
 * One per-turn selection request.
 *
 * The state (surfaced set, pending commit, last injected content) lives in the owning
 * `MemoryService`, not in the extension: a session switch resets it through the same lifecycle
 * hook as every other conversation-scoped value, and the extension only supplies the live turn
 * facts (messages / signal / completion / log). Telemetry is the agent's own sink (the service is
 * owned by the agent), so the extension does not carry one.
 */
export interface MemoryPrefetchInput {
  /** Model-visible conversation for the current turn. */
  messages: readonly ModelMessage[];
  /** Structured one-shot completion (the extension's `ctx.llm`). */
  complete: MemoryCompletion;
  /** Run abort signal — checked before and after the side query. */
  signal?: AbortSignal;
  /** Optional log port (the extension's `ctx.logger`). */
  log?: MemoryLog;
}

/**
 * What the memory extension needs from `MemoryService`. Declared here (agent layer) so the
 * extension does not import `managers/`; the service implements this structurally.
 */
export interface MemorySelectionPort {
  prefetchRelevantMemories(input: MemoryPrefetchInput): Promise<void>;
  /** Body the selection section publishes; empty when this turn selected nothing. */
  getRelevantContent(): string;
  /** Mark this turn's selection as shown (first assistant message / turn boundary). */
  commitSurfacedMemories(): void;
  /** Drop the pending commit without marking it surfaced (abort / stream error). */
  discardPendingSurfaced(): void;
}

// ============================================================================
// Zod Schemas
// ============================================================================

export const memoryTypeSchema = z.enum(MEMORY_TYPES);

export const memoryMetadataSchema = z.object({
  name: z.string(),
  type: memoryTypeSchema,
  description: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  /** Relevance weight (0–1) used to prioritize during retrieval/eviction. Optional. */
  importance: z.number().min(0).max(1).optional(),
  /** ISO timestamp after which this memory should no longer be surfaced. Optional. */
  expiresAt: z.string().optional(),
});

export const memorySchema = z.object({
  name: z.string(),
  type: memoryTypeSchema,
  description: z.string(),
  body: z.string(),
  filename: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  importance: z.number().min(0).max(1).optional(),
  expiresAt: z.string().optional(),
});

// ============================================================================
// Types
// ============================================================================

export type MemoryType = z.infer<typeof memoryTypeSchema>;

export type MemoryMetadata = z.infer<typeof memoryMetadataSchema>;

export type Memory = z.infer<typeof memorySchema>;

export interface MemoryManagerConfig {
  /** Root path of the project */
  rootPath: string;
  /** Workspace env for memory I/O (runtime-provided; ambient by default). */
  env?: ResolvedCoreEnv;
  /** Memory directory name (relative to rootPath). Default: `.agents/memory` */
  memoryDir?: string;
  /** Trigger consolidation when file count exceeds this. Default: 25 */
  consolidateThreshold?: number;
  /** Max lines in MEMORY.md index. Default: 200 */
  maxIndexLines?: number;
  /** Max bytes in MEMORY.md index. Default: 25KB */
  maxIndexBytes?: number;
}
