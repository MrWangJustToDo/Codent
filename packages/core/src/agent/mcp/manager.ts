import { createMCPClient } from "@tanstack/ai-mcp";

import { getEnv } from "../../env";
import { toError } from "../../utils/errors.js";

import { wrapMcpToolForMultimodalContent } from "./prefer-multimodal-content.js";
import { resolveServerPolicy } from "./types.js";

import type { McpConfigSourceKind } from "./options.js";
import type {
  McpApprovalMode,
  McpConfig,
  McpElicitAnswer,
  McpElicitHook,
  McpServerConfig,
  McpServerPolicy,
} from "./types.js";
import type { McpProcessHandle, ResolvedCoreEnv } from "../../env";
import type { McpServerStatus } from "../../runtime-types/mcp-status.js";
import type { AnyServerTool } from "@tanstack/ai";
import type { MCPClient, MCPClientOptions, ToolAnnotations, TransportInput } from "@tanstack/ai-mcp";

// ============================================================================
// McpServerStatus — public data for display in CLI /mcp command
// ============================================================================

// Declared in runtime-types (the shared leaf) so event payloads can name it without
// importing this module; re-exported here because this is where it is produced.
export type { McpServerStatus };

export type McpToolsRecord = Record<string, AnyServerTool>;

/** How many undrained diagnostics the manager keeps before dropping the oldest (see `note`). */
const MAX_BUFFERED_DIAGNOSTICS = 50;

// ============================================================================
// Approval policy
// ============================================================================

/** The slice of an MCP tool definition the approval rule reads. */
type AnnotatedTool = { annotations?: ToolAnnotations };

/**
 * Whether one server tool must be approved before it runs.
 *
 * Order is deliberate: an explicit per-server mode wins, then `destructiveHint` (a server that
 * claims both read-only and destructive is not evidence of safety), then `readOnlyHint`, then the
 * fail-closed default. `annotations` are server claims, not guarantees — `approval: "always"` exists
 * for servers we do not trust to describe themselves.
 */
export function deriveNeedsApproval(tool: AnnotatedTool, mode: McpApprovalMode): boolean {
  if (mode === "never") return false;
  if (mode === "always") return true;
  const annotations = tool.annotations;
  if (annotations?.destructiveHint === true) return true;
  if (annotations?.readOnlyHint === true) return false;
  // Absent (or contradictory-but-not-destructive) metadata: gate. "The server did not say
  // read-only" is not evidence that it is, and an older server may send no annotations at all.
  return true;
}

// ============================================================================
// Transport Factory
// ============================================================================

/** Display fields for one server entry, whichever transport it uses. */
function transportDetails(config: McpServerConfig): { command?: string; args?: string[]; url?: string } {
  return config.transport === "stdio" ? { command: config.command, args: config.args } : { url: config.url };
}

/**
 * Client capabilities with `elicitation` removed — the only spelling that works.
 *
 * `@tanstack/ai-mcp` builds `{ elicitation: { form: {} }, sampling: {}, ...clientOptions?.capabilities }`,
 * so it spreads its defaults FIRST: a spread cannot delete a key, and `{ sampling: {} }` therefore
 * leaves `elicitation` declared (measured: `JSON.stringify` → `{"elicitation":{"form":{}},"sampling":{}}`).
 * An own key whose value is `undefined` does overwrite the default, and JSON drops that member, so
 * this states "no elicitation" on the wire. `validate:mcp-client` mirrors the SDK's merge, asserts
 * the installed SDK still holds those defaults, and asserts the serialized result.
 */
function withoutElicitationCapability(): MCPClientOptions["clientOptions"] {
  return { capabilities: { elicitation: undefined } } as MCPClientOptions["clientOptions"];
}

function createTransportInput(env: ResolvedCoreEnv, config: McpServerConfig): TransportInput {
  if (config.transport === "stdio") {
    if (!env.createMCPStdioTransport) {
      throw new Error(
        "Stdio MCP transport is not available in this environment. " +
          "Use SSE or HTTP transport, or provide createMCPStdioTransport in CoreEnv."
      );
    }
    return env.createMCPStdioTransport({
      command: config.command,
      args: config.args,
      env: config.env,
    }) as TransportInput;
  }
  return {
    type: config.transport,
    url: config.url,
    headers: config.headers,
  };
}

