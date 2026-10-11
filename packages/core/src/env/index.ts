/**
 * CoreEnv — runtime-agnostic environment abstraction.
 *
 * All Node.js (or browser/other runtime) APIs used by @codent/core are
 * accessed through this interface. The consumer registers an implementation
 * via {@link registerCoreEnv} before using any core functionality.
 *
 * @example
 * ```typescript
 * import { registerCoreEnv } from "@codent/core";
 * import { createNodeEnv } from "@codent/node";
 *
 * registerCoreEnv(createNodeEnv({ rootPath: "/path/to/project" }));
 * ```
 */

import * as pathe from "pathe";

import { runEnvTeardownHooks } from "./env-teardown.js";

import type { LspServerConfig, LspConnection } from "./env-lsp.js";
import type {
  CommandResult,
  CoreEnvShellInfo,
  FileEntry,
  RunCommandOptions,
  StartCommandHandle,
  StartCommandOptions,
} from "./env-types.js";
import type { IsolateDriver } from "@tanstack/ai-code-mode";

// ============================================================================
// Path Utilities (synchronous — pure computation, no I/O)
// ============================================================================

export interface CoreEnvPath {
  join(...parts: string[]): string;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  extname(p: string): string;
  resolve(...parts: string[]): string;
  normalize(p: string): string;
  isAbsolute(p: string): boolean;
  getSep(): string;
  parse(p: string): { root: string; dir: string; base: string; ext: string; name: string };
}

/**
 * Default path implementation using `pathe` (POSIX-style, works in any JS runtime).
 * Suitable for most environments. Consumers can override via {@link CoreEnv.path}.
 */
export const defaultPath: CoreEnvPath = {
  join: (...parts) => pathe.join(...parts),
  dirname: (p) => pathe.dirname(p),
  basename: (p, ext?) => pathe.basename(p, ext),
  extname: (p) => pathe.extname(p),
  resolve: (...parts) => pathe.resolve(...parts),
  normalize: (p) => pathe.normalize(p),
  isAbsolute: (p) => pathe.isAbsolute(p),
  getSep: () => "/",
  parse: (p) => pathe.parse(p),
};

// ============================================================================
// Encoding Utilities (synchronous — pure computation, no I/O)
// ============================================================================

/** Byte length of a UTF-8 string using TextEncoder. */
export function defaultByteLength(str: string, _encoding?: string): number {
  return new TextEncoder().encode(str).length;
}

/** Encode Uint8Array to base64 string. Works in all modern JS runtimes. */
export function defaultBase64Encode(data: Uint8Array): string {
  const chunkSize = 8192;
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...data.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(""));
}

/** Decode base64 string to Uint8Array. Works in all modern JS runtimes. */
export function defaultBase64Decode(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ============================================================================
// File System
// ============================================================================

export interface CoreEnvFsStat {
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtime: Date;
}

export interface CoreEnvFs {
  /** Read file as UTF-8 text (default). */
  readFile(path: string): Promise<string>;
  /** Read file as binary bytes. */
  readFile(path: string, encoding: "buffer"): Promise<Uint8Array>;
  readFile(path: string, encoding?: string): Promise<string | Uint8Array>;
  /** Get file/directory stats */
  stat(path: string): Promise<CoreEnvFsStat>;
  /** List direct children of a directory */
  readdir(path: string): Promise<FileEntry[]>;
  /** Create or overwrite a file (UTF-8 string or binary bytes), creating parent dirs when supported */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /** Create a directory (recursive by default) */
  mkdir(path: string): Promise<void>;
  /** Return whether a path exists */
  exists(path: string): Promise<boolean>;
  /** Remove a file or directory */
  remove(path: string): Promise<void>;
  /** Append content to a file */
  appendFile?(path: string, content: string): Promise<void>;
  /**
   * Rename/move a file, replacing any existing destination. Optional: hosts that
   * provide it make a whole-file rewrite crash-safe (write a sibling temp file,
   * then rename it into place) instead of truncating the destination in place.
   */
  rename?(oldPath: string, newPath: string): Promise<void>;
  /**
   * Synchronously append content to a file (creating parent dirs when
   * supported). Optional: only runtimes that can write synchronously (Node)
   * provide it. Used by crash/exit paths that cannot await an async write.
   */
  appendFileSync?(path: string, content: string): void;
  /** Synchronously create a directory (recursive). Paired with `appendFileSync`. */
  mkdirSync?(path: string): void;
  /** Synchronously test whether a path exists. Paired with `appendFileSync`. */
  existsSync?(path: string): boolean;
}

// ============================================================================
// Shell Execution
// ============================================================================

export interface CoreEnvExecOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string | undefined>;
}

