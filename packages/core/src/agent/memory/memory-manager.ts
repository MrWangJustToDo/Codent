/**
 * MemoryManager - Manages persistent cross-session memory files.
 *
 * Stores memories as markdown files with YAML frontmatter in `.agents/memory/`.
 * Auto-generates a `MEMORY.md` index that is injected per-turn as the
 * `<memory_index>` section by the built-in Memory extension.
 *
 * Uses this.env.fs for all I/O.
 *
 * @example
 * ```typescript
 * const manager = new MemoryManager({ rootPath: "/project" });
 * await manager.initialize();
 *
 * await manager.writeMemory("user-prefers-tabs", "user", "Prefers tabs", "Details...");
 * const index = manager.getIndexContent();
 * ```
 */

import { parse as parseYaml } from "yaml";

import { getEnv, type ResolvedCoreEnv } from "../../env";
import { truncateToUtf8Bytes } from "../../utils/bytes.js";
import { splitFrontmatter } from "../../utils/frontmatter.js";
import { slugifyName } from "../../utils/slug.js";

import { isExpiredMemory } from "./memory-expiry.js";
import {
  DEFAULT_CONSOLIDATE_THRESHOLD,
  DEFAULT_MAX_INDEX_BYTES,
  DEFAULT_MAX_INDEX_LINES,
  DEFAULT_MEMORY_DIR,
  MEMORY_INDEX_FILENAME,
  memoryMetadataSchema,
} from "./types.js";

import type { Memory, MemoryManagerConfig, MemoryMetadata, MemoryType } from "./types.js";

// ============================================================================
// Helpers
// ============================================================================

/** Extra write options for {@link MemoryManager.writeMemory}. */
export interface WriteMemoryOptions {
  /** Relevance weight (0–1) used to prioritize during retrieval/eviction. */
  importance?: number;
  /** ISO timestamp after which this memory should no longer be surfaced. */
  expiresAt?: string;
}

