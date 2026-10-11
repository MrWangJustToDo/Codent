import { createMCPClient } from "@tanstack/ai-mcp";

import { getEnv } from "../../env";
import { toModelOutputRegistry } from "../tools/runtime/to-model-output-registry.js";

import { resolveMcpModelOutput, wrapMcpToolForMultimodalContent } from "./prefer-multimodal-content.js";

import type { McpConfig, McpServerConfig } from "./types.js";
import type { McpProcessHandle } from "../../env";
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
 * Owner recorded for every MCP registration (model-output shaping), so shutting the
 * servers down can remove exactly its own entries.
 *
 * Deliberately === the MCP extension's id. Every one of these registrations is removed by
 * `forgetToolPresentationOwner` / `toModelOutputRegistry.removeOwner` on extension unload
 * (`extension-registry-service.ts`), so a different owner here would make the removal a
 * no-op that silently leaks one stacked handler per server per connect — and, for a name
 * that is also a built-in, leave the stale MCP handler shadowing the built-in's own
 * shaping for the rest of the process.
 */
export const MCP_TOOL_OWNER = "codent-mcp";

// ============================================================================
// Transport Factory
// ============================================================================

function createTransportInput(config: McpServerConfig): TransportInput {
  if (config.transport === "stdio") {
    const env = getEnv();
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
   */
  private configPathValue?: string;
  private configLoadedFromValue?: string;

  /** Explicit path passed by the caller (may be a default lookup). */
  get configPath(): string | undefined {
    return this.configPathValue;
  }

  /** Actual file that was loaded (differs from configPath when defaults are used). */
  get configLoadedFrom(): string | undefined {
    return this.configLoadedFromValue;
  }

  /** Record the config source for session-bootstrap telemetry. */
  setConfigSource(configPath: string | undefined, loadedFrom: string | undefined): void {
    this.configPathValue = configPath;
    this.configLoadedFromValue = loadedFrom;
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
          const transport = createTransportInput(serverConfig);

          if (serverConfig.transport === "stdio") {
            this.stdioTransports.push(transport);
          }

          const client = await createMCPClient({
            transport,
            name: `codent-mcp-${name}`,
            prefix: `mcp__${name}_`,
          });

          const tools = await client.tools();

          for (const tool of tools) {
            // TanStack prefers structuredContent and drops content[] images; re-wrap execute.
            allTools[tool.name] = wrapMcpToolForMultimodalContent(tool, client);

            // MCP tools are created dynamically (never via `defineServerTool`), so no
            // `toModelOutput` is registered for them. `applyToolCompact` then leaves the
            // persisted tool result untouched — and TanStack persists array results as
            // JSON text, so image base64 reaches the model as plain text: vision models
            // still need another tool to "read" the image, and the base64 is re-sent
            // every turn. Register the default resolver so media is revived to
            // ContentPart[] and lifted to `image_url` by the adapter.
            //
            // Owner-scoped, not the default (the tool name): the extension registry removes
            // these by owner when the MCP extension unloads, and the default would make that
            // removal miss — leaking the entry and shadowing a same-named built-in's shaping.
            this.registerModelOutputFor(tool.name);
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
          const error = err instanceof Error ? err : new Error(String(err));

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

  /** Every tool name this manager registered, so shutdown can remove its entries. */
  private registeredToolNames: string[] = [];

  /**
   * Record this manager's model-output shaping for one tool, under {@link MCP_TOOL_OWNER},
   * and remember the name so {@link clearModelOutputRegistrations} can drop it.
   *
   * A named method rather than an inline `register` call so the owner is stated once, at a
   * seam a validator can drive directly. The owner is the part that used to be wrong — the
   * inline call took the default (the tool name) while the extension registry removes by the
   * extension's id — and an inline call is not reachable without a live MCP server, which is
   * exactly why the mismatch went unnoticed.
   */
  registerModelOutputFor(toolName: string): void {
    toModelOutputRegistry.register(toolName, ({ output }) => resolveMcpModelOutput(output), MCP_TOOL_OWNER);
    this.registeredToolNames.push(toolName);
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

  /**
   * Drop this manager's model-output registrations and forget the names.
   *
   * `forceKill`/`shutdown` closed the clients but left these behind — nothing else removes
   * them, because the extension-registry removal runs per *registered extension tool* and the
   * MCP extension never unregisters on deactivate. Without this, each connect leaves one more
   * handler stacked under a name (its own owner, so it replaced its previous entry — but the
   * name stayed occupied), and a name shared with a built-in kept shadowing that built-in's
   * shaping for the rest of the process.
   */
  private clearModelOutputRegistrations(): void {
    for (const name of this.registeredToolNames) {
      toModelOutputRegistry.removeOwner(name, MCP_TOOL_OWNER);
    }
    this.registeredToolNames = [];
  }

  forceKill(): void {
    const env = getEnv();
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
        // Ignore errors during force kill
      }
    }
    this.stdioTransports = [];
    this.clients.clear();
    this.serverStatuses.clear();
    this.serverInstructions.clear();
    this.clearModelOutputRegistrations();
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
    this.stdioTransports = [];
    this.serverStatuses.clear();
    this.serverInstructions.clear();
    this.clearModelOutputRegistrations();
  }

  getConnectedServers(): string[] {
    return Array.from(this.clients.keys());
  }
}