/**
 * Answer one server's request.
 *
 * Module-level (not a method) so the same rule is reachable from `mcpClientOptions` and therefore
 * from `validate:mcp-client`: a throwing hook becomes `decline` with the error recorded, because a
 * hook that fails must neither turn a tool call into a hang nor be read as consent.
 *
 * The hook is required: the handler is only registered when elicitation is advertised (see
 * {@link mcpClientOptions}), so there is no "no hook" case to answer here.
 */
async function answerElicitationWith(
  hook: McpElicitHook,
  server: string,
  params: unknown,
  note: (message: string) => void
): Promise<McpElicitAnswer> {
  try {
    const answered = await hook({ server, params });
    return typeof answered === "string" ? { action: answered } : answered;
  } catch (error) {
    note(`MCP server "${server}" elicit hook failed; declined: ${toError(error).message}`);
    return { action: "decline" };
  }
}

/**
 * Client options for one server: approval policy, the honest capability set, and the elicit hook.
 *
 * Exported so `validate:mcp-client` asserts the object the manager actually sends, instead of a
 * copy of the wiring that could drift from it.
 */
export function mcpClientOptions(
  server: string,
  transport: TransportInput,
  policy: McpServerPolicy,
  elicit?: McpElicitHook,
  note: (message: string) => void = () => undefined
): MCPClientOptions {
  return {
    transport,
    name: `codent-mcp-${server}`,
    prefix: `mcp__${server}_`,
    // Approval is derived per tool from the server's own annotations, with the config override
    // applied first. See `deriveNeedsApproval` for the ordering.
    needsApproval: (tool: AnnotatedTool) => deriveNeedsApproval(tool, policy.approval),
    // The handler and the capability are ONE decision. Measured against
    // `@modelcontextprotocol/client` 2.3.1: `setRequestHandler("elicitation/create")` throws
    // `CAPABILITY_NOT_SUPPORTED` when the capability is not declared, so wiring a handler under an
    // honest handshake would fail every MCP connection at construction. Without a hook we declare
    // nothing and register nothing; a server that asks anyway gets that protocol error as its
    // answer — still an answer, and the tool fails instead of parking.
    ...(elicit
      ? { onElicit: (params: unknown) => answerElicitationWith(elicit, server, params, note) }
      : { clientOptions: withoutElicitationCapability() }),
  };
}

// ============================================================================
// McpManager
// ============================================================================

/** Runtime-supplied hooks. An absent hook means the matching capability is not advertised. */
export interface McpManagerOptions {
  /**
   * Answers `elicitation/create` for any connected server.
   *
   * Supplying it is what lets the client advertise the capability: without a handler the
   * handshake must not claim it (see {@link McpManager.initialize}). Hosts supply this; core does
   * not, because answering means showing UI and the UI is per host.
   */
  elicit?: McpElicitHook;
}

export class McpManager {
  /** Workspace env for stdio transports (runtime-provided; ambient by default). */
  constructor(
    private readonly env: ResolvedCoreEnv = getEnv(),
    private readonly options: McpManagerOptions = {}
  ) {}

  private clients: Map<string, MCPClient> = new Map();
  private stdioTransports: unknown[] = [];

  /**
   * Bumped by every `initialize`, `shutdown` and `forceKill`; a connect that started under an older
   * generation must not write into the current incarnation.
   *
   * `initialize` awaits `createMCPClient` and `client.tools()`. Activation is bounded by a callback
   * timeout, so a teardown can run while a connect is still in flight — and that continuation used
   * to `clients.set(...)` into the just-cleared map, resurrecting a live client (and a "connected"
   * status) on a manager the extension had already discarded.
   *
   * A single `closed` boolean was an ABA: disable→re-enable resets it to `false`, so a continuation
   * from the FIRST activation looked live again, and a shutdown in flight could clear the NEW
   * incarnation's state. The counter survives both.
   */
  private generation = 0;

  private serverStatuses: Map<string, McpServerStatus> = new Map();

