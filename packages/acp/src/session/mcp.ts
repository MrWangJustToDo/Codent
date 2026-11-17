/**
 * ACP `McpServer[]` → core `McpServerConfig` map.
 *
 * ACP and core describe the same thing with different shapes, and the differences are all
 * nameable: ACP keeps `env` / `headers` as `{name, value}` arrays (core uses a record), ACP
 * declares the transport as a discriminant `type` field that stdio entries simply lack, and
 * ACP has a fourth form (`type: "acp"` — a client-side bridge addressed by `serverId`) that
 * core has no way to connect.
 *
 * Validation happens HERE rather than in core: the ACP request is the only place these
 * shapes can be malformed (core's types already forbid a missing `command`), and duplicating
 * the checks one layer down would create a second source of truth for what is valid.
 *
 * Errors are returned as strings rather than thrown: the caller turns them into a JSON-RPC
 * `invalid params` response, and a returned value makes "did this succeed?" a value the
 * caller must look at instead of an exception it can forget to catch.
 */

import type { McpServer } from "@agentclientprotocol/sdk";
import type { McpServerConfig } from "@codent/core";

/** Convert ACP's `{name, value}[]` into core's record. Later duplicates win (as `Object.fromEntries`). */
function toRecord(entries: Array<{ name: string; value: string }>): Record<string, string> {
  return Object.fromEntries(entries.map((entry) => [entry.name, entry.value]));
}

/**
 * Map one ACP server entry, or return the reason it cannot be represented.
 *
 * `command` / `url` emptiness is checked because an empty string is a *present* field: core
 * would accept it and then spawn nothing / fetch nowhere, which fails much later and much
 * less clearly than rejecting the request.
 */
function mapOne(server: McpServer): { config: McpServerConfig } | { error: string } {
  const type = (server as { type?: string }).type;

  if (type === "acp") {
    return {
      error:
        `MCP server "${server.name}" uses transport "acp", which is not supported: ` +
        `ACP-bridged MCP servers must be reached through the client's own connection, and this agent has no such bridge`,
    };
  }

  if (type === "http" || type === "sse") {
    const { url, headers } = server as { url?: string; headers?: Array<{ name: string; value: string }> };
    if (!url) return { error: `MCP server "${server.name}" is missing required "url" for transport "${type}"` };
    return { config: { transport: type, url, headers: toRecord(headers ?? []) } };
  }

  // Any OTHER explicit discriminant is a transport this agent has no connection for (a newer
  // client's `websocket`, or anything the schema grows later). Called out as such rather than
  // falling through: the stdio branch would reject it too, but with a misleading
  // "missing command" message that points at a field the client did send.
  if (type !== undefined && type !== "stdio") {
    return { error: `MCP server "${server.name}" uses unsupported transport "${type}"` };
  }

  // stdio is the union member without a `type` discriminant.
  const { command, args, env } = server as {
    command?: string;
    args?: string[];
    env?: Array<{ name: string; value: string }>;
  };
  if (!command) return { error: `MCP server "${server.name}" is missing required "command" for a stdio server` };
  return { config: { transport: "stdio", command, args: args ?? [], env: toRecord(env ?? []) } };
}

/**
 * Map an ACP `mcpServers` array into core's per-session server map.
 *
 * An empty (or absent) input yields `undefined`, not `{}` — the caller must be able to tell
 * "the client named no servers" (fall back to the workspace config file) from "the client
 * named servers" (replace it), and `{}` would read as the former only by accident.
 */
export function mapAcpMcpServers(servers: McpServer[] | undefined): {
  servers?: Record<string, McpServerConfig>;
  error?: string;
} {
  if (!servers || servers.length === 0) return {};

  const mapped: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    const name = server.name;
    if (!name) return { error: "MCP server entry is missing a name" };
    // Duplicate names would silently drop one entry (last write wins) — and which one won
    // would depend on the client's array order, which it cannot see.
    if (name in mapped) return { error: `Duplicate MCP server name "${name}"` };

    const result = mapOne(server);
    if ("error" in result) return { error: result.error };
    mapped[name] = result.config;
  }

  return { servers: mapped };
}
