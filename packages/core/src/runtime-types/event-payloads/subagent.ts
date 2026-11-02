/**
 * Subagent (task) lifecycle, queueing and phase transitions.
 *
 * One family of {@link AgentEventPayloadMap} (`agent-event-payloads.ts`), split so the map stays
 * readable and no single file sits at the line ceiling.
 */

export type SubagentEventPayloads = {
  /**
   * The pre-fork queue: `task` calls admitted a few at a time, the rest waiting for a slot.
   *
   * A SNAPSHOT, not a delta — every emission carries the whole queue, so a receiver replaces its
   * set and a dropped, duplicated or re-ordered event cannot desync it. (Ordered by admission,
   * which is the order the rows would start in.) Without it a waiting task was invisible: it has
   * no subagent yet, so it appears in neither `subagents` nor `agent:tool-start`.
   *
   * Deliberately no occupancy counts. A waiting entry exists *because* the cap is full, so `n/m`
   * carried no information — and it could be actively wrong: the cap is re-read per admission, so
   * lowering it mid-run makes `active > max` ("4/2 running"), and raising it does not promote until
   * a run ends. The only non-derivable number would be the cap itself, and nothing needs it yet.
   */
  "subagent:queue": {
    /** Waiting tasks, in admission order. Empty (or absent) means nothing is waiting. */
    queued?: Array<{
      toolCallId: string;
      /** The task's own label, when known — what the row shows while it waits. */
      description?: string;
    }>;
  };
  "subagent:created": {
    subagentId?: string;
    /**
     * The parent `task` tool call this subagent serves.
     *
     * Without it a subagent's lifecycle is only attributable to the parent *agent*, so two
     * children spawned under one `task` call (a discarded eager one and the real one) look
     * like unrelated subagents. The id makes the pairing greppable from either side.
     */
    parentTaskToolCallId?: string;
  };
  "subagent:started": {
    subagentId?: string;
    description?: string;
    parentTaskToolCallId?: string;
  };
  "subagent:prefork-discarded": {
    /** The `task` tool call whose eagerly started run was thrown away. */
    toolCallId?: string;
    /**
     * Why the run was discarded — the run boundary that ended it. `run-start` is a
     * duplicate `TOOL_CALL_END` for an already-registered call during one stream, which
     * means the tool calls are being re-strand with fresh ids; `run-finish`/`run-abort`/
     * `run-error` are the attempt ending (a discarded run whose tool call is still going to
     * execute means the tool phase will spawn a *second* subagent for the same call id);
     * `tool-rejected` is the call itself being refused (an extension interceptor's
     * `event.skip`, a mode policy, a tool cache), so no run boundary is involved at all.
     */
    cause?: "run-start" | "run-finish" | "run-abort" | "run-error" | "tool-rejected";
    /** Subagents already spawned for the call, whose work was aborted (orphaned). */
    subagentIds?: string[];
  };
  "subagent:completed": {
    subagentId?: string;
    summary: string;
    iterations?: number;
    /** Iteration budget the count was measured against (structured log data field). */
    maxIterations?: number;
    durationMs?: number;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    /**
     * What the child's run cost, in USD.
     *
     * The parent's `llm:response` rows only cover the parent's own calls (a worker's whole run is
     * one `chat()`), so without this a reader reconciling `agent.log` against the session's
     * `cost` finds a hole — measured at 31% ($1.34 logged vs $1.94 billed) in one session.
     */
    costUsd?: number;
    parentTaskToolCallId?: string;
  };
  "subagent:error": {
    subagentId?: string;
    error?: string;
    parentTaskToolCallId?: string;
    // Run facts, same shape as `subagent:completed`: a failed or cancelled child spent real tokens
    // and time, and without these the parent's log could not account for them (the completed rows
    // were the only ones carrying usage/cost).
    iterations?: number;
    maxIterations?: number;
    durationMs?: number;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
    /**
     * Why the run stopped, when it was aborted rather than failing.
     *
     * `cancelled` alone merges every abort into one verdict. The reasons differ in
     * *who* stopped the work: `user` is the operator (Esc), while `parent-run` /
     * `parent-stop` are the agent's own lifecycle (a discarded run, a stopped parent)
     * — and a discarded run is what leaves an orphan subagent behind. Reporting a
     * restart as "cancelled by user" is the misattribution this field exists to end.
     */
    stopReason?: "user" | "parent-run" | "parent-stop" | "unknown";
    /**
     * True when the run was cut short by the user rather than failing.
     *
     * The abort path reuses this event (a cancelled subagent has no other terminal
     * event), so without the flag a cancel was written at `error` level carrying the
     * subagent's partial narration as if it were a fault message. That is the same
     * conflation `agent:tool-error` already avoids, expressed the same way.
     */
    cancelled?: boolean;
  };
  "subagent:destroyed": {
    subagentId?: string;
    parentTaskToolCallId?: string;
  };
  "subagent:phase": {
    subagentId?: string;
    /**
     * Task-level phase: running (exploring), summary (the subagent is writing its
     * own report), or limit (budget cutoff; the progress-summary fallback is
     * writing the report instead).
     */
    phase?: "running" | "summary" | "limit";
    parentTaskToolCallId?: string;
  };
  "subagent:progress-summary-error": {
    subagentId?: string;
    parentAgentId?: string;
    error?: string;
  };
};
