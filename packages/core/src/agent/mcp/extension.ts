import { BUILTIN_EXTENSION_ORDER } from "../extension/dispatch-order.js";
import { isProjectedModelContent } from "../tools/runtime/define-tool.js";

import { loadMcpConfig } from "./config.js";
import { resolveMcpModelOutput } from "./prefer-multimodal-content.js";

import type { McpManager, McpServerStatus } from "./manager.js";
import type { McpConfig } from "./types.js";
import type { ExtensionAPI, ExtensionContext } from "../extension/types.js";

// ============================================================================
// MCP extension options
// ============================================================================

export interface CreateMcpExtensionOptions {
  /** Pre-initialized MCP manager (created by the agent factory as the data layer). */
  mcpManager: McpManager;
  /** Explicit config path; when omitted, defaults (.agents/mcp.json, .mcp.json) are probed. */
  configPath?: string;
  /**
   * Servers supplied by the session's create options. When non-null these REPLACE the config
   * file entirely (identical names with different commands/urls would otherwise make "which one
   * won" unanswerable), so the file is not even read.
   */
  servers?: McpConfig | null;
}

export interface McpExtensionConfig {
  configPath?: string;
}

// ============================================================================
// Built-in MCP extension
// ============================================================================

/**
 * Register MCP servers as an extension: connects on activate, exposes each MCP
 * tool through the extension tool registry (keeping the `mcp__<server>_` prefix
 * produced by {@link McpManager}), and provides the `/mcp` status command.
 * Deactivation shuts down all connected clients.
 */
export function createMcpExtension(options: CreateMcpExtensionOptions): ExtensionAPI {
  const { mcpManager, configPath, servers } = options;
  return {
    id: "codent-mcp",
    // Built-ins are the baseline: they run first in interceptor/transformer chains and lose a
    // same-name tool to a user extension. Loading last must not mean "runs last, wins".
    order: BUILTIN_EXTENSION_ORDER,
    name: "MCP",
    version: "1.0.0",
    description:
      "Model Context Protocol: connect external MCP servers over stdio/SSE/HTTP and expose their tools (mcp__<server>_<tool>) plus the /mcp status command",
    async activate(ctx) {
      // One context provider per extension (`ExtensionRunner` keys the map by extension id),
      // so the handshake instructions and the disabled notice share this single registration.
      // `content` is evaluated per turn, after `activateMcp` has connected and captured them.
      ctx.registerContextProvider({
        content: () => formatMcpInstructions(mcpManager.getServerInstructions()),
        disabledContent: () =>
          "MCP extension is disabled — external MCP servers (mcp__<server>_<tool>) and the /mcp status command are unavailable.",
      });
      await activateMcp(ctx, mcpManager, configPath, servers ?? null);
    },
    deactivate() {
      return mcpManager.shutdown();
    },
  };
}

