/**
 * Local helper types for the ACP agent host.
 *
 * ACP protocol types come from `@agentclientprotocol/sdk`; this module only
 * holds the small structural types the projector needs to read `UIMessage`
 * parts without depending on the full part union, plus the advertizable
 * command shape.
 */

import type { StateUpdate } from "@agentclientprotocol/sdk";
import type { AgentSessionSubagentSummary } from "@codent/core";

export type {
  ToolCallStatus,
  SessionUpdate,
  StateUpdate,
  ToolCallContent,
  PlanEntry,
  ContentBlock,
} from "@agentclientprotocol/sdk";

/**
 * One child as the host presents it, translated from core's `subagents` row.
 *
 * The protocol's subagent types are experimental; keeping the host-facing shape here means the
 * projector, the announce/patch diff and the child-attach wiring do not depend on the SDK's union.
 */
export interface SubagentProjection {
  sessionId: string;
  title: string;
  description?: string;
  state: StateUpdate;
  taskPhase?: AgentSessionSubagentSummary["taskPhase"];
}

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
