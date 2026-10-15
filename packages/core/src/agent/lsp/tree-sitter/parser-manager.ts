/**
 * Tree-sitter Parser Manager — loads and caches WASM parsers per language.
 *
 * Uses `web-tree-sitter` (WASM) so it works in any runtime without native deps.
 * Grammar `.wasm` file bytes are provided by an injected locator (runtime-agnostic):
 * - Node hosts resolve `tree-sitter-wasms` from disk
 * - Browser hosts fetch from a URL or import
 *
 * `web-tree-sitter` is loaded lazily via dynamic `import()` so it never enters the
 * core bundle; hosts without the package degrade gracefully (`available() === false`).
 */

import type { Tree, Node, Language, Parser } from "web-tree-sitter";

export type { Tree, Node, Language };

/** Map language IDs to grammar file names (as shipped by tree-sitter-wasms). */
export const LANGUAGE_TO_GRAMMAR: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  typescriptreact: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  javascriptreact: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  scala: "tree-sitter-scala.wasm",
  swift: "tree-sitter-swift.wasm",
  lua: "tree-sitter-lua.wasm",
  bash: "tree-sitter-bash.wasm",
  json: "tree-sitter-json.wasm",
  html: "tree-sitter-html.wasm",
  css: "tree-sitter-css.wasm",
};

export interface TreeSitterEnv {
  /** Read a file's text content. */
  readFile(p: string): Promise<string>;
  /** Write a file's text content. */
  writeFile(p: string, content: string): Promise<void>;
  /** List directory entries (name + type flags). */
  readdir(p: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>>;
  /** Stat a path (size in bytes). */
  stat(p: string): Promise<{ size: number }>;
  /** Resolve a path (absolute). */
  resolve(...parts: string[]): string;
  /**
   * Locate a grammar WASM file and return its bytes or a loadable URL.
   * Return null when unavailable. Hosts without tree-sitter support omit this.
   */
  locateGrammar?(grammarFile: string): Promise<Uint8Array | string | null>;
}

interface CachedTree {
  tree: Tree;
  contentLength: number;
  hashHead: number;
  hashTail: number;
}

/** Minimal runtime surface of `web-tree-sitter` we depend on (dynamic import). */
interface WebTreeSitterModule {
  Parser: typeof Parser;
  Language: typeof Language;
}

interface ParserInstance {
  setLanguage(language: Language): void;
  parse(content: string): Tree | null;
  delete(): void;
}

export class TreeSitterManager {
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private ws: WebTreeSitterModule | null = null;
  private wsError: unknown = null;
  private languages: Map<string, Language> = new Map();
  private loadingLanguages: Map<string, Promise<Language | null>> = new Map();
  private parsers: Map<string, ParserInstance> = new Map();
  private cachedTrees: Map<string, CachedTree> = new Map();
  private locateGrammar: ((grammarFile: string) => Promise<Uint8Array | string | null>) | null;

  constructor(
    private env: TreeSitterEnv,
    private getLanguageIdFromPath: (filePath: string) => string | undefined
  ) {
    this.locateGrammar = env.locateGrammar ?? null;
  }

  /** Whether WASM parsing is available in this host (grammar locator + web-tree-sitter present). */
  available(): boolean {
    return this.locateGrammar != null;
  }

  /** Lazily load the web-tree-sitter module (never bundled into core). */
  private async loadModule(): Promise<WebTreeSitterModule | null> {
    if (this.ws) return this.ws;
    if (this.wsError) return null;
    try {
      // Dynamic import keeps web-tree-sitter out of the core bundle.
      const mod = (await import("web-tree-sitter")) as WebTreeSitterModule;
      this.ws = mod;
      return mod;
    } catch (err) {
      this.wsError = err;
      return null;
    }
  }