/** Quote a YAML scalar value to prevent injection from colons, newlines, etc. */
function yamlQuote(value: string): string {
  if (/[\n\r:#"'{}[\],&*!|>%@`]/.test(value) || value.startsWith(" ") || value.endsWith(" ")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }
  return value;
}

// ============================================================================
// MemoryManager Class
// ============================================================================

export class MemoryManager {
  private rootPath: string;
  private memoryDir: string;
  private memoryPath: string;
  private indexPath: string;
  private consolidateThreshold: number;
  private maxIndexLines: number;
  private maxIndexBytes: number;

  /** Cached index content for synchronous access in buildSystemPrompt() */
  private cachedIndex: string = "";

  /** Debounce timeout for index refresh */
  private refreshTimeout?: ReturnType<typeof setTimeout>;

  /** Workspace env for memory I/O (runtime-provided; ambient by default). */
  private readonly env: ResolvedCoreEnv;

  constructor(config: MemoryManagerConfig) {
    this.env = config.env ?? getEnv();
    this.rootPath = config.rootPath;
    this.memoryDir = config.memoryDir ?? DEFAULT_MEMORY_DIR;
    // placeholder
    this.memoryPath = this.memoryDir;
    this.indexPath = MEMORY_INDEX_FILENAME;
    this.consolidateThreshold = config.consolidateThreshold ?? DEFAULT_CONSOLIDATE_THRESHOLD;
    this.maxIndexLines = config.maxIndexLines ?? DEFAULT_MAX_INDEX_LINES;
    this.maxIndexBytes = config.maxIndexBytes ?? DEFAULT_MAX_INDEX_BYTES;
  }

  /** The owning runtime's env (for callers that need to thread it onward). */
  getEnv(): ResolvedCoreEnv {
    return this.env;
  }

  /**
   * Ensure the memory directory exists and load the initial index.
   * Awaits the first index refresh so `getIndexContent()` is usable immediately after.
   */
  async initialize(): Promise<void> {
    const { path } = this.env;
    this.memoryPath = path.join(this.rootPath, this.memoryDir);
    this.indexPath = path.join(this.memoryPath, MEMORY_INDEX_FILENAME);
    const exists = await this.env.fs.exists(this.memoryPath);
    if (!exists) {
      await this.env.fs.mkdir(this.memoryPath);
    }

    await this.refreshIndex();
  }

  // ============================================================================
  // Read Operations
  // ============================================================================

  /**
   * Get the cached MEMORY.md index content (synchronous).
   * This is what gets injected per-turn as the `<memory_index>` section by the
   * built-in Memory extension's `registerContextProvider`.
   */
  getIndexContent(): string {
    return this.cachedIndex;
  }

  /**
   * Read the full content of a specific memory file.
   */
  async readMemory(filename: string): Promise<string | null> {
    const filePath = this.env.path.join(this.memoryPath, filename);
    try {
      const exists = await this.env.fs.exists(filePath);
      if (!exists) return null;
      return await this.env.fs.readFile(filePath);
    } catch {
      return null;
    }
  }

  /**
   * List all memory files with parsed metadata.
   */
  async listMemories(): Promise<Memory[]> {
    const result: Memory[] = [];

    try {
      const entries = await this.env.fs.readdir(this.memoryPath);
      const mdFiles = entries
        .filter((e) => e.type === "file" && e.name.endsWith(".md") && e.name !== MEMORY_INDEX_FILENAME)
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of mdFiles) {
        try {
          const filePath = this.env.path.join(this.memoryPath, entry.name);
          const content = await this.env.fs.readFile(filePath);
          const { metadata, body } = this.parseFrontmatter(content);

          result.push({
            name: metadata?.name ?? entry.name.replace(/\.md$/, ""),
            type: metadata?.type ?? "user",
            description: metadata?.description ?? body.split("\n")[0]?.slice(0, 80) ?? "",
            body,
            filename: entry.name,
            createdAt: metadata?.createdAt,
            updatedAt: metadata?.updatedAt,
            importance: metadata?.importance,
            expiresAt: metadata?.expiresAt,
          });
        } catch {
          // Failed to parse memory file — skip
        }
      }

      return result;
    } catch {
      return [];
    }
  }

  /**
   * Get the count of memory files (excluding MEMORY.md).
   */
  async getMemoryCount(): Promise<number> {
    try {
      const entries = await this.env.fs.readdir(this.memoryPath);
      return entries.filter((e) => e.type === "file" && e.name.endsWith(".md") && e.name !== MEMORY_INDEX_FILENAME)
        .length;
    } catch {
      return 0;
    }
  }

  /**
   * Get the consolidation threshold.
   */
  getConsolidateThreshold(): number {
    return this.consolidateThreshold;
  }

  // ============================================================================
  // Write Operations
  // ============================================================================

  /**
   * Write a memory file with YAML frontmatter, then rebuild the index.
   */
  async writeMemory(
    name: string,
    type: MemoryType,
    description: string,
    body: string,
    options: WriteMemoryOptions = {}
  ): Promise<string> {
    const slug = slugifyName(name, { unicode: true, fallbackPrefix: "memory" });
    const filename = `${slug}.md`;
    const filePath = this.env.path.join(this.memoryPath, filename);

    const now = new Date().toISOString();

    // Check if file already exists to preserve createdAt
    let createdAt = now;
    let existingImportance: number | undefined;
    let existingExpiresAt: string | undefined;
    try {
      const existing = await this.env.fs.exists(filePath);
      if (existing) {
        const existingContent = await this.env.fs.readFile(filePath);
        const { metadata } = this.parseFrontmatter(existingContent);
        if (metadata?.createdAt) {
          createdAt = metadata.createdAt;
        }
        existingImportance = metadata?.importance;
        existingExpiresAt = metadata?.expiresAt;
      }
    } catch {
      // New file
    }

    // Prefer explicit option, else preserve existing value on update.
    const importance = options.importance !== undefined ? options.importance : existingImportance;
    const expiresAt = options.expiresAt !== undefined ? options.expiresAt : existingExpiresAt;

    const lines = [
      "---",
      `name: ${yamlQuote(name)}`,
      `type: ${type}`,
      `description: ${yamlQuote(description)}`,
      `createdAt: "${createdAt}"`,
      `updatedAt: "${now}"`,
    ];
    if (importance !== undefined) {
      lines.push(`importance: ${importance}`);
    }
    if (expiresAt) {
      lines.push(`expiresAt: "${expiresAt}"`);
    }
    lines.push("---", "", body, "");

    const content = lines.join("\n");

    await this.env.fs.writeFile(filePath, content);

    this.scheduleRefreshIndex();
    return filename;
  }

  /**
   * Delete a memory file, then rebuild the index.
   */
  async deleteMemory(filename: string): Promise<void> {
    const filePath = this.env.path.join(this.memoryPath, filename);
    try {
      await this.env.fs.remove(filePath);
    } catch {
      // Failed to delete memory
    }
    this.scheduleRefreshIndex();
  }

  /**
   * Delete all memory files (used during consolidation before rewriting).
   */
  async deleteAllMemories(): Promise<void> {
    try {
      const entries = await this.env.fs.readdir(this.memoryPath);
      for (const entry of entries) {
        if (entry.type === "file" && entry.name.endsWith(".md") && entry.name !== MEMORY_INDEX_FILENAME) {
          const filePath = this.env.path.join(this.memoryPath, entry.name);
          await this.env.fs.remove(filePath);
        }
      }
    } catch {
      // Failed to delete all memory files
    }
  }

  // ============================================================================
  // Index Management
  // ============================================================================

  /** Cancel the pending debounced index refresh. Safe to call more than once. */
  dispose(): void {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = undefined;
    }
  }

  /**
   * Immediately refresh the index, cancelling any pending debounced refresh.
   * Use after batch operations (extraction, consolidation) to ensure
   * `getIndexContent()` reflects the latest state before reading.
   */
  async flushIndex(): Promise<void> {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = undefined;
    }
    await this.refreshIndex();
  }

  /**
   * Schedule an index refresh with debounce (100ms).
   * When multiple writes/deletes happen in rapid succession (e.g., during
   * consolidation), only the final refresh actually runs, avoiding N+1
   * redundant `listMemories()` calls and file writes.
   */
  private scheduleRefreshIndex(): void {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
    this.refreshTimeout = setTimeout(() => {
      this.refreshTimeout = undefined;
      this.refreshIndex().catch(() => {
        // Failed to refresh index
      });
    }, 100);
  }

  /**
   * Rebuild the MEMORY.md index from all memory files, then update the cache.
   */
  async refreshIndex(): Promise<void> {
    const memories = (await this.listMemories()).filter((m) => !isExpiredMemory(m));
    const lines: string[] = [];

    for (const mem of memories) {
      lines.push(`- [${mem.name}](${mem.filename}) — ${mem.description}`);
      if (lines.length >= this.maxIndexLines) break;
    }

    const indexContent = lines.length > 0 ? lines.join("\n") + "\n" : "";

    const bytes = this.env.byteLength(indexContent, "utf-8");
    if (bytes > this.maxIndexBytes) {
      // Byte budget, not a character slice: `maxIndexBytes` is bytes, and a CJK index sliced at
      // that character count is up to ~3× the documented budget injected every turn.
      this.cachedIndex = truncateToUtf8Bytes(indexContent, this.maxIndexBytes, {
        lineBoundary: true,
        byteLength: (text) => this.env.byteLength(text, "utf-8"),
      }).text;
    } else {
      this.cachedIndex = indexContent;
    }

    // Write the index file
    try {
      await this.env.fs.writeFile(this.indexPath, this.cachedIndex);
    } catch {
      // Failed to write MEMORY.md index
    }
  }

  // ============================================================================
  // Frontmatter Parsing
  // ============================================================================

  /**
   * Parse YAML frontmatter from memory file content.
   * Reuses the same pattern as SkillLoader.parseFrontmatter().
   */
  private parseFrontmatter(text: string): { metadata: MemoryMetadata | null; body: string } {
    const split = splitFrontmatter(text);
    if (!split) {
      return { metadata: null, body: text.trim() };
    }

    try {
      const parsed = parseYaml(split.yaml);
      const validated = memoryMetadataSchema.safeParse(parsed);

      if (!validated.success) {
        return { metadata: null, body: text.trim() };
      }

      return { metadata: validated.data, body: split.body };
    } catch {
      return { metadata: null, body: text.trim() };
    }
  }
}
