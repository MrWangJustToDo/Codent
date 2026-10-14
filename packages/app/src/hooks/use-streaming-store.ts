/**
 * use-streaming-store — Reactive streaming store for real-time tool output.
 *
 * Uses reactivity-store for automatic UI updates.
 */

import { createState } from "reactivity-store";

// ============================================================================
// Types
// ============================================================================

export interface StreamingOutput {
  stdout: string;
  stderr: string;
  timestamp: number;
}

// ============================================================================
// Store
// ============================================================================

export const useStreamingStore = createState(
  () => ({
    outputs: {} as Record<string, StreamingOutput>,
  }),
  {
    withActions: (state) => ({
      /**
       * Update streaming output for a tool call.
       */
      update(toolCallId: string, data: Partial<StreamingOutput>): void {
        const existing = state.outputs[toolCallId] ?? {
          stdout: "",
          stderr: "",
          timestamp: 0,
        };

        state.outputs[toolCallId] = {
          stdout: data.stdout ?? existing.stdout,
          stderr: data.stderr ?? existing.stderr,
          timestamp: Date.now(),
        };
      },

      /**
       * Clear output for a tool call.
       */
      clear(toolCallId: string): void {
        delete state.outputs[toolCallId];
      },
    }),
  }
);
