/**
 * LSP Manager — manages LSP server connections, one per config record (see {@link LspFailureKind}'s
 * neighbour `serverKeyOf`): language ids that resolve to the same record share one process.
 *
 * Lazily starts servers on first use. Auto-detects language from file extension.
 * Connections are created via the host-provided `CoreEnv.createLspConnection`
 * factory (Node only); when absent, LSP tools degrade gracefully.
 */

import { errorMessage } from "../../utils/errors.js";

import { getLanguageIdFromPath } from "./language-map.js";
import { findLombokJar } from "./lombok.js";
import { pathToFileUri } from "./shared/format.js";
import { RESTART_INITIAL_BACKOFF_MS, RESTART_MAX_BACKOFF_MS, RESTART_MAX_ATTEMPTS } from "./shared/timing.js";

import type { LspConnection, LspServerConfig } from "../../env/lsp";

/** Minimal path helpers LspManager needs from the runtime host. */
export interface LspPathHelpers {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}

export interface LspDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** Minimal fs helpers LspManager needs from the runtime host. */
export interface LspFsHelpers {
  existsSync(p: string): boolean | Promise<boolean>;
  readFile(p: string, encoding: "utf-8"): Promise<string>;
  readdir?: (p: string) => Promise<LspDirEntry[]>;
}

export interface LspServerConfigRecord {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** LSP initializationOptions passed during the initialize handshake */
  initializationOptions?: Record<string, unknown>;
  /** Settings returned by workspace/configuration handler (keyed by section) */
  settings?: Record<string, unknown>;
}

/**
 * Why a server did not become ready.
 *
 * Data, not a message to match on. Only `start_failed` is a failure of the server; the other three are
 * a documented degrade (`command_missing` — tree-sitter takes over), a race (`start_abandoned` — the
 * session closed while the handshake was in flight), and work in progress (`restart_pending` — an
 * attempt failed while a retry is still scheduled). A caller left to guess from the text reports all
 * four the same way, which is how a startup that then succeeds reads as "failed, then ready".
 */
export type LspFailureKind = "command_missing" | "start_abandoned" | "restart_pending" | "start_failed";

/**
 * `JSON.stringify` with object keys sorted, so two equal values in a different field order serialize
 * identically. Records are built by three different paths (the default table, `.lsp.json` via
 * `JSON.parse`, `/lsp-config`), which do not agree on field order.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val === null || typeof val !== "object" || Array.isArray(val)) return val;
    const record = val as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((k) => [k, record[k]])
    );
  });
}

/** Lifecycle callbacks for UI notifications. */
export interface LspManagerCallbacks {
  onServerStart?: (languageId: string, command: string) => void;
  onServerReady?: (languageId: string) => void;
  onServerError?: (languageId: string, error: string, kind: LspFailureKind) => void;
  onServerCrash?: (languageId: string, restarting: boolean, attempt: number) => void;
}

/** Default server configurations for common languages. */
const DEFAULT_SERVERS: Record<string, LspServerConfigRecord> = {
  typescript: { command: "typescript-language-server", args: ["--stdio"] },
  javascript: { command: "typescript-language-server", args: ["--stdio"] },
  typescriptreact: { command: "typescript-language-server", args: ["--stdio"] },
  javascriptreact: { command: "typescript-language-server", args: ["--stdio"] },
  rust: { command: "rust-analyzer", args: [] },
  python: { command: "pyright-langserver", args: ["--stdio"] },
  go: { command: "gopls", args: ["serve"] },
  java: { command: "jdtls", args: [] },
  c: { command: "clangd", args: [] },
  cpp: { command: "clangd", args: [] },
  bash: { command: "bash-language-server", args: ["start"] },
  json: { command: "vscode-json-languageserver", args: ["--stdio"] },
  css: { command: "vscode-css-languageserver", args: ["--stdio"] },
  html: { command: "vscode-html-languageserver", args: ["--stdio"] },
  csharp: { command: "omnisharp", args: ["-lsp"] },
  lua: { command: "lua-language-server", args: [] },
  php: { command: "phpactor", args: ["language-server"] },
  ruby: { command: "solargraph", args: ["stdio"] },
  elixir: { command: "elixir-ls", args: ["--stdio"] },
  swift: { command: "sourcekit-lsp", args: [] },
};

