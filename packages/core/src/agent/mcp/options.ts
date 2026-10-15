/**
 * MCP configuration built from an explicit server map rather than a file.
 *
 * A host that already holds MCP servers as data (an editor's settings, an ACP
 * `session/new` parameter) has nothing to put on disk, and writing one would make wire
 * state durable — plus a temp file would carry any `env` / `headers` credentials into the
 * workspace. This helper is the single seam that turns such a map into the same
 * {@link McpConfig} shape {@link loadMcpConfig} produces, so both paths reach
 * {@link McpManager.initialize} identically.
 */

import type { McpConfig, McpServerConfig } from "./types.js";
import type { McpConfigSourceKind } from "../../runtime-types/mcp-status.js";

// Re-exported so MCP-internal call sites import the kind from this domain. The declaration
// lives in `runtime-types` because the `session:mcp` event payload names it and that leaf
// cannot depend on `agent/mcp/` (mirrors `McpServerStatus`).
export type { McpConfigSourceKind };

/**
 * Build the {@link McpConfig} a session should connect from an explicit server map.
 *
 * Returns `null` for an empty map: "no servers were given" and "no config file was found"
 * must reach the factory as the same absence, or every caller would need its own empty check.
 */
export function mcpConfigFromServers(servers: Record<string, McpServerConfig> | undefined): McpConfig | null {
  if (!servers) return null;
  const names = Object.keys(servers);
  if (names.length === 0) return null;
  return { mcpServers: servers };
}
