/**
 * Compaction start/complete/error for the auto, manual and reactive paths.
 *
 * One family of {@link AgentEventPayloadMap} (`agent-event-payloads.ts`), split so the map stays
 * readable and no single file sits at the line ceiling.
 */

import type { EmptyAgentEventPayload } from "./payload-primitives.js";

export type CompactionEventPayloads = {
  "compaction:auto-start": {
    tokensBefore?: number;
  };
  "compaction:auto-complete": {
    tokensBefore?: number;
    tokensAfter?: number;
  };
  "compaction:auto-error": {
    error?: string;
  };
  "compaction:manual-start": {
    tokensBefore?: number;
  };
  "compaction:manual-complete": {
    tokensBefore?: number;
    tokensAfter?: number;
  };
  "compaction:manual-error": {
    error?: string;
  };
  "compaction:reactive-start": {
    retry?: number;
    maxRetries?: number;
  };
  "compaction:reactive-complete": {
    originalCount?: number;
    compactedCount?: number;
    tokensBefore?: number;
    tokensAfter?: number;
  };
  "compaction:reactive-error": {
    error?: string;
  };
  "compaction:reactive-max-retries": EmptyAgentEventPayload;
  /** Post-compaction cache cleanup failed (best-effort; the compaction itself succeeded). */
  "compaction:cache-cleanup-error": {
    error: string;
    /** Which compaction path hit it — all three share the same failure. */
    stage?: "auto" | "manual" | "reactive";
  };
};
