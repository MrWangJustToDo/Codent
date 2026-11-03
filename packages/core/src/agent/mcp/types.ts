import { z } from "zod";

// ============================================================================
// Server policy
// ============================================================================

/**
 * How a server's tools are gated before execution.
 *
 * - `annotations` (default) — derived from the tool's own `annotations`:
 *   `destructiveHint` gates, `readOnlyHint` does not, and **absent metadata gates**. The server
 *   not saying "read-only" is not evidence that it is.
 * - `always` — every tool of this server is gated, whatever the annotations say.
 * - `never` — nothing is gated. An explicit user decision, and the only way to restore the
 *   pre-annotation behaviour.
 */
export const mcpApprovalModeSchema = z.enum(["annotations", "always", "never"]);

export type McpApprovalMode = z.infer<typeof mcpApprovalModeSchema>;

/** Accepted {@link McpApprovalMode} values, for error text. */
export const MCP_APPROVAL_MODES: readonly McpApprovalMode[] = mcpApprovalModeSchema.options;

/**
 * Fields every server entry accepts regardless of transport.
 *
 * Both are optional so existing `.agents/mcp.json` files keep loading unchanged.
 */
const mcpServerPolicyShape = {
  /** `false` skips this server entirely: no process, no connection, no tools. Default `true`. */
  enabled: z.boolean().optional(),
  /** Approval policy for this server's tools. Default `annotations`. */
  approval: mcpApprovalModeSchema.optional(),
};

// ============================================================================
// MCP Server Configuration Types
// ============================================================================

/** Stdio transport: spawns a child process */
export const mcpServerConfigStdioSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  ...mcpServerPolicyShape,
});

export type McpServerConfigStdio = z.infer<typeof mcpServerConfigStdioSchema>;

/** SSE or HTTP transport: connects to a remote URL */
export const mcpServerConfigHttpSchema = z.object({
  transport: z.enum(["sse", "http"]),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  ...mcpServerPolicyShape,
});

export type McpServerConfigHttp = z.infer<typeof mcpServerConfigHttpSchema>;

/** Union of all server config types */
export const mcpServerConfigSchema = z.union([mcpServerConfigStdioSchema, mcpServerConfigHttpSchema]);

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

// ============================================================================
// Elicitation
// ============================================================================

/**
 * The answer an elicit hook returns, mirroring MCP's `ElicitResult`.
 *
 * A bare string is accepted as shorthand because the decline/cancel cases carry no content; the
 * object form is the only way to return collected form values.
 */
export type McpElicitResult = "accept" | "decline" | "cancel" | { action: "accept"; content?: Record<string, unknown> };

/** Normalized answer, as MCP's `ElicitResult` expects it (never the shorthand string). */
export type McpElicitAnswer = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

/**
 * Answers one `elicitation/create` request from a server.
 *
 * Supplied by the runtime (not by core): answering means showing UI, and the UI is per host — a
 * terminal confirm, an ACP `elicitation/create` round-trip, an extension side panel. `params` is
 * deliberately opaque so core does not pin an MCP spec revision; the host narrows it.
 *
 * Without a hook the client does not advertise `elicitation` at all, and any request that arrives
 * anyway is declined with a diagnostic naming the server (see `McpManager`).
 */
export type McpElicitHook = (input: { server: string; params: unknown }) => Promise<McpElicitResult>;

// ============================================================================
// MCP Config File Schema
// ============================================================================

/** Top-level MCP configuration (matches `.agents/mcp.json`) */
export const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerConfigSchema),
});

export type McpConfig = z.infer<typeof mcpConfigSchema>;

/**
 * Effective policy for one server, with defaults applied.
 *
 * Split from {@link McpServerConfig} because the manager must not re-derive defaults per call
 * site: one place decides what an absent field means.
 */
export interface McpServerPolicy {
  enabled: boolean;
  approval: McpApprovalMode;
}

/**
 * Apply the defaults for one server entry, naming the server when a value is unusable.
 *
 * Zod already rejects an unknown `approval` at load time; this also covers servers handed to a
 * session through its create options, which never pass through the config file schema.
 */
export function resolveServerPolicy(name: string, config: McpServerConfig): McpServerPolicy {
  const approval = config.approval ?? "annotations";
  if (!MCP_APPROVAL_MODES.includes(approval)) {
    throw new Error(
      `MCP server "${name}" has approval "${String(approval)}"; expected one of ${MCP_APPROVAL_MODES.join(", ")}`
    );
  }
  return { enabled: config.enabled !== false, approval };
}
