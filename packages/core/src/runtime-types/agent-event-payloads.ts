/**
 * Typed payloads for {@link AgentEventType}.
 *
 * Wire shape uses `payload` (not a loose `data` bag). Field names for tools keep
 * existing snake_case keys (`tool_name`, `tool_call_id`) used by Event→Log and app timing.
 */

import type { AgentEventType } from "./agent-events.js";
import type { AgentRetryStrategy } from "./agent-retry.js";
import type { McpConfigSourceKind, McpServerStatus } from "./mcp-status.js";

/** Explicit empty object for events with no fields. */
export type EmptyAgentEventPayload = Record<string, never>;

type PlanPhase = "off" | "planning" | "ready" | "executing" | "retro";

export type AgentEventPayloadMap = {
  "session:doc": {
    source?: string;
    length?: number;
    message?: string;
  };
  "session:memory": {
    memoryCount?: number;
    indexLength?: number;
  };
  "session:mcp": {
    configPath?: string;
    configLoadedFrom?: string;
    /**
     * Where the servers came from: `"session-options"` means the caller supplied them at
     * create time, which is why `.agents/mcp.json` did not apply. Absent means the file.
     * Kept separate from the two path fields because those are rendered as file paths.
     */
    configSourceKind?: McpConfigSourceKind;
    servers?: McpServerStatus[];
    toolCount?: number;
  };
  "session:skill": {
    count?: number;
    names?: string[];
  };
  "session:start": {
    cwd?: string;
  };
  "session:new": {
    /** The on-disk id of the session that was just created (replaces the previous one). */
    sessionId?: string;
    /** Why the switch happened — `/clear` is the only producer today. */
    reason?: string;
  };
  "session:restore": {
    sessionId?: string;
    messageCount?: number;
    tokenEstimate?: number;
    planPhase?: PlanPhase;
    autoMode?: boolean;
    /** Count of `media://` refs that could not be hydrated from disk on restore. */
    mediaMissing?: number;
  };
  /**
   * The active session id changes while the agent keeps running (a restore).
   *
   * Emitted BEFORE the log sink is re-pointed, so it lands in the session being LEFT — the
   * counterpart to {@link AgentEventPayloadMap}["session:restore"]. Without it a session's log has
   * arrivals and no departures, so it only exists for sessions that were entered and never records
   * that they were exited (the reported case: a log ending at the last prompt, with no hint that
   * another session was resumed from it).
   */
  "session:switch": {
    /** The on-disk id being left; the entries before this one describe this session. */
    fromSessionId?: string;
    /** The on-disk id being adopted (announced in full by the following `session:restore`). */
    toSessionId?: string;
    /** Transcript size of the session being left. */
    messageCount?: number;
    reason?: string;
  };
  "session:save-error": {
    target?: string;
    error?: string;
  };
  "prompt:submit": {
    prompt?: string;
    contextMessageCount?: number;
  };
  "prompt:before": {
    prompt?: string;
    hasTurnContext?: boolean;
  };
  "agent:thinking": EmptyAgentEventPayload;
  "agent:tool-start": {
    tool_name?: string;
    tool_call_id?: string;
    tool_input?: unknown;
    /**
     * How the call was dispatched, when that is not the ordinary tool phase.
     *
     * `"prefork"` marks the eager start of a `task` subagent while its arguments were
     * still streaming (see `task-prefork-middleware`). The same `tool_call_id` is started a
     * second time by the tool phase when the eager run is thrown away, and without this
     * field the two `Tool start: task` lines are indistinguishable — which is exactly what
     * hid a discarded-then-respawned subagent pair (one orphan, one real) from the log.
     */
    source?: "prefork";
    timestamp?: number;
  };
  "agent:tool-approval-request": {
    tool_name?: string;
    tool_call_id?: string;
    approval_id?: string;
    tool_input?: unknown;
  };
  "agent:tool-approval-resolved": {
    tool_name?: string;
    tool_call_id?: string;
    approval_id?: string;
    decision: "approved" | "denied";
    reason?: string;
  };
  "agent:tool-end": {
    tool_name?: string;
    tool_call_id?: string;
    duration_ms?: number;
    tool_output?: unknown;
    /**
     * True when the output carries a user-cancel marker (`cancelled` / `aborted`) rather
     * than being a genuine success.
     *
     * This event fires whenever the tool RETURNS, and a tool that catches its own abort
     * returns normally — `run_command` settles with `cancelled: true` and the partial
     * stdout, the `task` tool with `aborted: true`. Classifying by the return (which is
     * all TanStack reports: `info.ok`) therefore recorded a user-cancelled call as a
     * successful one, and the log bridge wrote `Tool end: …` with nothing about the
     * cancel. The verdict has to come from the output, because the return says nothing.
     */
    cancelled?: boolean;
    timestamp?: number;
  };
  "agent:tool-error": {
    tool_name?: string;
    tool_call_id?: string;
    error?: string;
    /**
     * True when the failure IS the user aborting the run, not a tool fault. Without it the
     * lifecycle stream cannot tell "the command failed" from "the user pressed Esc", so a
     * consumer counting failures counts cancels, and the log bridge reports a cancel as an
     * error. The row still settles as `output-error` (the abort reached TanStack as a throw),
     * which is exactly why the distinction has to be carried here.
     */
    cancelled?: boolean;
    timestamp?: number;
  };
  "agent:abort": {
    reason?: string;
  };
  "agent:retry": {
    attempt?: number;
    maxAttempts?: number;
    strategy?: AgentRetryStrategy;
    error?: string;
    delayMs?: number;
    retryAfterSeconds?: number;
  };
  "agent:stream-error": {
    error?: string;
  };
  "agent:stop": {
    reason?: string;
  };
  "agent:extension-error": {
    extensionId?: string;
    phase?: string;
    error?: string;
  };
  "memory:prefetch": {
    status?: string;
    count?: number;
    byteSize?: number;
    error?: string;
    filenames?: string[];
  };
  "memory:extract": {
    status?: string;
    count?: number;
    error?: string;
  };
  "memory:consolidate": {
    status?: string;
    before?: number;
    after?: number;
    count?: number;
    error?: string;
  };
  "llm:request": {
    model?: string;
    /** Provider id reported by the adapter usage (sticky across iterations). */
    provider?: string;
    iteration?: number;
    messagesCount?: number;
    toolsCount?: number;
  };
  "llm:response": {
    model?: string;
    /** Provider id reported by the adapter usage. */
    provider?: string;
    iteration?: number;
    finishReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheHitTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    costUsd?: number;
    roundElapsedMs?: number;
    firstTokenMs?: number;
    durationMs?: number;
  };
  "turn:summary": {
    outcome?: "finished" | "aborted" | "error";
    /** Driver-level tool-phase continuations executed in this run (each one streamed once). */
    phases?: number;
    toolCalls?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
    durationMs?: number;
  };
  "compaction:auto-start": {
    tokensBefore?: number;
  };
  "compaction:auto-complete": {
    tokensBefore?: number;
    tokensAfter?: number;
  };
  "compaction:auto-error": {
    phase?: string;
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
    phase?: string;
    error?: string;
  };
  "compaction:reactive-max-retries": EmptyAgentEventPayload;
  /**
   * The pre-fork queue: `task` calls admitted a few at a time, the rest waiting for a slot.
   *
   * A SNAPSHOT, not a delta — every emission carries the whole queue, so a receiver replaces its
   * set and a dropped, duplicated or re-ordered event cannot desync it. (Ordered by admission,
   * which is the order the rows would start in.) Without it a waiting task was invisible: it has
   * no subagent yet, so it appears in neither `subagents` nor `agent:tool-start`.
   */
  "subagent:queue": {
    /** Waiting tasks, in admission order. Empty means nothing is waiting. */
    queued?: Array<{
      toolCallId: string;
      /** The task's own label, when known — what the row shows while it waits. */
      description?: string;
    }>;
    /** Slots currently occupied by running tasks. */
    active?: number;
    /** The cap `active` is counted against (`maxConcurrentTasks`). */
    max?: number;
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
     * execute means the tool phase will spawn a *second* subagent for the same call id).
     */
    cause?: "run-start" | "run-finish" | "run-abort" | "run-error";
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
    parentTaskToolCallId?: string;
  };
  "subagent:error": {
    subagentId?: string;
    error?: string;
    parentTaskToolCallId?: string;
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
  "plan:enter": {
    phase?: PlanPhase;
  };
  "plan:ready": {
    phase?: PlanPhase;
    stepCount?: number;
    preservedExistingTodos?: boolean;
    todosSeeded?: boolean;
    planFilePath?: string | null;
  };
  "plan:execute": {
    phase?: PlanPhase;
    stepCount?: number;
    replacedExistingTodos?: boolean;
    planFilePath?: string | null;
  };
  "plan:cancel-execution": {
    phase?: PlanPhase;
    stepCount?: number;
  };
  "plan:todo-replaced": {
    stepCount?: number;
  };
  "plan:retro": {
    phase?: PlanPhase;
    stepCount?: number;
    planFilePath?: string | null;
  };
  "plan:complete": {
    phase?: PlanPhase;
    planFilePath?: string | null;
    stepCount?: number;
  };
  "plan:exit": {
    phase?: PlanPhase;
  };
};

export type AgentEventPayload<T extends AgentEventType> = AgentEventPayloadMap[T];

/** Compile-time completeness check against {@link AgentEventType}. */
type _MissingPayloadKeys = Exclude<AgentEventType, keyof AgentEventPayloadMap>;
type _AssertPayloadMapComplete = [_MissingPayloadKeys] extends [never] ? true : _MissingPayloadKeys;
const _payloadMapComplete: _AssertPayloadMapComplete = true;
void _payloadMapComplete;
