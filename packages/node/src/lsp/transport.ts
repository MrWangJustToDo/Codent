/**
 * @codent/node LSP transport — spawn a Language Server and speak JSON-RPC over
 * its stdio streams using `vscode-languageserver-protocol/node` (vscode-jsonrpc).
 *
 * This is the Node.js implementation of `CoreEnv.createLspConnection`. The agent
 * core consumes the abstract `LspConnection` interface and never touches node
 * APIs directly, so the core stays runtime-agnostic.
 *
 * Messages are framed by vscode-jsonrpc's StreamMessageReader/Writer (Content-Length
 * headers) — the same framing used by LSP servers, VS Code, and the reference
 * pi-lsp-extension.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-languageserver-protocol/node";

import type { LspConnection, LspRequestOptions, LspServerConfig } from "@codent/core";
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
  PublishDiagnosticsParams,
} from "vscode-languageserver-protocol";

/**
 * How long a request may wait for a response before the host cancels it.
 *
 * Generous on purpose: a cold language server can take seconds to answer its first request while it
 * indexes, and the bound exists to stop a *wedged* server, not a slow one. `LspRequestOptions.timeoutMs`
 * overrides it per request.
 */
export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Create an LSP connection that spawns `config.command` as a child process and
 * performs the LSP `initialize` handshake over its stdio.
 */
export function createLspConnection(config: LspServerConfig): LspConnection {
  return new NodeLspConnection(config);
}

class NodeLspConnection implements LspConnection {
  readonly languageId: string;
  private config: LspServerConfig;
  private process: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private _serverCapabilities: ServerCapabilities | null = null;
  private _initialized = false;
  private _disposed = false;
  private unexpectedExitHandler: ((code: number | null) => void) | null = null;

  constructor(config: LspServerConfig) {
    this.config = config;
    this.languageId = "";
  }

  get initialized(): boolean {
    return this._initialized;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  get serverCapabilities(): ServerCapabilities | null {
    return this._serverCapabilities;
  }

  onUnexpectedExit(handler: (code: number | null) => void): void {
    this.unexpectedExitHandler = handler;
  }

  async start(): Promise<void> {
    if (this._initialized || this._disposed) return;
    await this.spawnDirect();
  }

  /** Register shared connection handlers (diagnostics push, workspace/config, errors). */
  private registerConnectionHandlers(): void {
    if (!this.connection) return;

    // Listen for published diagnostics — forward to the LSP manager's cache.
    this.connection.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) => {
      this.publishDiagnosticsHandler?.(params.uri, params.diagnostics ?? []);
    });

    // Handle workspace/configuration requests from the server (e.g. Intelephense).
    this.connection.onRequest("workspace/configuration", (params: { items: { section?: string }[] }) => {
      const settings = this.config.settings;
      return params.items.map((item) => {
        if (item.section && settings && item.section in settings) {
          return settings[item.section];
        }
        return {};
      });
    });

    this.connection.onError(([err]) => {
      console.error(`[LSP] Connection error: ${err.message}`);
    });