export interface CoreEnvExecResult {
  stdout: string;
  stderr: string;
  /**
   * Process exit status, or `null` when the process never produced one.
   *
   * `null` is a real answer, not a placeholder: a killed child (timeout or abort) has no exit
   * status, and a binary that could not be launched never ran. Reporting a made-up number for
   * those cases is what let a timeout be read as the status `127` — which in turn read as
   * "binary not found". A host that cannot distinguish should say `null`, never a guess.
   */
  code: number | null;
  /**
   * True when the binary could not be launched at all — absent (`ENOENT`) or not executable
   * (`EACCES`). Distinct from a non-zero exit: the program never ran.
   */
  missing?: boolean;
  /** True when the child was terminated by a signal (timeout, abort, crash). */
  killed?: boolean;
}

/**
 * Options for {@link CoreEnv.execFile}.
 *
 * Deliberately does not include a shell: the point of `execFile` is that no shell is
 * involved, so arguments are never re-parsed, re-quoted, or subject to expansion.
 */
export interface CoreEnvExecFileOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

// ============================================================================
// MCP Stdio Transport (optional, Node.js only)
// ============================================================================

export interface McpStdioTransportConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * A handle to a child process spawned by the MCP stdio transport.
 * Used for cleanup/force-kill on shutdown.
 */
export interface McpProcessHandle {
  killed: boolean;
  kill(signal?: string): boolean;
}

// ============================================================================
// LSP Connection (optional, Node.js only)
// ============================================================================

/**
 * Runtime host hook for creating a Language Server connection.
 * Implemented by Node hosts (`@codent/node`); omitted by hosts without a
 * process/stdio runtime (browser, WebContainer). LSP tools feature-detect this
 * and degrade gracefully when absent.
 */
export interface LspConnectionFactory {
  (config: LspServerConfig): LspConnection;
}

// ============================================================================
// CoreEnv Interface
// ============================================================================

export interface CoreEnv {
  /** Workspace root path for agent file operations and default command cwd */
  rootPath: string;

  /**
   * Path utilities (synchronous, pure computation).
   * Defaults to `defaultPath` (POSIX-style via `pathe`) if not provided.
   */
  path?: CoreEnvPath;

  /** Platform identifier (async — may require server query) */
  getPlatform: () => Promise<string>;

  /** Architecture (async — may require server query) */
  getArch: () => Promise<string>;

  /** Environment variables (async — may require server query) */
  getEnv: () => Promise<Record<string, string | undefined>>;

  /** Home directory path (async — may require server query) */
  homedir(): Promise<string>;

  /**
   * Byte length of a string (synchronous, pure computation).
   * Defaults to `defaultByteLength` (TextEncoder-based) if not provided.
   */
  byteLength?: (str: string, encoding?: string) => number;

  /**
   * Encode Uint8Array to base64 string (synchronous, pure computation).
   * Defaults to `defaultBase64Encode` if not provided.
   */
  base64Encode?: (data: Uint8Array) => string;

  /**
   * Decode base64 string to Uint8Array (synchronous, pure computation).
   * Defaults to `defaultBase64Decode` if not provided.
   */
  base64Decode?: (str: string) => Uint8Array;

  /** File system operations (workspace-scoped, async — I/O) */
  fs: CoreEnvFs;

  /**
   * Execute a shell command in the workspace (foreground — awaits exit).
   * Normal non-zero exit codes are returned in {@link CommandResult} without throwing.
   */
  runCommand(command: string, options?: RunCommandOptions): Promise<CommandResult>;

  /**
   * Start a shell command in the background without awaiting exit.
   * Optional — hosts that do not support background jobs omit this; tools feature-detect.
   * Stream callbacks and {@link StartCommandHandle.kill} are provided by the adapter;
   * job id / buffers live in the core JobRegistry used by tools.
   */
  startCommand?(command: string, options?: StartCommandOptions): Promise<StartCommandHandle>;

  /** Execute a simple shell command */
  exec(command: string, options?: CoreEnvExecOptions): Promise<CoreEnvExecResult>;

  /**
   * Execute a process directly with an explicit argument vector — no shell involved.
   *
   * Exists so tools can launch external binaries without constructing shell command
   * strings. String-based execution cannot be made portable: shell syntax that is valid
   * for one shell is a parse error for another (e.g. `set -o pipefail` is not a
   * PowerShell option), so any tool that builds a command string has silently committed
   * to a single shell family. Arguments passed here are never re-parsed, quoted, or
   * expanded.
   *
   * Optional — hosts without a process runtime omit it, and tools must feature-detect and
   * fall back rather than assume it exists.
   */
  execFile?(file: string, args: string[], options?: CoreEnvExecFileOptions): Promise<CoreEnvExecResult>;

  /**
   * The shell this host will use to run command strings (optional).
   *
   * Used by command-safety to select a matching parser. Not a substitute for
   * {@link execFile}: it describes how `runCommand` behaves, not how tools should exec.
   */
  getShellInfo?(): Promise<CoreEnvShellInfo>;

  /** HTTP fetch (replaces global fetch for runtime agnosticism) */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;

  /** Lifecycle cleanup */
  destroy?(): Promise<void>;

