import { createMCPClient } from "@tanstack/ai-mcp";

import { getEnv } from "../../env";
import { toError } from "../../utils/errors.js";

import { wrapMcpToolForMultimodalContent } from "./prefer-multimodal-content.js";

import type { McpConfigSourceKind } from "./options.js";
import type { McpConfig, McpServerConfig } from "./types.js";
import type { McpProcessHandle, ResolvedCoreEnv } from "../../env";
import type { McpServerStatus } from "../../runtime-types/mcp-status.js";
import type { AnyServerTool } from "@tanstack/ai";
import type { MCPClient, TransportInput } from "@tanstack/ai-mcp";

// ============================================================================
// McpServerStatus — public data for display in CLI /mcp command
// ============================================================================

// Declared in runtime-types (the shared leaf) so event payloads can name it without
// importing this module; re-exported here because this is where it is produced.
export type { McpServerStatus };

export type McpToolsRecord = Record<string, AnyServerTool>;

/**
 * Legacy owner id used by standalone MCP-presentation tests.
 *
 * Live MCP tools carry their `toModelOutput` on the registered tool definition, so the agent
 * tool service owns publication/removal; no process registry entry exists to clean up.
 */
export const MCP_TOOL_OWNER = "codent-mcp";

// ============================================================================
// Transport Factory
// ============================================================================

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

// ============================================================================
// McpManager
// ============================================================================

export class McpManager {
  /** Workspace env for stdio transports (runtime-provided; ambient by default). */
  constructor(private readonly env: ResolvedCoreEnv = getEnv()) {}

  private clients: Map<string, MCPClient> = new Map();
  private stdioTransports: unknown[] = [];

  private serverStatuses: Map<string, McpServerStatus> = new Map();

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
    const allTools: McpToolsRecord = {};
    const servers = Object.entries(config.mcpServers) as [string, McpServerConfig][];

    // Connect to all servers in parallel (serial per-server awaits slow down
    // startup and hide slow servers behind fast ones). Each server keeps its
    // own error signal in `serverStatuses` and a failure never blocks others.
    await Promise.allSettled(
      servers.map(async ([name, serverConfig]) => {
        try {
          const transport = createTransportInput(this.env, serverConfig);

          if (serverConfig.transport === "stdio") {
            this.stdioTransports.push(transport);
          }

          const client = await createMCPClient({
            transport,
            name: `codent-mcp-${name}`,
            prefix: `mcp__${name}_`,
          });

          const tools = await client.tools().catch(async (error: unknown) => {
            // `createMCPClient` has already connected; a failed `tools()` would otherwise leave
            // the child process alive because it is not in `clients` for `shutdown()`.
            await client.close().catch(() => undefined);
            throw error;
          });

          for (const tool of tools) {
            // TanStack prefers structuredContent and drops content[] images; re-wrap execute.
            allTools[tool.name] = wrapMcpToolForMultimodalContent(tool, client);
          }

          this.clients.set(name, client);

          if (client.instructions) {
            this.serverInstructions.set(name, client.instructions);
          }

          this.serverStatuses.set(name, {
            name,
            transport: serverConfig.transport,
            toolCount: tools.length,
            status: "connected",
            command: serverConfig.transport === "stdio" ? serverConfig.command : undefined,
            args: serverConfig.transport === "stdio" ? serverConfig.args : undefined,
            url: serverConfig.transport !== "stdio" ? serverConfig.url : undefined,
          });
        } catch (err) {
          const error = toError(err);

          this.serverStatuses.set(name, {
            name,
            transport: serverConfig.transport,
            toolCount: 0,
            status: "failed",
            error: error.message,
            command: serverConfig.transport === "stdio" ? serverConfig.command : undefined,
            args: serverConfig.transport === "stdio" ? serverConfig.args : undefined,
            url: serverConfig.transport !== "stdio" ? serverConfig.url : undefined,
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
   * Handshake `instructions` from every connected server that sent them.
   * Empty when no server provides any — callers should then inject nothing.
   */
  getServerInstructions(): Array<{ server: string; instructions: string }> {
    return Array.from(this.serverInstructions, ([server, instructions]) => ({ server, instructions }));
  }

  forceKill(): void {
    this.closeStdioTransports();
    this.clients.clear();
    this.serverStatuses.clear();
    this.serverInstructions.clear();
  }

  async shutdown(): Promise<void> {
    for (const [, client] of this.clients) {
      try {
        await client.close();
      } catch {
        // Ignore close errors during shutdown
      }
    }
    this.clients.clear();
    // Close transports even when no client reached `clients`: a server that failed during
    // connect (or after `createMCPClient` but before its tools were wrapped) has already
    // spawned a child, and only `forceKill` used to reap it. Disabling the MCP extension is a
    // graceful shutdown, so a half-connected server must not survive it.
    this.closeStdioTransports();
    this.serverStatuses.clear();
    this.serverInstructions.clear();
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