export interface ServerStatus {
  languageId: string;
  command: string;
  running: boolean;
  diagnosticsCount: number;
  /** Whether the server binary was found on PATH (unknown when probing is unavailable). */
  available: boolean | null;
  /** Human-readable reason when the server is unavailable. */
  unavailableReason?: string;
}

/** A connected LSP client bound to one language. */
export interface LspClient {
  connection: LspConnection;
  languageId: string;
  command: string;
  /** Cached diagnostics per document URI. */
  diagnostics: Map<string, unknown[]>;
}

export class LspManager {
  private clients = new Map<string, LspClient>();
  private serverConfigs: Map<string, LspServerConfigRecord>;
  private rootDir: string;
  /**
   * In-flight starts, keyed by server. The value is the start's OUTCOME: `startServer` reports its own
   * failures and returns whether the server came up, so a caller that needs to know (the restart timer)
   * reads it instead of catching a rejection that would arrive after the failure was already reported.
   */
  private startingServers = new Map<string, Promise<boolean>>();
  /**
   * Memo of `languageId → server key`, cleared whenever the config map changes.
   *
   * The key is the whole config record: two ids with the identical record share ONE server process (the
   * default `typescript` / `javascript` / `typescriptreact` / `javascriptreact` quartet is the case that
   * matters), and a record differing in any field — settings, initializationOptions — gets its own.
   *
   * Canonical, because equal records do NOT necessarily serialize equally: `.lsp.json` keeps the text's
   * field order while `/lsp-config` builds `{ command, args }` and `loadProjectConfig` adds `env`. Field
   * order must not decide whether a process is shared — a mismatch would only cost an extra server, but it
   * would cost it silently.
   */
  private serverKeys = new Map<string, string>();
  private callbacks: LspManagerCallbacks;
  private getConnection: (config: LspServerConfig) => LspConnection;
  private shuttingDown = false;
  private restartAttempts = new Map<string, number>();
  private restartBackoff = new Map<string, number>();
  /**
   * Pending auto-restart timers, one per SERVER (they were keyed by language when a server served one).
   *
   * Owned by the manager (not fire-and-forget) for two reasons: a second crash notification while a
   * restart is already scheduled must not stack a second `startServer` on the same language, and
   * {@link shutdownAll} has to be able to cancel a restart — its callback's own `shuttingDown` check
   * is not enough, because that method clears the flag when it finishes, so a timer that fires
   * afterwards starts a server into a session that has already ended.
   */
  private restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lombokJarPath: string | null = null;
  private path: LspPathHelpers;
  private fs: LspFsHelpers;
  private getEnvVar: (key: string) => string | undefined;
  /** Optional command-existence probe (Node hosts); null when unavailable. */
  private commandExists: ((command: string) => Promise<boolean>) | null;
  /** Cache of probed commands (command → exists). */
  private commandProbeCache = new Map<string, boolean>();
  /**
   * Monotonic count of `publishDiagnostics` notifications per document URI.
   * Kept on the manager (not on the client) so it survives a server restart and
   * keeps increasing for the same URI.
   */
  private diagnosticsRevision = new Map<string, number>();

