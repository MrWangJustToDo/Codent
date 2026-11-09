import { useEffect, useState } from "react";
import { toRaw } from "reactivity-store";

import { getActiveSession } from "../utils/session-resolve.js";
import { resolveTaskSubagent } from "../utils/task-subagent.js";

import { useAgent } from "./use-agent.js";

import type { AgentSessionSubagentSummary } from "@codent/core";

function findSubagentByTask(taskId: string): AgentSessionSubagentSummary | undefined {
  if (!taskId) return undefined;
  return resolveTaskSubagent(getActiveSession()?.getSnapshot().subagents ?? [], taskId);
}

/** Resolve the subagent summary for a parent task tool call (Session snapshot). */
export const useSubAgents = ({ taskId }: { taskId: string }) => {
  const parentSession = toRaw(useAgent((s) => s.session));
  const [subagent, setSubagent] = useState<AgentSessionSubagentSummary | undefined>(() => findSubagentByTask(taskId));

  useEffect(() => {
    const existing = findSubagentByTask(taskId);
    if (existing) {
      setSubagent(existing);
    }

    if (!parentSession) return;

    return parentSession.subscribe(
      (event) => {
        // The retained `subagents` projection is authoritative: it carries the whole row list,
        // including changes that emit no lifecycle event (a task row's usage/queue admission is
        // explicitly excluded from the lifecycle stream). `state` stays as a safety net for a
        // publisher that predates the channel.
        if (event.channel === "subagents") {
          setSubagent(findSubagentByTask(taskId));
          return;
        }
        if (event.channel === "lifecycle") {
          if (
            event.payload.type === "subagent:created" ||
            event.payload.type === "subagent:started" ||
            event.payload.type === "subagent:phase" ||
            event.payload.type === "subagent:completed" ||
            // A failed/cancelled task is re-published through this event (task-result.ts), so
            // leaving it out kept the row showing its last active phase until an unrelated state
            // event happened to arrive.
            event.payload.type === "subagent:error" ||
            event.payload.type === "subagent:destroyed"
          ) {
            setSubagent(findSubagentByTask(taskId));
          }
          return;
        }
        if (event.channel === "state") {
          setSubagent(findSubagentByTask(taskId));
        }
      },
      { channels: ["subagents", "lifecycle", "state"] }
    );
  }, [taskId, parentSession]);

  return subagent;
};