async function activateMcp(
  ctx: ExtensionContext,
  mcpManager: McpManager,
  configPath?: string,
  explicit?: McpConfig | null
): Promise<void> {
  let config: McpConfig | null = null;

  if (explicit) {
    // Session-supplied servers REPLACE the file, so the file is not read at all: a broken
    // `.agents/mcp.json` must not emit warnings for a session whose servers never came from it.
    config = explicit;
    mcpManager.setConfigSourceKind("session-options");
  } else {
    const loadResult = await loadMcpConfig(ctx.coreEnv, configPath);
    for (const err of loadResult?.loadErrors ?? []) {
      ctx.logger.warn(err);
    }
    mcpManager.setConfigSource(configPath, loadResult?.sourcePath);
    mcpManager.setConfigSourceKind("file");
    config = loadResult?.config ?? null;
  }

  if (!config || Object.keys(config.mcpServers).length === 0) {
    return;
  }

  // Names and transports only: `env` / `headers` values are credentials and MUST NOT be
  // logged — the values are deliberately never read here. The FILE path is included on the file
  // branch because "which file applied" is the useful answer there (and it is a path, unlike
  // the source kind, so it does not misrepresent anything).
  const inventory = Object.entries(config.mcpServers)
    .map(([name, server]) => `${name}/${server.transport}`)
    .join(", ");
  const origin =
    mcpManager.configSourceKind === "file" && mcpManager.configLoadedFrom
      ? `${mcpManager.configSourceKind} (${mcpManager.configLoadedFrom})`
      : mcpManager.configSourceKind;
  ctx.logger.log(
    "info",
    "system",
    `MCP configuration source: ${origin} (${Object.keys(config.mcpServers).length} servers: ${inventory})`
  );

  const tools = await mcpManager.initialize(config);

  for (const [name, tool] of Object.entries(tools)) {
    ctx.registerTool({
      name,
      description: tool.description ?? `MCP tool "${name}"`,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      // MCP tools are the runtime case this descriptor exists for: their names and
      // schemas come from a remote server, so there is no `defineServerTool` call site
      // to declare presentation at. Without it the tool resolves no descriptor at all,
      // which costs it both its row and its result block — the name is not in the
      // built-in table either, so the fallback cannot cover it.
      //
      // The flags are the ones the renderer actually branches on, not preferences:
      //   keepRow  — the row survives compact display instead of folding into a count
      //   detailed — `ToolOutputView` only skips its "no renderer" guard for a detailed
      //              tool; with keepRow alone `isDetailed` is false and the block is
      //              dropped even though the row is kept
      // `category` is deliberately generic: an MCP name is server-defined, so nothing
      // here can tell whether the call was a read or a write, and a wrong bucket
      // misreports what happened. No `text` renderer — that field claims a single
      // curated line exists, which is a contract this repo cannot define for output a
      // server produced.
      present: { category: "other", keepRow: true, detailed: true },
      // MCP tools are created dynamically, so this is the registration point for their
      // model-output revival (structuredContent vs content[] images).
      toModelOutput: ({ output }) => (isProjectedModelContent(output) ? output : resolveMcpModelOutput(output)),
      execute: async (input, options) =>
        tool.execute?.(input, {
          toolCallId: options.toolCallId,
          abortSignal: options.abortSignal,
        }),
    });
  }

  ctx.registerCommand({
    name: "mcp",
    description: "List configured MCP servers and their connection status",
    execute: async () => formatMcpStatus(mcpManager.getServerStatuses()),
  });
}

// ============================================================================
// /mcp status formatting (mirrors the previous app-layer builtin command)
// ============================================================================

/**
 * Render MCP server handshake `instructions` as a turn-context section.
 * Returns `undefined` (inject nothing) when no server provided any text.
 */
function formatMcpInstructions(entries: Array<{ server: string; instructions: string }>): string | undefined {
  const withText = entries.filter((entry) => entry.instructions.trim().length > 0);
  if (withText.length === 0) return undefined;
  const body = withText.map((entry) => `### ${entry.server}\n${entry.instructions.trim()}`).join("\n\n");
  return `The connected MCP servers provided the following usage instructions:\n\n${body}`;
}

function formatMcpStatus(servers: McpServerStatus[]): string {
  if (servers.length === 0) {
    return "No MCP servers configured.";
  }

  const lines: string[] = [];
  for (const s of servers) {
    const status = String(s.status ?? "");
    const icon = status === "connected" ? "✓" : "✗";
    let target = "";
    if (s.command) {
      target = `${s.command}${Array.isArray(s.args) ? " " + s.args.join(" ") : ""}`;
    } else if (s.url) {
      target = String(s.url);
    }
    const name = String(s.name ?? "");
    const transport = String(s.transport ?? "");
    const toolCount = Number(s.toolCount ?? 0);
    lines.push(
      `  ${icon} ${name.padEnd(20)} ${transport.padEnd(6)} ${String(toolCount).padStart(3)} tools  ${target}`.trimEnd()
    );
    if (status === "failed" && s.error) {
      lines.push(`      └─ failed: ${s.error}`);
    }
  }

  const connected = servers.filter((s) => s.status === "connected").length;
  const header = `MCP servers (${connected}/${servers.length} connected)`;
  return `${header}:\n${lines.join("\n")}`;
}