  constructor(
    rootDir: string,
    getConnection: (config: LspServerConfig) => LspConnection,
    pathHelpers: LspPathHelpers,
    fsHelpers: LspFsHelpers,
    customConfigs?: Record<string, LspServerConfigRecord>,
    callbacks?: LspManagerCallbacks,
    getEnvVar?: (key: string) => string | undefined,
    commandExists?: (command: string) => Promise<boolean>
  ) {
    this.rootDir = rootDir;
    this.getConnection = getConnection;
    this.path = pathHelpers;
    this.fs = fsHelpers;
    this.getEnvVar = getEnvVar ?? (() => undefined);
    this.commandExists = commandExists ?? null;
    this.serverConfigs = new Map(Object.entries({ ...DEFAULT_SERVERS, ...customConfigs }));
    this.callbacks = callbacks ?? {};
  }

  /** Replace the connection factory (e.g. when CoreEnv changes). */
  setConnectionFactory(factory: (config: LspServerConfig) => LspConnection): void {
    this.getConnection = factory;
  }

  /** Update or add a server configuration. */
  setServerConfig(languageId: string, config: LspServerConfigRecord): void {
    const previousKey = this.serverKeyOf(languageId);
    this.serverConfigs.set(languageId, config);
    // Invalidate any cached probe for this config's command.
    this.commandProbeCache.delete(config.command);
    // …and every cached server key: which ids share a process is derived from these records.
    this.serverKeys.clear();
    const nextKey = this.serverKeyOf(languageId);
    // Only when the RECORD actually changed is the running client no longer this id's server. Dropping the
    // alias unconditionally would be wrong for a no-op re-configuration (the same record re-applied, the
    // realistic trigger being `/lsp-config <lang> <the same command>`): the connection is still the one
    // this id resolves, and it is still in use by the sibling ids — the id would start a duplicate process
    // beside it, and the original would become an orphan that `shutdownAll` (which dedupes over
    // `clients`) could never shut down, so the child would outlive the session.
    //
    // When it DID change, the alias must go: without this, `/lsp status` reports the new command with
    // `running: true` against the old process, `getRunningClient` hands back the old connection, and
    // `getClientForLanguage` never starts the new config. The other ids still sharing the old record keep
    // it — the process is theirs, just not this id's any more.
    if (previousKey !== null && nextKey !== null && previousKey !== nextKey) {
      this.clients.delete(languageId);
    }
    this.dropOrphanedServerState(previousKey);
  }

