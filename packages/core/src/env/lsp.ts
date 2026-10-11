/**
 * LSP transport types — runtime-agnostic abstraction for a Language Server.
 *
 * The actual JSON-RPC transport (spawn + Content-Length framing) is provided by
 * the runtime host (e.g. `@codent/node` via `CoreEnv.createLspConnection`).
 * Core only defines the interface and consumes whatever the host injects, so the
 * agent core stays runtime-agnostic (browser / WebContainer hosts simply omit
 * `createLspConnection` and LSP tools degrade gracefully).
 *
 * Lives beside `env.ts` rather than under `agent/lsp/` because it is part of the
 * CoreEnv *port*: `env.ts` names these types in `createLspConnection`, and LSP is
 * consumed by `agent/` — so the shared declaration belongs below both, not inside
 * the consumer. The LSP *implementation* is still `agent/lsp/*`.
 */

/**
 * Configuration to start an LSP server process.
 * Mirrors the LSP client's needs: spawn a server binary, then do the initialize
 * handshake and exchange JSON-RPC messages over its stdio streams.
 */
export interface LspServerConfig {
  /** Command to start the LSP server (e.g. `typescript-language-server`). */
  command: string;
  /** Arguments passed to the server command. */
  args: string[];
  /** Extra environment variables (merged over the host env). */
  env?: Record<string, string>;
  /** Working directory for the server process. */
  cwd?: string;
  /** Optional initialization options sent during the LSP initialize handshake. */
  initializationOptions?: Record<string, unknown>;
  /** Optional settings returned for `workspace/configuration` requests (keyed by section). */
  settings?: Record<string, unknown>;
}

/** A parsed JSON-RPC message (LSP uses JSON-RPC over stdio with Content-Length headers). */
export interface LspMessage {
  jsonrpc: "2.0";
  /** Present for requests and responses. Absent for notifications. */
  id?: number | string | null;
  /** Request method or response result/error marker. */
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A live connection to a Language Server.
 * Wraps the host-provided transport and exposes the low-level JSON-RPC surface
 * the LSP client builds on (`initialize`, `textDocument/*`, `shutdown`, etc.).
 */
export interface LspConnection {
  /** The language this server handles (e.g. `typescript`). */
  readonly languageId: string;
  /** True once the `initialize` handshake has completed successfully. */
  readonly initialized: boolean;
  /** True once the connection has been shut down / disposed. */
  readonly disposed: boolean;

  /** Start the server process and perform the LSP initialize handshake. */
  start(): Promise<void>;

  /** Send a JSON-RPC request and await its response. */
  sendRequest<R = unknown>(method: string, params?: unknown): Promise<R>;

  /** Send a JSON-RPC notification (fire-and-forget). */
  sendNotification(method: string, params?: unknown): void;

  /** Notify the server a document was opened. */
  didOpen(uri: string, languageId: string, version: number, text: string): void;

  /** Notify the server a document changed (full-content sync). */
  didChange(uri: string, version: number, text: string): void;

  /** Notify the server a document was closed. */
  didClose(uri: string): void;

  /** Gracefully shut down the connection (shutdown request + exit, then kill). */
  shutdown(): Promise<void>;

  /** Forcefully kill the underlying process (no graceful shutdown). */
  kill(): void;

  /** Register a callback for server-pushed diagnostics (`textDocument/publishDiagnostics`). */
  onPublishDiagnostics(handler: (uri: string, diagnostics: unknown[]) => void): void;

  /** Register a handler for server-initiated requests (e.g. workspace/configuration). */
  onRequest(method: string, handler: (params: unknown) => unknown): void;

  /** Register a callback for unexpected process exit (not user-initiated shutdown). */
  onUnexpectedExit(handler: (code: number | null) => void): void;

  /** Server capabilities reported during the initialize handshake (may be null). */
  readonly serverCapabilities: unknown | null;
}
