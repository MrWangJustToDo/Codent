/**
 * Agent stream protocol — explicit reset/append/end (command + task + compact).
 */

export type AgentStreamSource = "command" | "task" | "compact";

export type AgentStreamChannel = "stdout" | "stderr" | "text";

export type AgentStreamStatus = "active" | "ended";

export function agentStreamKey(source: AgentStreamSource, id: string, channel?: AgentStreamChannel): string {
  return channel ? `${source}:${id}:${channel}` : `${source}:${id}`;
}

export interface AgentStreamSnapshot {
  key: string;
  source: AgentStreamSource;
  channel: AgentStreamChannel;
  /** Present for task and command. */
  toolCallId?: string;
  /** Present when source is compact. */
  compactId?: string;
  seq: number;
  /** Optional phase label (multi-pass compaction) surfaced by UI consumers. */
  label?: string;
  /** Compaction run identity — passes sharing an epoch append instead of resetting. */
  epoch?: string;
  /** Closed complete lines (ring-capped on the producer). */
  lines: string[];
  /** Incomplete trailing line (may be empty). */
  pendingLine: string;
  status: AgentStreamStatus;
}

export type AgentStreamEvent =
  | {
      type: "reset";
      key: string;
      source: AgentStreamSource;
      channel: AgentStreamChannel;
      toolCallId?: string;
      compactId?: string;
      label?: string;
      epoch?: string;
      seq: number;
    }
  | {
      type: "append";
      key: string;
      source: AgentStreamSource;
      channel: AgentStreamChannel;
      toolCallId?: string;
      chunk: string;
      seq: number;
    }
  | { type: "end"; key: string; source: AgentStreamSource; channel: AgentStreamChannel; seq: number };

export type AgentStreamListener = (event: AgentStreamEvent) => void;
