/**
 * tool-timing-store — Global (non-component-level) tool timing store.
 *
 * ## Data flow
 *
 * 1. `use-agent-chat.ts` subscribes `lifecycle` channel and calls
 *    {@link handleToolLifecycleEvent} for each event.
 * 2. This module writes tool start/end into the global store using
 *    client-local `Date.now()` (avoids timezone / clock-skew issues).
 * 3. Components subscribe via {@link useToolElapsed} — no per-component
 *    `setInterval` or subscription logic.
 *
 * The subscription lives in the chat hook, not here. This module is purely
 * a store + event handler.
 */

import { createState } from "reactivity-store";

import { resolveToolPresentation } from "./tool-presentation.js";

import type { AgentEvent } from "@codent/core";

// ============================================================================
// Types
// ============================================================================

export interface ToolTimingEntry {
  /** Client-local wall-clock time the tool started (`Date.now()`). */
  startedAt: number;
  /** Final elapsed ms once the tool completes (undefined while in flight). */
  durationMs?: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Tools executed on the client (no server execute) — excluded from timing. The descriptor
 * decides (`present.clientSide`), so an extension tool that runs in the host is covered too;
 * this is the same flag core uses for its row rules.
 */
function isClientTool(name: string): boolean {
  return resolveToolPresentation(name)?.clientSide === true;
}

// ============================================================================
// Store
// ============================================================================

export const useToolTimingStore = createState(
  () => ({
    timings: {} as Record<string, ToolTimingEntry>,
  }),
  {
    withActions: (state) => ({
      /**
       * Record the client-local start time for a tool call.
       * First start wins: pre-forked `task` calls emit an early start at spawn
       * time, and the executor's duplicate start must not reset that clock.
       */
      start(toolCallId: string): void {
        const existing = state.timings[toolCallId];
        if (existing && existing.durationMs === undefined) return;
        state.timings[toolCallId] = { startedAt: Date.now() };
      },

      /** Finalize a tool call with its elapsed duration. */
      end(toolCallId: string, durationMs?: number): void {
        const existing = state.timings[toolCallId];
        if (!existing) return;
        state.timings[toolCallId] = {
          startedAt: existing.startedAt,
          durationMs: durationMs ?? Math.max(0, Date.now() - existing.startedAt),
        };
      },

      /** Drop a tool timing entry (e.g. on message clear / tool cancel). */
      clear(toolCallId: string): void {
        delete state.timings[toolCallId];
      },

      /** Reset the entire store (agent cleanup). */
      reset(): void {
        state.timings = {};
      },
    }),
  }
);

// ============================================================================
// Event handler — called by use-agent-chat.ts from the lifecycle channel
// ============================================================================

/**
 * Handle a lifecycle event from the agent session.
 * Call this from your `session.subscribe` callback when
 * `event.channel === "lifecycle"`.
 *
 * Supported events:
 * - `agent:tool-start` → records client-local start
 * - `agent:tool-end`   → finalizes with duration
 * - `agent:tool-error` → finalizes with computed elapsed
 *
 * Client tools (e.g. `ask_user`) are silently excluded.
 */
export function handleToolLifecycleEvent(payload: AgentEvent): void {
  if (payload.type === "agent:tool-start") {
    const toolCallId = payload.payload.tool_call_id;
    const toolName = payload.payload.tool_name;
    if (!toolCallId) return;
    if (typeof toolName === "string" && isClientTool(toolName)) return;
    useToolTimingStore.getActions().start(toolCallId);
    return;
  }

  if (payload.type === "agent:tool-end") {
    const toolCallId = payload.payload.tool_call_id;
    if (!toolCallId) return;
    const durationMs = payload.payload.duration_ms;
    useToolTimingStore.getActions().end(toolCallId, durationMs);
    return;
  }

  if (payload.type === "agent:tool-error") {
    const toolCallId = payload.payload.tool_call_id;
    if (!toolCallId) return;
    useToolTimingStore.getActions().end(toolCallId);
  }
}