  /**
   * Diagnostics this manager could not report itself (no logger here).
   *
   * Drained by the MCP extension after `initialize` when no live sink is installed, so a declined
   * elicitation or a rejected policy value lands in `agent.log` instead of disappearing.
   */
  private notes: string[] = [];

  /** Live destination for diagnostics, when a host installed one (see {@link setDiagnosticSink}). */
  private diagnosticSink?: (message: string) => void;

  /**
   * Route diagnostics to a live sink (the extension's logger).
   *
   * With a sink, notes go out as they happen: a declined elicitation belongs next to the tool call
   * that hit it, not at the next activation. Without one they are buffered for
   * {@link takeDiagnostics}, because the manager has no logger of its own and a refusal must not
   * vanish silently.
   */
  setDiagnosticSink(sink?: (message: string) => void): void {
    this.diagnosticSink = sink;
  }

  /** Record one diagnostic through the installed sink, or buffer it. */
  private note(message: string): void {
    if (this.diagnosticSink) {
      this.diagnosticSink(message);
      return;
    }
    // Bounded: a manager used without a sink (a host that never installs one, or a request arriving
    // after teardown) would otherwise grow one line per declined elicitation for the process
    // lifetime. The last lines are the useful ones.
    this.notes.push(message);
    if (this.notes.length > MAX_BUFFERED_DIAGNOSTICS) this.notes.shift();
  }

  /** Whether this runtime can answer an `elicitation/create` request. */
  isElicitationAvailable(): boolean {
    return typeof this.options.elicit === "function";
  }

  /** Drain collected diagnostics (each is one log line). */
  takeDiagnostics(): string[] {
    const drained = this.notes;
    this.notes = [];
    return drained;
  }

  /**
   * Server-provided usage instructions captured from the MCP connect handshake
   * (`MCPClient.instructions`, `@tanstack/ai-mcp` 0.8+). Surfaced to the model as a
   * turn-context section so a server can describe how to use its tools without each
   * of its tool descriptions having to repeat it.
   */
  private serverInstructions: Map<string, string> = new Map();

  /**
   * Config file path (explicit or resolved default) used to load MCP servers,
   * and the actual source path that was loaded. Recorded by the MCP extension
   * (or any loader) so session-bootstrap telemetry can report where config came
   * from without re-deriving it in the factory.
   *
   * Both fields are PATH-semantic (`/mcp` renders them as paths), so a session whose
   * servers came from its create options must NOT write a marker like `"session-options"`
   * into either — it records {@link configSourceKind} instead and leaves these unset.
   */
  private configPathValue?: string;
  private configLoadedFromValue?: string;
  private configSourceKindValue: McpConfigSourceKind = "file";

  /** Explicit path passed by the caller (may be a default lookup). */
  get configPath(): string | undefined {
    return this.configPathValue;
  }

  /** Actual file that was loaded (differs from configPath when defaults are used). */
  get configLoadedFrom(): string | undefined {
    return this.configLoadedFromValue;
  }

  /**
   * Where this session's servers came from. `"session-options"` means the caller supplied
   * them at create time, which is why no config file applied.
   */
  get configSourceKind(): McpConfigSourceKind {
    return this.configSourceKindValue;
  }

  /** Record the config source for session-bootstrap telemetry. */
  setConfigSource(configPath: string | undefined, loadedFrom: string | undefined): void {
    this.configPathValue = configPath;
    this.configLoadedFromValue = loadedFrom;
  }

  /**
   * Record that the servers came from the session's create options (not a file).
   *
   * A separate setter rather than a third parameter on {@link setConfigSource}: the two
   * existing parameters are paths and are rendered as paths, so a source that is not a file
   * cannot be expressed through them without lying about one of them.
   */
  setConfigSourceKind(kind: McpConfigSourceKind): void {
    this.configSourceKindValue = kind;
  }

