/**
 * Memory Types - Type definitions for the persistent memory system.
 *
 * Memories are cross-session knowledge files stored in `.agents/memory/`.
 * Each memory is a markdown file with YAML frontmatter (same format as skills).
 */

import { z } from "zod";

import type { ResolvedCoreEnv } from "../../env";

// ============================================================================
// Constants
// ============================================================================

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

export const DEFAULT_MEMORY_DIR = ".agents/memory";

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
