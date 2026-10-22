/**
 * Subscribe to the compact summary stream and accumulate raw text.
 *
 * Subscribe whenever a root session exists so `reset` / early `append` are not
 * missed while status is still catching up. Return "" unless `enabled`.
 */

import { agentStreamKey } from "@codent/core";
import { useEffect, useRef, useState } from "react";

import { resolveAgentSession } from "../utils/session-resolve.js";
import { subscribeSummaryStream } from "../utils/summary-stream-subscription.js";

import { useAgent } from "./use-agent.js";

export interface UseCompactSummaryTextOptions {
  enabled?: boolean;
}

export interface CompactSummaryTextResult {
  text: string;
  /** Phase label from the latest reset (multi-pass compaction); "" when absent. */
  label: string;
}

export function useCompactSummaryText(options?: UseCompactSummaryTextOptions): CompactSummaryTextResult {
  const enabled = options?.enabled ?? true;
  const rootAgentId = useAgent((s) => s.session?.id);
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const textRef = useRef("");

  useEffect(() => {
    if (!rootAgentId) {
      textRef.current = "";
      setText("");
      return;
    }

    const session = resolveAgentSession(rootAgentId);
    if (!session) {
      textRef.current = "";
      setText("");
      return;
    }

    const key = agentStreamKey("compact", rootAgentId);

    return subscribeSummaryStream(session, key, {
      onReset: (event) => {
        textRef.current = "";
        setText("");
        setLabel(event.label ?? "");
      },
      onAppend: (accumulated) => {
        textRef.current += accumulated;
        setText(textRef.current);
      },
      onEnd: () => {},
      onSnapshot: (snap) => {
        if (snap && snap.status === "active") {
          const raw = snap.lines.map((line) => `${line}\n`).join("") + snap.pendingLine;
          textRef.current = raw;
          setText(raw);
          setLabel(snap.label ?? "");
        }
      },
    });
  }, [rootAgentId]);

  if (!enabled) return { text: "", label: "" };
  return { text, label };
}