  /**
   * Connect to all configured MCP servers and return TanStack {@link ServerTool} records.
   * Failed connections are logged but do not block other servers.
   */
  async initialize(config: McpConfig): Promise<McpToolsRecord> {
    // A re-enable calls `initialize` again on the same manager (the extension instance survives a
    // disable), and each call takes a new generation; any continuation from an older one is stale
    // (see `generation`).
    const generation = ++this.generation;
    const isStale = (): boolean => generation !== this.generation;
    // A fresh activation must not inherit the previous one's reported servers.
    this.serverStatuses.clear();
    this.serverInstructions.clear();
    const allTools: McpToolsRecord = {};
    const servers = Object.entries(config.mcpServers) as [string, McpServerConfig][];

    // Connect to all servers in parallel (serial per-server awaits slow down
    // startup and hide slow servers behind fast ones). Each server keeps its
    // own error signal in `serverStatuses` and a failure never blocks others.
    await Promise.allSettled(
      servers.map(async ([name, serverConfig]) => {
        const base = { name, transport: serverConfig.transport, ...transportDetails(serverConfig) };

        let policy: McpServerPolicy;
        try {
          policy = resolveServerPolicy(name, serverConfig);
        } catch (error) {
          // A policy value we cannot honour is reported as a failed server rather than silently
          // falling back to a default: "approval: sometimes" must not become "annotations".
          // `approvalMode` stays the documented default and the offending value travels in `error`:
          // this field is typed as one of the modes, and a session-supplied config reaches here
          // through an untyped route, so echoing the raw value would put `42` on `/mcp`.
          this.serverStatuses.set(name, {
            ...base,
            toolCount: 0,
            status: "failed",
            enabled: serverConfig.enabled !== false,
            approvalMode: "annotations",
            error: toError(error).message,
          });
          return;
        }

        if (!policy.enabled) {
          // Disabled servers are still listed: "I turned it off" and "it is not configured" are
          // different answers to "why is this tool missing?"
          this.serverStatuses.set(name, {
            ...base,
            toolCount: 0,
            status: "disabled",
            enabled: false,
            approvalMode: policy.approval,
          });
          return;
        }

        try {
          const transport = createTransportInput(this.env, serverConfig);

          if (serverConfig.transport === "stdio") {
            this.stdioTransports.push(transport);
          }

          const client = await createMCPClient(
            mcpClientOptions(name, transport, policy, this.options.elicit, (message) => this.note(message))
          );

          // A teardown / newer activation that ran while we were connecting: close what we just
          // created instead of writing it into the cleared map (see `generation`).
          if (isStale()) {
            await client.close().catch(() => undefined);
            return;
          }

          const tools = await client.tools().catch(async (error: unknown) => {
            // `createMCPClient` has already connected; a failed `tools()` would otherwise leave
            // the child process alive because it is not in `clients` for `shutdown()`.
            await client.close().catch(() => undefined);
            throw error;
          });

          if (isStale()) {
            await client.close().catch(() => undefined);
            return;
          }

          try {
            for (const tool of tools) {
              // TanStack prefers structuredContent and drops content[] images; re-wrap execute.
              allTools[tool.name] = wrapMcpToolForMultimodalContent(tool, client);
            }
          } catch (error) {
            // The client is not in `clients` yet, so `shutdown()` cannot close it. Contain the leak
            // here before the outer catch records the failure.
            await client.close().catch(() => undefined);
            throw error;
          }

          this.clients.set(name, client);

          if (client.instructions) {
            this.serverInstructions.set(name, client.instructions);
          }

          this.serverStatuses.set(name, {
            ...base,
            toolCount: tools.length,
            status: "connected",
            enabled: true,
            approvalMode: policy.approval,
          });
        } catch (err) {
          // A teardown that happened while this connect was failing must not write "failed" back
          // into a status table the teardown already cleared: `/mcp` would report a server that is
          // no longer part of this incarnation.
          if (isStale()) return;
          const error = toError(err);

          this.serverStatuses.set(name, {
            ...base,
            toolCount: 0,
            status: "failed",
            enabled: true,
            approvalMode: policy.approval,
            error: error.message,
          });
        }
      })
    );

    return allTools;
  }

  getServerStatuses(): McpServerStatus[] {
    return Array.from(this.serverStatuses.values());
  }