  /**
   * Drop the per-server lifecycle state of a key that no language maps to any more.
   *
   * Required because that state is keyed by the config, not the id: an in-flight start or a scheduled
   * restart under a record nobody references would never be cleaned up (its own cleanup deletes the key it
   * captured, which no longer exists), and a settled `startingServers` entry is read as "starting" by
   * `isServerStarting` — whose contract is "do not block, return null so the tool shows starting" — so the
   * id would never get a client on a path with no timeout behind it.
   */
  private dropOrphanedServerState(key: string | null): void {
    if (key === null) return;
    if ([...this.serverConfigs.keys()].some((id) => this.serverKeyOf(id) === key)) return;
    this.startingServers.delete(key);
    this.restartAttempts.delete(key);
    this.restartBackoff.delete(key);
    const timer = this.restartTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.restartTimers.delete(key);
    }
  }

  /**
   * Probe whether a command exists on PATH. Caches the result; returns `null`
   * when no probe capability is available (non-Node hosts).
   */
  async probeCommand(command: string): Promise<boolean | null> {
    if (!this.commandExists) return null;
    const cached = this.commandProbeCache.get(command);
    if (cached !== undefined) return cached;
    const exists = await this.commandExists(command).catch(() => false);
    this.commandProbeCache.set(command, exists);
    return exists;
  }

  /** All configured languages. */
  getConfiguredLanguages(): string[] {
    return [...this.serverConfigs.keys()];
  }

  /** Resolve a file path to a language ID. */
  getLanguageId(filePath: string): string | undefined {
    return getLanguageIdFromPath(filePath);
  }

  /** Get a file URI from a path. */
  getFileUri(filePath: string): string {
    return pathToFileUri(this.resolvePath(filePath));
  }

  /** Resolve an absolute path from potentially relative input. */
  resolvePath(filePath: string): string {
    if (this.rootDir) {
      return this.path.resolve(this.rootDir, filePath);
    }
    return filePath;
  }

  /**
   * The identity of the server a language id resolves to, or `null` when it has no config.
   *
   * Everything that used to be keyed by language id and is really a property of the PROCESS — the
   * in-flight start, the restart budget, the pending-restart timer — is keyed by this instead, which is
   * what makes a second sharing id unable to start a duplicate and a crash charge the budget once.
   */
  private serverKeyOf(languageId: string): string | null {
    const cached = this.serverKeys.get(languageId);
    if (cached !== undefined) return cached === "" ? null : cached;
    const config = this.serverConfigs.get(languageId);
    const key = config ? canonicalJson(config) : "";
    this.serverKeys.set(languageId, key);
    return key === "" ? null : key;
  }

  /** Every language id served by the same server as `languageId`, including it. */
  private languagesForServer(languageId: string): string[] {
    const key = this.serverKeyOf(languageId);
    if (key === null) return [languageId];
    return [...this.serverConfigs.keys()].filter((id) => this.serverKeyOf(id) === key);
  }

  /** Get the client for a language ONLY if already running. */
  getRunningClient(languageId: string): LspClient | null {
    const existing = this.clients.get(languageId);
    if (existing && existing.connection.initialized && !existing.connection.disposed) {
      return existing;
    }
    return null;
  }

  /**
   * Wait for a language's server to be ready (kicking off startup if needed).
   *
   * Resolves with the running client once `initialize` completes, or `null` if
   * the server fails to start or the timeout elapses. Used by auto-diagnostics
   * so a first write that lazily starts the server still gets diagnostics
   * instead of silently skipping the injection.
   */
  async waitForClient(languageId: string, timeoutMs = 15000): Promise<LspClient | null> {
    const ready = this.getRunningClient(languageId);
    if (ready) return ready;

    // Kick off startup if no server is starting yet.
    if (!this.isServerStarting(languageId)) {
      await this.getClientForLanguage(languageId).catch(() => null);
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const client = this.getRunningClient(languageId);
      if (client) return client;
      // Startup finished but no client registered — failed or shut down.
      if (!this.isServerStarting(languageId) && !this.clients.has(languageId)) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  }

  /** Get the client for a file, starting the server if needed. */
  async getClientForFile(filePath: string): Promise<LspClient | null> {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) return null;
    return this.getClientForLanguage(languageId);
  }

  /** User-friendly message about why no client is available for a file. */
  getUnavailableReason(filePath: string): string {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) {
      return `No LSP server configured for file type: ${filePath}`;
    }
    const waitHint = this.getExpectedStartTime(languageId);
    if (this.isServerStarting(languageId)) {
      return `LSP server for ${languageId} is starting. ${waitHint} Retry shortly.`;
    }
    return `No LSP server available for: ${filePath}. If you just opened this project, call any LSP tool on a file to trigger server startup.`;
  }

  /** Estimated startup time hint for a language server. */
  private getExpectedStartTime(languageId: string): string {
    switch (languageId) {
      case "java":
        return "This typically takes 1-5 minutes for Java (project indexing).";
      case "rust":
        return "This typically takes 30s-2min for Rust (cargo metadata + indexing).";
      case "typescript":
      case "javascript":
      case "typescriptreact":
      case "javascriptreact":
        return "This typically takes 10-30s for TypeScript/JavaScript.";
      case "python":
        return "This typically takes 10-30s for Python.";
      case "go":
        return "This typically takes 10-30s for Go.";
      default:
        return "This may take a few seconds to a minute.";
    }
  }

  /** Is a server currently starting up for a language? */
  isServerStarting(languageId: string): boolean {
    const key = this.serverKeyOf(languageId);
    return key !== null && this.startingServers.has(key);
  }

  /** Get the client for a language, starting the server if needed. */
  async getClientForLanguage(languageId: string): Promise<LspClient | null> {
    // Already running?
    const existing = this.clients.get(languageId);
    if (existing && existing.connection.initialized && !existing.connection.disposed) {
      return existing;
    }

    // Already starting? Don't block — return null so tools show "starting" message. The lookup is by
    // server, so a sharing id also reports "starting" instead of spawning a duplicate process.
    const key = this.serverKeyOf(languageId);
    const starting = key === null ? undefined : this.startingServers.get(key);
    if (starting) return null;

    const config = this.serverConfigs.get(languageId);
    if (!config) return null;

    // Kick off server start in the background.
    const startPromise = this.startServer(languageId, config);
    if (key !== null) this.startingServers.set(key, startPromise);
    // `startServer` reports its own failures and returns their outcome; this catch only sees an
    // UNEXPECTED throw, which nothing else would report.
    startPromise.catch((err) => {
      if (key !== null) this.startingServers.delete(key);
      this.callbacks.onServerError?.(languageId, errorMessage(err), "start_failed");
    });

    return null; // Server not ready yet
  }

  /** Eagerly start servers for the given languages (fire-and-forget). */
  startEagerly(languageIds: string[]): void {
    for (const languageId of languageIds) {
      const existing = this.clients.get(languageId);
      if (existing && existing.connection.initialized && !existing.connection.disposed) continue;
      if (this.isServerStarting(languageId)) continue;

      const config = this.serverConfigs.get(languageId);
      if (!config) continue;

      const key = this.serverKeyOf(languageId);
      const startPromise = this.startServer(languageId, config);
      if (key !== null) this.startingServers.set(key, startPromise);
      // Only an UNEXPECTED throw lands here — `startServer` reports expected failures itself and returns
      // their outcome, so wrapping it must not add a second notice for the same failure.
      startPromise.catch((err) => {
        if (key !== null) this.startingServers.delete(key);
        this.callbacks.onServerError?.(languageId, `Auto-start failed: ${errorMessage(err)}`, "start_failed");
      });
    }
  }

  /** Build the config for creating a connection. */
  private async buildConnectionConfig(languageId: string, config: LspServerConfigRecord): Promise<LspServerConfig> {
    let args = [...config.args];
    let initializationOptions = config.initializationOptions;

    if (languageId === "java") {
      const lombokJar = await this.findLombokJarPath();
      if (lombokJar) {
        args = [`--jvm-arg=-javaagent:${lombokJar}`, ...args];
        if (!initializationOptions) {
          initializationOptions = {
            settings: { "java.jdt.ls.vmargs": `-javaagent:${lombokJar}` },
          };
        }
      }
    }

    return {
      command: config.command,
      args,
      env: config.env,
      cwd: this.rootDir,
      initializationOptions,
      settings: config.settings,
    };
  }

  private async findLombokJarPath(): Promise<string | null> {
    return findLombokJar({
      rootDir: this.rootDir,
      path: this.path,
      exists: async (p) => Boolean(await this.fs.existsSync(p)),
      readdir: this.fs.readdir ?? (async () => []),
      getEnvVar: this.getEnvVar,
      explicitJar: this.lombokJarPath,
    });
  }

  /**
   * Start the server for a language and report its outcome EXACTLY ONCE.
   *
   * Returns whether the server is ready. It deliberately does not reject for an expected failure: the
   * callers used to re-report every rejected start with their own wrapper text, so one failure produced two
   * notices — and the wrapper's `Auto-start failed: spawn … ENOENT` text does not match the not-found
   * pattern the notice classification keys on, turning a predictable degrade into an error as well.
   */
  private async startServer(languageId: string, config: LspServerConfigRecord): Promise<boolean> {
    const key = this.serverKeyOf(languageId);
    const clearStarting = () => {
      if (key !== null) this.startingServers.delete(key);
    };

    let connection: LspConnection | null = null;
    try {
      // Probe-before-spawn: skip starting when the binary is missing so we fail fast with a clear reason
      // instead of an ENOENT after spawn. No-op when the host provides no probe (browser hosts degrade
      // gracefully).
      if ((await this.probeCommand(config.command)) === false) {
        clearStarting();
        this.callbacks.onServerError?.(
          languageId,
          `LSP server '${config.command}' was not found on PATH. Install it or configure a different command in .lsp.json (or /lsp-config).`,
          "command_missing"
        );
        return false;
      }

      const connConfig = await this.buildConnectionConfig(languageId, config);
      this.callbacks.onServerStart?.(languageId, config.command);

      connection = this.getConnection(connConfig);
      connection.onUnexpectedExit((code) => this.handleUnexpectedExit(languageId, code));
      connection.onPublishDiagnostics((uri, diagnostics) => {
        const client = this.clients.get(languageId);
        if (client) {
          client.diagnostics.set(uri, diagnostics);
        }
        // Bump outside the client check: a publish means the server finished
        // analyzing the current document version, even when it reports no
        // problems (empty list). Waiters rely on this signal for clean files.
        this.diagnosticsRevision.set(uri, (this.diagnosticsRevision.get(uri) ?? 0) + 1);
      });

      await connection.start();
      const client: LspClient = {
        connection,
        languageId,
        command: config.command,
        diagnostics: new Map(),
      };
      // If a shutdown began while we were initializing, do not register the
      // client — tear the freshly-started connection down immediately instead.
      // Otherwise it would leak as a live child process until the next
      // session:shutdown (which may never come).
      if (this.shuttingDown) {
        connection.shutdown().catch(() => {});
        clearStarting();
        this.callbacks.onServerError?.(
          languageId,
          `LSP server for ${languageId} shut down during startup`,
          "start_abandoned"
        );
        return false;
      }
      // Register the client under EVERY language id this server serves, so a per-language lookup
      // (`clients.get(id)`, a tool call, `/lsp` status) keeps working for an id that did not start it.
      for (const shared of this.languagesForServer(languageId)) {
        this.clients.set(shared, client);
      }
      clearStarting();
      this.callbacks.onServerReady?.(languageId);
      if (key !== null) {
        this.restartAttempts.delete(key);
        this.restartBackoff.delete(key);
      }
      this.triggerPostInit(languageId, client);
      return true;
    } catch (err) {
      clearStarting();
      // A start can fail *after* the child was spawned (bad handshake, init error, timeout) or before one
      // exists (the connection factory, the config build). Dispose whatever was created so a process
      // cannot outlive the attempt, then report ONCE — this method is the only reporter.
      if (connection) {
        await connection.shutdown().catch(() => {});
        connection.kill();
      }
      const message = errorMessage(err);
      // Spawn ENOENT means the server binary isn't on PATH — translate to a
      // clear, actionable hint instead of a raw "spawn ... ENOENT" error.
      const notFound = /ENOENT|not found|No such file/i.test(message);
      const reason = notFound
        ? `Failed to start LSP server for ${languageId}: command '${config.command}' was not found on PATH. Install it or configure a different command in .lsp.json (or /lsp-config).`
        : `Failed to start LSP server for ${languageId} (${config.command}): ${message}`;
      this.callbacks.onServerError?.(languageId, reason, notFound ? "command_missing" : "start_failed");
      return false;
    }
  }

  /** Post-initialization hook for language-specific setup (e.g. Java build). */
  private triggerPostInit(languageId: string, client: LspClient): void {
    if (languageId === "java") {
      // java/buildWorkspace forces jdtls to rebuild and re-publish diagnostics.
      client.connection.sendRequest("java/buildWorkspace", true).catch(() => {
        // Not critical — diagnostics will just be stale until a file changes
      });
    }
  }

  /** Get status of all configured/running servers. */
  getStatus(): ServerStatus[] {
    const statuses: ServerStatus[] = [];
    for (const [languageId, config] of this.serverConfigs) {
      const client = this.clients.get(languageId);
      let diagnosticsCount = 0;
      if (client) {
        for (const diags of client.diagnostics.values()) {
          diagnosticsCount += diags.length;
        }
      }
      const available = this.commandProbeCache.get(config.command) ?? null;
      statuses.push({
        languageId,
        command: config.command,
        running: client?.connection.initialized === true && !client.connection.disposed,
        diagnosticsCount,
        available,
        unavailableReason:
          available === false
            ? `'${config.command}' not found on PATH — install it or configure a different command in .lsp.json`
            : undefined,
      });
      // Kick off background probing so the next /lsp call shows availability.
      if (available === null && this.commandExists) {
        void this.probeCommand(config.command).catch(() => {});
      }
    }
    return statuses;
  }

  /** Handle an unexpected server exit — auto-restart with exponential backoff. */
  private handleUnexpectedExit(languageId: string, _code: number | null): void {
    if (this.shuttingDown) return;

    // The process died for all of them: every alias must go, or the other ids keep handing back a
    // client whose transport is gone.
    const shared = this.languagesForServer(languageId);
    for (const alias of shared) this.clients.delete(alias);
    const key = this.serverKeyOf(languageId);
    if (key !== null) this.startingServers.delete(key);

    const attempts = key === null ? 0 : (this.restartAttempts.get(key) ?? 0);
    if (attempts >= RESTART_MAX_ATTEMPTS) {
      this.callbacks.onServerError?.(
        languageId,
        `LSP server for ${languageId} crashed ${attempts} times — giving up auto-restart`,
        "start_failed"
      );
      this.callbacks.onServerCrash?.(languageId, false, attempts);
      return;
    }

    const backoff =
      key === null ? RESTART_INITIAL_BACKOFF_MS : (this.restartBackoff.get(key) ?? RESTART_INITIAL_BACKOFF_MS);
    if (key !== null) {
      this.restartAttempts.set(key, attempts + 1);
      this.restartBackoff.set(key, Math.min(backoff * 2, RESTART_MAX_BACKOFF_MS));
    }

    this.callbacks.onServerCrash?.(languageId, true, attempts + 1);

    // One pending restart per SERVER: a second crash notification (the same process exiting twice, or a
    // crash while a restart is already scheduled) must not stack another `startServer` on it — and since
    // the aliases share the process, one restart serves all of them.
    const pendingRestart = key === null ? undefined : this.restartTimers.get(key);
    if (pendingRestart !== undefined) clearTimeout(pendingRestart);

    const timer = setTimeout(() => {
      if (key !== null) this.restartTimers.delete(key);
      if (this.shuttingDown) return;
      const config = this.serverConfigs.get(languageId);
      if (!config) return;

      // The key is re-derived here, not carried in: the config may have changed while the backoff ran, and
      // the entry must belong to the record this attempt actually starts.
      const attemptKey = this.serverKeyOf(languageId);
      const startPromise = this.startServer(languageId, config);
      if (attemptKey !== null) this.startingServers.set(attemptKey, startPromise);
      void startPromise.then((ready) => {
        if (ready) return;
        // The attempt reported its own failure (with the real kind); this adds only the retry's status —
        // which is not terminal while another attempt is still scheduled, so it is log-only upstream.
        this.callbacks.onServerError?.(
          languageId,
          `Auto-restart failed for ${languageId} — another attempt is scheduled`,
          "restart_pending"
        );
        this.handleUnexpectedExit(languageId, null);
      });
    }, backoff);
    if (key !== null) this.restartTimers.set(key, timer);
  }

  /** Shut down all clients AND any servers still mid-startup. */
  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;

    // Cancel scheduled restarts FIRST. Their callbacks check `shuttingDown`, but this method clears
    // it before returning, so a timer that fires afterwards would spawn a server into a session the
    // host has already put away.
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();

    // Shut down fully-registered clients — deduped by CONNECTION, because a shared server is
    // registered once per language id it serves and must not be shut down four times.
    const connections = new Set([...this.clients.values()].map((client) => client.connection));
    const shutdowns = [...connections].map((connection) => connection.shutdown().catch(() => {}));

    // Servers still in `startingServers` are not yet in `clients`; if a startup
    // was mid-handshake, `startServer` will detect `shuttingDown` once the
    // handshake resolves and tear itself down. Wait for those promises so no
    // child process is left behind.
    const startingPromises = [...this.startingServers.values()].map((p) => p.catch(() => {}));

    await Promise.all([...shutdowns, ...startingPromises]);
    this.clients.clear();
    this.startingServers.clear();
    // A full shutdown ends this manager's crash history: a server that crashed twice before must get
    // its whole restart budget back if the host starts it again, and the backoff must not resume at
    // whatever it had grown to.
    this.restartAttempts.clear();
    this.restartBackoff.clear();
    this.shuttingDown = false;
  }

  /** Restart a specific language server. */
  async restartServer(languageId: string): Promise<void> {
    // "Restart this language's server" — which, when the id shares a process, means restarting the
    // process for all of them: tearing down only this alias would leave the others handing back a
    // client whose transport is gone.
    const key = this.serverKeyOf(languageId);
    const aliases = this.languagesForServer(languageId);
    const existing = this.clients.get(languageId);
    if (existing) {
      await existing.connection.shutdown().catch(() => {});
      for (const alias of aliases) this.clients.delete(alias);
    }

    const pending = key === null ? undefined : this.startingServers.get(key);
    if (pending) {
      await pending.catch(() => {});
      if (key !== null) this.startingServers.delete(key);
    }

    const config = this.serverConfigs.get(languageId);
    if (!config) throw new Error(`No server configured for ${languageId}`);

    await this.startServer(languageId, config);
  }

  /** Set an explicit Lombok jar path (Java jdtls support). */
  setLombokJar(jarPath: string): void {
    this.lombokJarPath = jarPath;
  }

  /** Read a file's text content if it exists and is readable; null otherwise. */
  async readFileIfPossible(filePath: string): Promise<string | null> {
    const absPath = this.resolvePath(filePath);
    const ok = await this.fs.existsSync(absPath);
    if (!ok) return null;
    try {
      return await this.fs.readFile(absPath, "utf-8");
    } catch {
      return null;
    }
  }

  /** Get cached diagnostics for a file URI (empty array if none). */
  getDiagnostics(filePathOrUri: string): unknown[] {
    const uri = filePathOrUri.startsWith("file:") ? filePathOrUri : this.getFileUri(filePathOrUri);
    const client = this.getRunningClient(this.getLanguageIdFromUri(uri));
    if (!client) return [];
    return client.diagnostics.get(uri) ?? [];
  }

  /**
   * How many times the server has published diagnostics for this document.
   *
   * Callers snapshot this before syncing a file change and poll until it
   * advances, which is the signal that "the server re-analyzed this document".
   * Unlike waiting for errors to show up, it also resolves for clean files.
   */
  getDiagnosticsRevision(filePathOrUri: string): number {
    const uri = filePathOrUri.startsWith("file:") ? filePathOrUri : this.getFileUri(filePathOrUri);
    return this.diagnosticsRevision.get(uri) ?? 0;
  }

  /** Compute a path relative to the project root (POSIX-style, no node:path). */
  pathRelative(filePath: string): string {
    const abs = this.resolvePath(filePath);
    if (abs.startsWith(this.rootDir)) {
      return abs.slice(this.rootDir.length).replace(/^[/\\]/, "") || ".";
    }
    return abs;
  }

  /** Infer language id from a file:// URI (best-effort). */
  private getLanguageIdFromUri(uri: string): string {
    const pathPart = uri.replace(/^file:\/\//, "");
    return this.getLanguageId(pathPart) ?? "";
  }
}
