/**
 * Workspace Index — project-wide symbol index with incremental updates.
 *
 * Walks the project tree, parses files with tree-sitter, and maintains
 * an in-memory symbol index keyed by name for fast lookup.
 *
 * Runtime-agnostic: filesystem access goes through the injected `env`.
 */

import { SKIP_DIRS, MAX_FILE_SIZE, MAX_INDEX_FILES } from "./constants.js";
import { extractSymbols, type SymbolInfo, type SymbolKindValue } from "./symbol-extractor.js";

import type { TreeSitterEnv, TreeSitterManager } from "./parser-manager.js";

export interface SymbolEntry {
  name: string;
  kind: SymbolKindValue;
  file: string; // absolute path
  line: number; // 1-indexed
}

export class WorkspaceIndex {
  /** Map from symbol name (lowercase) to entries */
  private index: Map<string, SymbolEntry[]> = new Map();
  /** Reverse index: file path → set of index keys that have entries for this file */
  private fileToKeys: Map<string, Set<string>> = new Map();
  /** Set of indexed file paths (absolute) */
  private indexedFiles: Set<string> = new Set();
  /** Whether the initial build has completed */
  private built = false;
  private building: Promise<void> | null = null;
  /**
   * Bumped whenever the index is reset. An in-flight `buildLocked()` from the previous root must not
   * land entries into the new one, so every async step checks the generation it started with.
   */
  private generation = 0;

  constructor(
    private rootDir: string,
    private treeSitter: TreeSitterManager,
    private env: TreeSitterEnv
  ) {}

  /** Build the index by walking the project tree. Deduplicates concurrent calls. */
  async build(): Promise<void> {
    if (this.built) return;
    if (this.building) {
      await this.building;
      return;
    }
    const generation = this.generation;
    this.building = this.buildLocked(generation);
    await this.building;
    if (generation === this.generation) this.built = true;
    if (generation === this.generation) this.building = null;
  }

  /**
   * Point the index at a new workspace root and drop everything indexed from the previous one.
   * The next `build()` re-walks; stale symbol hits from the old root were otherwise served for
   * the rest of the session after a cwd change.
   */
  reset(rootDir: string): void {
    this.rootDir = rootDir;
    this.generation += 1;
    this.index.clear();
    this.fileToKeys.clear();
    this.indexedFiles.clear();
    this.built = false;
    this.building = null;
  }

  private async buildLocked(generation: number): Promise<void> {
    const files = await this.collectFiles(this.rootDir);
    const batchSize = 50;
    for (let i = 0; i < files.length; i += batchSize) {
      if (generation !== this.generation) return;
      const batch = files.slice(i, i + batchSize);
      await Promise.all(batch.map((f) => this.indexFile(f, generation).catch(() => {})));
    }
  }

  /** Collect all indexable files under a directory */
  private async collectFiles(dir: string, collected: string[] = []): Promise<string[]> {
    if (collected.length >= MAX_INDEX_FILES) return collected;

    try {
      const entries = await this.env.readdir(dir);
      for (const entry of entries) {
        if (collected.length >= MAX_INDEX_FILES) break;

        if (entry.isDirectory) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          await this.collectFiles(this.env.resolve(dir, entry.name), collected);
        } else if (entry.isFile) {
          const languageId = this.treeSitter.getLanguageId(entry.name);
          if (languageId && this.treeSitter.hasGrammar(languageId)) {
            collected.push(this.env.resolve(dir, entry.name));
          }
        }
      }
    } catch {
      // Permission denied or other IO error — skip
    }

    return collected;
  }

  /** Index (or re-index) a single file. `generation` is set only by an in-flight `buildLocked`. */
  async indexFile(filePath: string, generation?: number): Promise<void> {
    const absPath = this.env.resolve(filePath);

    if (generation === undefined || generation === this.generation) this.removeFile(absPath);

    try {
      const stats = await this.env.stat(absPath);
      if (stats.size > MAX_FILE_SIZE) return;

      const content = await this.env.readFile(absPath);
      const languageId = this.treeSitter.getLanguageId(absPath);
      if (!languageId) return;

      const tree = await this.treeSitter.parse(absPath, content);
      if (!tree) return;
      if (generation !== undefined && generation !== this.generation) return;

      const symbols = extractSymbols(tree, languageId);
      this.addSymbols(absPath, symbols);
      this.indexedFiles.add(absPath);
    } catch {
      // File might not exist or be unreadable
    }
  }

  /** Index a file from already-available content (avoids re-reading) */
  async indexFileContent(filePath: string, content: string): Promise<void> {
    const absPath = this.env.resolve(filePath);
    this.removeFile(absPath);

    const languageId = this.treeSitter.getLanguageId(absPath);
    if (!languageId) return;

    const tree = await this.treeSitter.parse(absPath, content);
    if (!tree) return;

    const symbols = extractSymbols(tree, languageId);
    this.addSymbols(absPath, symbols);
    this.indexedFiles.add(absPath);
  }

  private addSymbols(filePath: string, symbols: SymbolInfo[]): void {
    for (const sym of symbols) {
      const entry: SymbolEntry = {
        name: sym.name,
        kind: sym.kind,
        file: filePath,
        line: sym.line,
      };
      const key = sym.name.toLowerCase();
      const existing = this.index.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        this.index.set(key, [entry]);
      }

      let keys = this.fileToKeys.get(filePath);
      if (!keys) {
        keys = new Set();
        this.fileToKeys.set(filePath, keys);
      }
      keys.add(key);

      if (sym.children) {
        this.addSymbols(filePath, sym.children);
      }
    }
  }

  /** Remove all entries for a file (O(keys-per-file) via reverse index) */
  removeFile(filePath: string): void {
    const absPath = this.env.resolve(filePath);
    this.indexedFiles.delete(absPath);

    const keys = this.fileToKeys.get(absPath);
    if (keys) {
      for (const key of keys) {
        const entries = this.index.get(key);
        if (!entries) continue;
        const filtered = entries.filter((e) => e.file !== absPath);
        if (filtered.length === 0) {
          this.index.delete(key);
        } else {
          this.index.set(key, filtered);
        }
      }
      this.fileToKeys.delete(absPath);
    }
  }

  /** Search for symbols matching a query (fuzzy) */
  search(query: string): SymbolEntry[] {
    if (!query) return [];
    const queryLower = query.toLowerCase();

    const exact = this.index.get(queryLower) ?? [];

    const fuzzy: SymbolEntry[] = [];
    for (const [key, entries] of this.index) {
      if (key === queryLower) continue;
      if (key.includes(queryLower)) {
        fuzzy.push(...entries);
      }
    }

    const results = [...exact, ...fuzzy];
    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === queryLower ? 0 : 1;
      const bExact = b.name.toLowerCase() === queryLower ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return a.name.length - b.name.length;
    });

    return results.slice(0, 100);
  }

  /** Get all symbols for a specific file */
  getSymbolsForFile(filePath: string): SymbolEntry[] {
    const absPath = this.env.resolve(filePath);
    const results: SymbolEntry[] = [];
    for (const entries of this.index.values()) {
      for (const entry of entries) {
        if (entry.file === absPath) results.push(entry);
      }
    }
    return results;
  }

  /** Get the set of indexed file paths */
  getIndexedFiles(): string[] {
    return [...this.indexedFiles];
  }

  /** Number of unique symbols in the index */
  get size(): number {
    return this.index.size;
  }

  /** Number of files indexed */
  get fileCount(): number {
    return this.indexedFiles.size;
  }
}
