/**
 * Streaming Callback — agent-scoped bridge into the unified stream hub.
 *
 * `run_command` output is appended to the agent's AgentStreamHub (command source);
 * the hub projects it onto `tool:chunk` / `tool:clear` for existing hosts. The
 * fallback bus path remains for standalone tools/tests with no hub registered.
 *
 * Hosts consume the projection via the AgentSession `tool` channel; in-process callers
 * subscribe with `bus.on("tool:chunk" / "tool:clear")`. The hub registry only locates the
 * owning state machine; it does not add a second buffer.
 *
 * Coupling: command streams are ended by `AgentStreamHub.endCommand`, which today is wired only
 * for the built-in `run_command` (via the extensions middleware's `onToolSettled` hook). Any new
 * tool that calls `emitStreamingChunk` must also arrange a matching settle path; otherwise its
 * previews stay active and are never prunable.
 */

// ============================================================================
// Types
// ============================================================================

import type { AgentEventBus } from "../../agent-event-bus";
import type { AgentStreamHub } from "../../stream-hub";

export interface StreamingChunk {
  toolCallId: string;
  type: "stdout" | "stderr";
  chunk: string;
}

export interface StreamingEmitOptions {
  /** Target agent scope. */
  agentId: string;
}

// ============================================================================
// State
// ============================================================================

/** Agent id → scoped unified event bus (fallback projection for standalone tests). */
const agentEventBuses = new Map<string, AgentEventBus>();

/** Agent id → the one stream hub that owns command/task/compact buffers. */
const agentStreamHubs = new Map<string, AgentStreamHub>();

/**
 * @internal Register an agent's scoped unified event bus so streaming output is
 * emitted as `tool:chunk` / `tool:clear` observer events.
 */
export function registerStreamingEventBus(agentId: string, bus: AgentEventBus): void {
  agentEventBuses.set(agentId, bus);
}

/** @internal Register the agent's unified stream hub (command output source). */
export function registerStreamingHub(agentId: string, hub: AgentStreamHub): void {
  agentStreamHubs.set(agentId, hub);
}

/** @internal Drop the registered bus for an agent (teardown / tests). */
export function unregisterStreamingEventBus(agentId: string): void {
  agentEventBuses.delete(agentId);
  agentStreamHubs.delete(agentId);
}

/**
 * Emit a streaming chunk to the agent's scoped bus (`tool` channel projection).
 */
export function emitStreamingChunk(
  toolCallId: string,
  type: "stdout" | "stderr",
  chunk: string,
  options: StreamingEmitOptions
): void {
  const hub = agentStreamHubs.get(options.agentId);
  if (hub) {
    hub.appendCommand(toolCallId, type, chunk);
    return;
  }
  agentEventBuses.get(options.agentId)?.emit("tool:chunk", {
    kind: "chunk",
    chunk: { toolCallId, type, chunk },
  });
}

/**
 * Clear streamed output for a tool call (e.g. before a subagent retry).
 */
export function clearStreamingOutput(toolCallId: string, options: StreamingEmitOptions): void {
  const hub = agentStreamHubs.get(options.agentId);
  if (hub) {
    hub.clearCommand(toolCallId);
    return;
  }
  agentEventBuses.get(options.agentId)?.emit("tool:clear", { kind: "clear", toolCallId });
}

/** Reset registered buses (validation only). */
export function resetStreamingCallbacksForTests(): void {
  agentEventBuses.clear();
  agentStreamHubs.clear();
}
