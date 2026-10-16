/**
 * Local helper types for the ACP agent host.
 *
 * ACP protocol types come from `@agentclientprotocol/sdk`; this module only
 * holds the small structural types the projector needs to read `UIMessage`
 * parts without depending on the full part union, plus the advertizable
 * command shape.
 */

export type { ToolCallStatus, SessionUpdate, ToolCallContent, PlanEntry, ContentBlock } from "@agentclientprotocol/sdk";

/** Structural view of a `tool-call` part (only fields the projector reads). */
export interface ToolCallPartLike {
  type: "tool-call";
  id: string;
  name: string;
  input?: unknown;
  /** The engine's raw JSON arguments — the only place the input exists while it streams. */
  arguments?: string;
  state: string;
  output?: { success?: boolean } & Record<string, unknown>;
}

/** Structural view of a `tool-result` part. */
export interface ToolResultPartLike {
  type: "tool-result";
  toolCallId: string;
  content?: unknown;
  /** The tool's own return value — where a produced image's bytes live (`read_file` → an object). */
  output?: unknown;
  state: string;
  outcome?: unknown;
  error?: string;
}

/** Commands advertised to the client via `available_commands_update`. */
export interface AcpCommands {
  builtin: Array<{ name: string; description: string }>;
  extension: Array<{ name: string; description: string }>;
}