  /** Initialize web-tree-sitter WASM runtime. Must be called before any parsing. */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) {
      await this.initializing;
      return;
    }
    if (!this.locateGrammar) return;
    this.initializing = this.doInit();
    await this.initializing;
    this.initialized = true;
  }

  private async doInit(): Promise<void> {
    const mod = await this.loadModule();
    if (!mod) return;
    // `init` is a static method on the Parser class in web-tree-sitter.
    await mod.Parser.init();
  }

  /** Get the language ID for a file path based on extension. */
  getLanguageId(filePath: string): string | undefined {
    return this.getLanguageIdFromPath(filePath);
  }

  /** Check if we have a grammar available for a language. */
  hasGrammar(languageId: string): boolean {
    return languageId in LANGUAGE_TO_GRAMMAR;
  }

  /** Get all supported language IDs. */
  getSupportedLanguages(): string[] {
    return Object.keys(LANGUAGE_TO_GRAMMAR);
  }

  /** Load a language grammar, caching the result. */
  async getLanguage(languageId: string): Promise<Language | null> {
    const cached = this.languages.get(languageId);
    if (cached) return cached;

    const loading = this.loadingLanguages.get(languageId);
    if (loading) return loading;

    const grammarFile = LANGUAGE_TO_GRAMMAR[languageId];
    if (!grammarFile || !this.locateGrammar) return null;

    const loadPromise = (async (): Promise<Language | null> => {
      const mod = await this.loadModule();
      if (!mod) return null;
      try {
        const data = await this.locateGrammar!(grammarFile);
        if (data == null) return null;
        const language = await mod.Language.load(data);
        this.languages.set(languageId, language);
        return language;
      } catch {
        return null;
      } finally {
        this.loadingLanguages.delete(languageId);
      }
    })();

    this.loadingLanguages.set(languageId, loadPromise);
    return loadPromise;
  }

  /** Get or create a parser for a language. */
  private async getParser(languageId: string): Promise<ParserInstance | null> {
    const existing = this.parsers.get(languageId);
    if (existing) return existing;

    const language = await this.getLanguage(languageId);
    if (!language) return null;
    const mod = this.ws;
    if (!mod) return null;

    const parser = new mod.Parser();
    parser.setLanguage(language);
    this.parsers.set(languageId, parser);
    return parser;
  }

  /** Parse a file's content and return the tree. Caches by file path + content hash. */
  async parse(filePath: string, content: string): Promise<Tree | null> {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) return null;
    return this.parseWithLanguage(filePath, content, languageId);
  }

  /** Parse content with an explicit language ID. */
  async parseWithLanguage(filePath: string, content: string, languageId: string): Promise<Tree | null> {
    const length = content.length;
    const head = djb2Hash(content, 0, Math.min(length, 4096));
    const tail = length > 4096 ? djb2Hash(content, Math.max(0, length - 4096), length) : head;
    const cached = this.cachedTrees.get(filePath);
    if (cached && cached.contentLength === length && cached.hashHead === head && cached.hashTail === tail) {
      return cached.tree;
    }

    const parser = await this.getParser(languageId);
    if (!parser) return null;

    const tree = parser.parse(content);
    if (!tree) return null;

    if (cached) cached.tree.delete();
    this.cachedTrees.set(filePath, { tree, contentLength: length, hashHead: head, hashTail: tail });
    return tree;
  }

  /** Invalidate the cached tree for a file. */
  invalidate(filePath: string): void {
    const cached = this.cachedTrees.get(filePath);
    if (cached) {
      cached.tree.delete();
      this.cachedTrees.delete(filePath);
    }
  }

  /** Get a cached tree without re-parsing. */
  getCachedTree(filePath: string): Tree | null {
    return this.cachedTrees.get(filePath)?.tree ?? null;
  }

  /** Shut down — free all resources. */
  shutdown(): void {
    for (const [, cached] of this.cachedTrees) cached.tree.delete();
    this.cachedTrees.clear();
    for (const [, parser] of this.parsers) parser.delete();
    this.parsers.clear();
    this.languages.clear();
  }

  /** Alias for shutdown(). */
  dispose(): void {
    this.shutdown();
  }
}

/**
 * Fast non-cryptographic hash (djb2) over a range of a string.
 * Hashing head + tail separately gives collision resistance close to
 * a full-content hash without iterating every character of large files.
 */
function djb2Hash(str: string, start: number, end: number): number {
  let hash = 5381;
  for (let i = start; i < end; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}