    this.connection.onClose(() => {
      if (!this._disposed) {
        this._initialized = false;
      }
    });
  }

  private publishDiagnosticsHandler: ((uri: string, diagnostics: unknown[]) => void) | null = null;

  /** Spawn the LSP server directly as a child process with stdio. */
  private async spawnDirect(): Promise<void> {
    const env = { ...process.env, ...this.config.env };

    // A project-local install resolves to Node's `node_modules/.bin`, which on Windows is a
    // `.cmd` shim. Since Node's CVE-2024-27980 hardening, `spawn` refuses to execute a
    // `.cmd`/`.bat` without `shell: true` and rejects with EINVAL — so an LSP server installed
    // as a devDependency could never start there. Only these extensions need the shell; every
    // other command (including `process.execPath`) is spawned directly, so the shell surface
    // stays as small as possible.
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(this.config.command);

    this.process = spawn(this.config.command, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: this.config.cwd,
      shell: useShell,
      windowsHide: true,
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error(`Failed to spawn LSP server: ${this.config.command}`);
    }

    // Wait for the process to spawn successfully (ENOENT arrives on 'error').
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(new Error(`Failed to spawn LSP server "${this.config.command}": ${err.message}`));
      };
      const cleanup = () => {
        this.process?.removeListener("spawn", onSpawn);
        this.process?.removeListener("error", onError);
      };
      this.process!.on("spawn", onSpawn);
      this.process!.on("error", onError);
    });

    // Discard stderr to prevent blocking.
    this.process.stderr?.resume();

    // Patch stdin.write to silently drop writes when the stream is destroyed or
    // the peer (LSP server) has exited — the server may exit while a
    // notification is in flight (EPIPE / ERR_STREAM_DESTROYED). vscode-jsonrpc
    // wraps this call in a Promise (ril WritableStreamWrapper.write), so an
    // EPIPE surfaces through the write callback as an unhandled rejection
    // unless filtered here; 'error' events only fire for callback-less writes.
    const stdin = this.process.stdin!;
    const originalWrite = stdin.write;
    stdin.write = function (this: typeof stdin, ...args: any[]): boolean {
      const hasCallback = typeof args[args.length - 1] === "function";
      const userCb = hasCallback ? (args.pop() as (...a: any[]) => void) : undefined;
      // Wrap the callback so a peer-gone error resolves instead of rejecting.
      const safeCb = (err?: Error | null) => {
        const code = (err as { code?: string } | null)?.code;
        if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END") {
          userCb?.(null);
          return;
        }
        userCb?.(err as Error);
      };
      if (this.destroyed || this.writableEnded || this.writableFinished) {
        if (userCb) process.nextTick(() => userCb(null));
        return false;
      }
      try {
        return originalWrite.apply(this, (hasCallback ? [...args, safeCb] : args) as any);
      } catch (err: any) {
        if (err?.code === "EPIPE" || err?.code === "ERR_STREAM_DESTROYED") {
          if (userCb) process.nextTick(() => userCb(null));
          return false;
        }
        throw err;
      }
    } as any;

    stdin.on("error", (err: any) => {
      if (err?.code === "EPIPE") return;
      console.error(`[LSP] stdin error: ${err.message}`);
    });

    this.process.on("error", (err) => {
      console.error(`[LSP] Process error: ${err.message}`);
      this._initialized = false;
      this.disposeConnection();
    });

    this.process.on("exit", (code) => {
      if (!this._disposed) {
        console.error(`[LSP] Server exited with code ${code}`);
        this._initialized = false;
        this.disposeConnection();
        this.unexpectedExitHandler?.(code);
      }
    });

    const reader = new StreamMessageReader(this.process.stdout);
    const writer = new StreamMessageWriter(this.process.stdin);
    this.connection = createMessageConnection(reader, writer);

    this.registerConnectionHandlers();

    this.connection.listen();

    // Initialize handshake
    const rootUri = pathToFileURL(this.config.cwd ?? process.cwd()).toString();
    const defaultFolder = {
      uri: rootUri,
      name: (this.config.cwd ?? process.cwd()).split("/").pop() ?? "workspace",
    };

    const initParams: InitializeParams = {
      processId: process.pid,
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          hover: { contentFormat: ["plaintext", "markdown"] },
          definition: {},
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: { prepareSupport: false },
          publishDiagnostics: { relatedInformation: true },
          completion: { completionItem: { snippetSupport: false } },
        },
        workspace: { workspaceFolders: true, symbol: {}, configuration: true },
      },
      rootUri,
      workspaceFolders: [defaultFolder],
      ...(this.config.initializationOptions ? { initializationOptions: this.config.initializationOptions } : {}),
    };

    const result: InitializeResult = await this.connection.sendRequest("initialize", initParams);
    this._serverCapabilities = result.capabilities;

    this.connection.sendNotification("initialized", {});
    this._initialized = true;
  }

  private disposeConnection(): void {
    try {
      if (this.connection) {
        this.connection.dispose();
      }
    } catch {
      // Already disposed or stream destroyed — ignore
    }
    this.connection = null;
  }

  sendRequest<R = unknown>(method: string, params?: unknown, options?: LspRequestOptions): Promise<R> {
    if (!this.connection || !this._initialized) {
      throw new Error(`LSP not initialized`);
    }
    const connection = this.connection;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
    const signal = options?.signal;

    // The request is issued with a cancellation token so an expiry can cancel it WITH the server
    // (`$/cancelRequest` — vscode-jsonrpc sends it when the token is cancelled): a server still
    // computing a completion nobody will read would otherwise hold the queue for the next request.
    const source = new CancellationTokenSource();

    return new Promise<R>((resolve, reject) => {
      let settled = false;
      // In a holder: `finish` has to clear the timer, and the timer's callback has to call `finish`,
      // so neither can be declared first as a `const`.
      const pending = { timer: undefined as ReturnType<typeof setTimeout> | undefined };

      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        if (pending.timer) clearTimeout(pending.timer);
        signal?.removeEventListener("abort", onAbort);
        settle();
      };

      const onAbort = () => {
        source.cancel();
        // Prefer the caller's reason, so `isAbortError(error, signal)` classifies this as the run's
        // cancellation rather than a server failure.
        const reason: unknown = signal?.reason;
        finish(() => reject(reason instanceof Error ? reason : new Error(`LSP request "${method}" was cancelled`)));
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      pending.timer = setTimeout(() => {
        source.cancel();
        finish(() => reject(new Error(`LSP request "${method}" timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      connection.sendRequest(method, params, source.token).then(
        (result) => finish(() => resolve(result as R)),
        (error) => finish(() => reject(error))
      );
    });
  }

  sendNotification(method: string, params?: unknown): void {
    if (!this.connection || !this._initialized) return;
    this.connection.sendNotification(method, params);
  }

  didOpen(uri: string, languageId: string, version: number, text: string): void {
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  didChange(uri: string, version: number, text: string): void {
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  didClose(uri: string): void {
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  async shutdown(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    this._initialized = false;

    try {
      if (this.connection) {
        const shutdownReq = this.connection.sendRequest("shutdown").catch(() => {});
        await Promise.race([shutdownReq, new Promise((resolve) => setTimeout(resolve, 3000))]);
        try {
          this.connection.sendNotification("exit");
        } catch {
          // Exit notification is best-effort; the server may already be gone.
        }
      }
    } catch {
      // Server may already be dead
    }
    this.disposeConnection();

    if (this.process) {
      this.process.kill("SIGTERM");
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 2000);
    }

    this.process = null;
  }

  kill(): void {
    if (this.process) {
      this.process.kill("SIGKILL");
    }
  }

  onPublishDiagnostics(handler: (uri: string, diagnostics: unknown[]) => void): void {
    this.publishDiagnosticsHandler = handler;
  }

  onRequest(method: string, handler: (params: unknown) => unknown): void {
    this.connection?.onRequest(method, handler as any);
  }
}
