/**
 * Subscribe to a keyed summary stream (task / compact) and render a bounded line window.
 */

import {
  applyAppendToAgentStreamWindow,
  agentStreamWindowFromSnapshot,
  emptyAgentStreamDisplayWindow,
  renderAgentStreamDisplayRows,
  agentStreamKey,
  type AgentStreamDisplayWindow,
  type AgentStreamSource,
} from "@codent/core";
import { useEffect, useMemo, useState } from "react";

import { resolveAgentSession } from "../utils/session-resolve.js";
import { subscribeSummaryStream } from "../utils/summary-stream-subscription.js";

import { useAgent } from "./use-agent.js";

export interface UseSummaryStreamOptions {
  enabled?: boolean;
  maxLines?: number;
  /** Summary streams only; command output is served by `useStreamingOutput`. */
  source: Exclude<AgentStreamSource, "command">;
  toolCallId?: string;
  compactId?: string;
  agentId?: string;
}

export interface UseSummaryStreamResult {
  rows: string[];
  hidden: number;
  status: "active" | "ended" | "missing";
  pendingLine: string;
}

function resolveKey(options: UseSummaryStreamOptions): string | undefined {
  if (options.source === "task") {
    return options.toolCallId ? agentStreamKey("task", options.toolCallId) : undefined;
  }
  return options.compactId ? agentStreamKey("compact", options.compactId) : undefined;
}

export function useSummaryStream(options: UseSummaryStreamOptions): UseSummaryStreamResult {
  const enabled = options.enabled ?? true;
  const maxLines = options.maxLines ?? 5;
  const contentSlots = Math.max(1, maxLines - 1);
  const key = resolveKey(options);
  const rootAgentId = useAgent((s) => s.session?.id);
  const agentId = options.agentId || rootAgentId;

  const [windowState, setWindowState] = useState<AgentStreamDisplayWindow>(() => emptyAgentStreamDisplayWindow());
  const [status, setStatus] = useState<UseSummaryStreamResult["status"]>("missing");

  useEffect(() => {
    if (!enabled || !agentId || !key) {
      setWindowState(emptyAgentStreamDisplayWindow());
      setStatus("missing");
      return;
    }

    const session = resolveAgentSession(agentId);
    if (!session) {
      setWindowState(emptyAgentStreamDisplayWindow());
      setStatus("missing");
      return;
    }

    return subscribeSummaryStream(session, key, {
      onReset: () => {
        setWindowState(emptyAgentStreamDisplayWindow());
        setStatus("active");
      },
      onAppend: (accumulated) => {
        setWindowState((prev) => applyAppendToAgentStreamWindow(prev, accumulated, contentSlots));
        setStatus("active");
      },
      onEnd: () => setStatus("ended"),
      onSnapshot: (snap) => {
        if (snap) {
          setWindowState(agentStreamWindowFromSnapshot(snap, contentSlots));
          setStatus(snap.status);
        } else {
          setWindowState(emptyAgentStreamDisplayWindow());
          setStatus("missing");
        }
      },
    });
  }, [enabled, agentId, key, contentSlots]);

  return useMemo(() => {
    const rendered = renderAgentStreamDisplayRows(windowState, maxLines);
    return {
      rows: rendered.rows,
      hidden: rendered.hidden,
      status,
      pendingLine: windowState.pendingLine,
    };
  }, [windowState, maxLines, status]);
}