  /** Get MIME type for a file path. Returns false/undefined if unknown. */
  getMimeType?(filePath: string): Promise<string | false>;

  /**
   * Create an MCP stdio transport (optional, Node.js only).
   * Returns an object compatible with `MCPClientConfig["transport"]`.
   */
  createMCPStdioTransport?(config: McpStdioTransportConfig): unknown;

  /**
   * Create a Language Server (LSP) connection (optional, Node.js only).
   * Implemented by Node hosts; omitted by hosts without a process/stdio runtime
   * (browser, WebContainer). LSP tools feature-detect and degrade gracefully.
   */
  createLspConnection?: LspConnectionFactory;

  /**
   * Probe whether a command is available on the host's PATH (optional).
   * Implemented by Node hosts; omitted by hosts without a process runtime.
   * Used by the LSP extension to skip servers whose binary is not installed
   * (probe-before-spawn) instead of failing after an ENOENT spawn error.
   */
  commandExists?(command: string): Promise<boolean>;

  /**
   * Locate a tree-sitter grammar WASM file and return its bytes or a URL to load.
   * Optional — implemented by hosts that bundle `tree-sitter-wasms` (Node) or serve
   * grammar files (browser). When omitted, tree-sitter tools degrade gracefully.
   * Returns `null` when the grammar file cannot be found.
   */
  locateTreeSitterGrammar?(grammarFile: string): Promise<Uint8Array | string | null>;

  /**
   * Downscale/compress an image buffer to fit a vision-token budget (optional).
   * Implemented by Node hosts via `sharp`; omitted by hosts without an image
   * codec (browser, WebContainer). Tools feature-detect and degrade gracefully
   * (oversized images are rejected instead of resized when unsupported).
   *
   * Returns a JPEG-encoded buffer of at most `maxWidth` pixels (aspect kept),
   * or `null` when the input cannot be decoded / the host cannot process it.
   */
  resizeImage?(buffer: Uint8Array, options: { maxWidth?: number; quality?: number }): Promise<Uint8Array | null>;

  /**
   * Extract the child process handle from an MCP stdio transport (optional).
   * Used for force-killing MCP servers on shutdown.
   */
  getMCPTransportProcess?(transport: unknown): McpProcessHandle | undefined;

  /**
   * Create an isolate driver for sandboxed TypeScript execution (code-mode).
   * Optional — implemented by Node hosts via `@tanstack/ai-isolate-node` (V8
   * isolate, native addon, requires Node >= 22); omitted by hosts without an
   * isolate runtime (browser, WebContainer) or when code-mode is disabled.
   * The code-mode extension feature-detects this and degrades gracefully
   * (does not register `execute_typescript`) when absent.
   */
  createIsolateDriver?(): Promise<IsolateDriver | null> | IsolateDriver | null;
}

// ============================================================================
// Registry
// ============================================================================

let _env: CoreEnv | null = null;

/** Resolved environment with all defaults applied (non-optional accessors). */
export interface ResolvedCoreEnv extends CoreEnv {
  path: CoreEnvPath;
  byteLength: (str: string, encoding?: string) => number;
  base64Encode: (data: Uint8Array) => string;
  base64Decode: (str: string) => Uint8Array;
}

/**
 * Register the runtime environment for @codent/core.
 *
 * Must be called before using any core functionality.
 * The consumer (CLI, browser app, etc.) provides all platform-specific APIs.
 * Fields like `path`, `byteLength`, `base64Encode`, `base64Decode` are optional
 * and will fall back to built-in defaults if not provided.
 *
 * @example
 * ```typescript
 * // In a Node.js CLI:
 * registerCoreEnv(createNodeEnv());
 *
 * // In a browser extension:
 * registerCoreEnv(createBrowserEnv());
 * ```
 */
export function registerCoreEnv(env: CoreEnv): void {
  _env = env;
}

/**
 * Clear the registered CoreEnv, preventing stale references after disconnect.
 * After calling this, {@link getEnv} will throw until a new env is registered.
 * Also best-effort kills any background command jobs.
 */
export function clearCoreEnv(): void {
  runEnvTeardownHooks();
  _env = null;
}

/**
 * Get the registered runtime environment with defaults applied.
 *
 * @throws if {@link registerCoreEnv} has not been called yet.
 */
export function getEnv(): ResolvedCoreEnv {
  if (!_env) {
    throw new Error(
      "CoreEnv not registered. Call registerCoreEnv() before using @codent/core. " +
        "See the CoreEnv interface for the required API surface."
    );
  }
  return {
    ..._env,
    path: _env.path ?? defaultPath,
    byteLength: _env.byteLength ?? defaultByteLength,
    base64Encode: _env.base64Encode ?? defaultBase64Encode,
    base64Decode: _env.base64Decode ?? defaultBase64Decode,
  };
}

/**
 * Check whether a CoreEnv has been registered.
 */
export function hasCoreEnv(): boolean {
  return _env !== null;
}
