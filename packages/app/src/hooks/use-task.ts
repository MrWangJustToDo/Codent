import { BEGIN_SUMMARY_TOOL_NAME } from "@codent/core";
import { useEffect, useState } from "react";

import { resolveAgentSession } from "../utils/session-resolve.js";
import { isToolCallPart, parseToolInput } from "../utils/tool-part.js";

import { useSubAgents } from "./use-sub-agents.js";

import type { AgentSession, TokenUsage } from "@codent/core";
import type { ToolCallState, UIMessage } from "@tanstack/ai";

type TaskToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  state: ToolCallState;
};

export type TaskRunPhase = "tools" | "summary";

/**
 * Core's live task phase. `limit` means the step budget cut the subagent off (the
 * report came from the progress-summary fallback), which is NOT a natural finish.
 */
type CoreTaskPhase = "running" | "summary" | "limit";

/**
 * Collapse the live phase onto this view's two-value phase.
 *
 * Both terminal phases stream a report, and every consumer here only asks "is the
 * subagent past tool work" (as the `begin_summary` scan used to decide). The
 * limit/natural distinction is surfaced separately, so it does not belong in this
 * axis — but it must not be silently dropped either: unknown phases fall back to
 * `tools` rather than assuming a report is coming.
 */
const toViewPhase = (phase: CoreTaskPhase): TaskRunPhase => (phase === "running" ? "tools" : "summary");

const getTaskPhaseFromMessages = (messages: UIMessage[]): TaskRunPhase => {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.parts) {
      if (isToolCallPart(part) && part.name === BEGIN_SUMMARY_TOOL_NAME) {
        return "summary";
      }
    }
  }
  return "tools";
};

const getTaskToolsFromMessages = (messages: UIMessage[]): TaskToolCall[] => {
  const tools: TaskToolCall[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.parts) {
      if (!isToolCallPart(part)) continue;
      if (part.name === BEGIN_SUMMARY_TOOL_NAME) continue;
      tools.push({
        toolCallId: part.id,
        toolName: part.name,
        input: parseToolInput(part),
        state: part.state,
      });
    }
  }
  return tools;
};

const readTaskInfo = (session: AgentSession | null, taskPhase?: CoreTaskPhase) => {
  const snapshot = session?.getSnapshot();
  const messages = snapshot?.messages ?? [];
  const allTools = getTaskToolsFromMessages(messages);
  const usage: TokenUsage | null = snapshot ? { ...snapshot.usage.total } : null;
  return {
    allTools,
    total: allTools.length,
    usage,
    // Authoritative phase machine first; message scan is a fallback for
    // transcripts that predate live phase tracking.
    phase: taskPhase ? toViewPhase(taskPhase) : getTaskPhaseFromMessages(messages),
    // Live LLM-retry state from the child agent (null when not retrying).
    retry: snapshot?.retry ?? null,
    // Subagent loop progress (1-based iteration vs its budget; `current` is 0 when
    // the child has not started). The lifecycle middleware reports it from the same
    // `buildAgentRunner` pipeline the main chat uses, so a subagent gets the same
    // retained `iteration` channel — nothing extra has to be threaded for it.
    iteration: snapshot?.iteration ?? { current: 0, max: 0 },
  };
};

export const useTask = ({ taskId }: { taskId: string }) => {
  const subagent = useSubAgents({ taskId });
  const [info, setInfo] = useState(() => readTaskInfo(null));

  useEffect(() => {
    if (!subagent?.id) return;

    const childSession = resolveAgentSession(subagent.id);
    if (!childSession) return;

    const refresh = () => {
      setInfo(readTaskInfo(childSession, subagent.taskPhase));
    };

    refresh();
    return childSession.subscribe(
      () => {
        refresh();
      },
      { channels: ["messages", "usage", "state", "lifecycle", "iteration"] }
    );
  }, [subagent, subagent?.id, subagent?.taskPhase]);

  return { ...info, agent: subagent, phase: taskId ? info.phase : ("tools" as const) };
};
