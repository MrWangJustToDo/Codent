// Memory module exports
export { MemoryManager } from "./memory-manager.js";
export { extractMemories, consolidateMemories } from "./memory-extractor.js";
export type { ConsolidationResult } from "./memory-extractor.js";
export { findRelevantMemories, formatRelevantMemories, resolveSelectedMemoryFilename } from "./memory-retrieval.js";

// Built-in memory extension
export { createMemoryExtension, type MemoryExtensionConfig, type CreateMemoryExtensionOptions } from "./extension.js";
export {
  MEMORY_TYPES,
  DEFAULT_MEMORY_DIR,
  MEMORY_INDEX_FILENAME,
  DEFAULT_CONSOLIDATE_THRESHOLD,
  DEFAULT_HARD_MAX_MEMORIES,
  DEFAULT_MAX_INDEX_LINES,
  DEFAULT_MAX_INDEX_BYTES,
  DEFAULT_MAX_RELEVANT_MEMORIES,
  DEFAULT_MAX_MEMORY_LINES_PER_FILE,
  DEFAULT_MAX_MEMORY_BYTES_PER_FILE,
  DEFAULT_MAX_SESSION_MEMORY_BYTES,
  memoryTypeSchema,
  memoryMetadataSchema,
  memorySchema,
  type MemoryType,
  type MemoryMetadata,
  type Memory,
  type MemoryManagerConfig,
  type MemoryCompletion,
  type MemoryCompletionRequest,
  type MemoryLog,
  type MemoryTelemetry,
  type MemoryTelemetryEvent,
} from "./types.js";
export type { RelevantMemory, FindRelevantMemoriesOptions } from "./memory-retrieval.js";