  /**
   * The `session:mcp` payload: config provenance PLUS the server list.
   *
   * One builder for all three producers (bootstrap, `mcp.refresh`, the retained channel value).
   * The refresh path used to emit `{ servers }` only, so a host that re-read the retained value lost
   * "why did my mcp.json not apply?" — the one question the load report exists to answer.
   */
  getStatusPayload(): {
    configPath?: string;
    configLoadedFrom?: string;
    configSourceKind: McpConfigSourceKind;
    servers: McpServerStatus[];
    toolCount: number;
  } {
    const servers = this.getServerStatuses();
    return {
      ...(this.configPath !== undefined ? { configPath: this.configPath } : {}),
      ...(this.configLoadedFrom !== undefined ? { configLoadedFrom: this.configLoadedFrom } : {}),
      configSourceKind: this.configSourceKind,
      servers,
      toolCount: servers.reduce((sum, server) => sum + server.toolCount, 0),
    };
  }

  /**
   * Handshake `instructions` from every connected server that sent them.
   * Empty when no server provides any — callers should then inject nothing.
   */
  getServerInstructions(): Array<{ server: string; instructions: string }> {
    return Array.from(this.serverInstructions, ([server, instructions]) => ({ server, instructions }));
  }

  forceKill(): void {
    // Invalidate any connect already in flight (see `generation`).
    this.generation += 1;
    this.closeStdioTransports();
    // Close the CLIENT as well, not just drop the reference. This is the synchronous half of
    // teardown (process exit), so it cannot await — but `clients.clear()` alone left an HTTP/SSE
    // transport's fetch/stream open until process exit, and `deactivate()`'s `shutdown()` then
    // iterated an empty map and closed nothing. stdio children are reaped above; this is for the
    // transports that have no child process.
    for (const [, client] of this.clients) {
      try {
        void Promise.resolve(client.close()).catch(() => {
          // Best-effort: the process is going away.
        });
      } catch {
        // A synchronous throw from `close()` must not abort the teardown loop.
      }
    }
    this.clients.clear();
    this.serverStatuses.clear();
    this.serverInstructions.clear();
    // The sink is a closure over the extension's `ctx`, which dies with it (see `shutdown`).
    this.diagnosticSink = undefined;
  }

  async shutdown(): Promise<void> {
    // Invalidate any connect that started before this shutdown, and take ownership of the clients
    // that belong to THIS incarnation. A generation bump is what keeps a later `initialize`
    // (re-enable) from being clobbered by the clears at the end of this method.
    const generation = ++this.generation;
    const clients = [...this.clients.values()];
    this.clients.clear();
    // Close transports even when no client reached `clients`: a server that failed during
    // connect (or after `createMCPClient` but before its tools were wrapped) has already
    // spawned a child. `shutdown` reaps it here; `forceKill` does the same on the sync path.
    // Disabling the MCP extension is a graceful shutdown, so a half-connected server must not
    // survive it.
    this.closeStdioTransports();
    for (const client of clients) {
      try {
        await client.close();
      } catch {
        // Ignore close errors during shutdown
      }
    }
    // A newer incarnation already owns the maps; dropping its state would erase live servers.
    if (generation !== this.generation) return;
    this.serverStatuses.clear();
    this.serverInstructions.clear();
    // The sink is a closure over the extension's `ctx`, and the ctx dies with the extension. A
    // teardown path that does not go through `deactivate` (force-kill, runtime dispose) would
    // otherwise keep calling a logger that no longer owns a live session.
    this.diagnosticSink = undefined;
  }

  /** Close/kill every stdio transport and forget them. Best-effort; idempotent. */
  private closeStdioTransports(): void {
    const env = this.env;
    for (const transport of this.stdioTransports) {
      try {
        let child: McpProcessHandle | undefined;
        if (env.getMCPTransportProcess) {
          child = env.getMCPTransportProcess(transport);
        }
        if (child && !child.killed) {
          child.kill("SIGKILL");
        }
        if (transport && typeof transport === "object" && "close" in transport) {
          (transport as { close(): void }).close();
        }
      } catch {
        // Ignore errors during teardown
      }
    }
    this.stdioTransports = [];
  }

  getConnectedServers(): string[] {
    return Array.from(this.clients.keys());
  }
}
