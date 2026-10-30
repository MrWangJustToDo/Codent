/**
 * Typed payloads for {@link AgentEventType}.
 *
 * Wire shape uses `payload` (not a loose `data` bag). Field names for tools keep
 * existing snake_case keys (`tool_name`, `tool_call_id`) used by Event→Log and app timing.
 */

import type { AgentEventType } from "./agent-events.js";
import type { AgentRetryStrategy } from "./agent-retry.js";
import type { AgentStatusTrigger, RunFinalizeReason } from "./agent-status.js";
import type { McpConfigSourceKind, McpServerStatus } from "./mcp-status.js";
import type { SessionJobSummary } from "./session-payloads.js";

/** Explicit empty object for events with no fields. */
export type EmptyAgentEventPayload = Record<string, never>;

type PlanPhase = "off" | "planning" | "ready" | "executing" | "retro";

/**
 * Why the active session changed (`/resume`, `/fork`, `/clone`).
 *
 * A closed union because "how did we get here" is the question the row exists to answer, and it used
 * to be hardcoded to `resume` for all three — a forked session claimed to be a resumed one.
 */
export type SessionSwitchReason = "resume" | "fork" | "clone";

/**
 * Subsystem a {@link SessionDiagnosticArea} note came from.
 *
 * A closed list, not a free string: the area decides the log category, so an unlisted area would
 * silently bucket into `system`. Adding a subsystem is a one-word edit here.
 */
export type SessionDiagnosticArea =
  | "doc"
  | "skill"
  | "memory"
  | "extension"
  | "middleware"
  | "capability"
  | "stream"
  | "context"
  | "session"
  | "jobs"
  | "model"
  | "tool"
  | "compaction";

/**
 * Who answered a tool approval.
 *
 * The log needs this to separate a human decision from machinery: the same `resolved` row shape is
 * produced by a y/n answer, by auto/plan mode, and by the command-safety policy.
 */
export type ToolApprovalSource = "user" | "auto" | "policy";

/** The mode field that changed (see `mode:change`). */
export type ModeChangeField = "auto" | "effort";

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
    /** The session was created by a new-session command. */
    reason?: "session-new";
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
    reason?: SessionSwitchReason;
  };
  "session:save-error": {
    target?: string;
    error?: string;
  };
  /**
   * A bootstrap step that degraded but did not abort the session (unreadable instruction file, an
   * import notice, memory init failure, skipped disk discovery) or a non-fatal lifecycle failure
   * with no dedicated event (a command-job reset during a session switch).
   *
   * One type with an `area` discriminator rather than four near-identical types: the level, the
   * shape and the reader's action are the same.
   */
  "session:diagnostic": {
    area: SessionDiagnosticArea;
    message: string;
    /**
     * Severity the emitting subsystem knows, defaulting to `warn`.
     *
     * A fallback that kept working (keyword memory selection) is `info`; a degraded capability is
     * `warn`; the "we did this anyway" bookkeeping is `debug`. The *caller* knows which of those it
     * is — but which **category** the row lands in, and whether the row exists at all, stays with
     * the policy, so this is not a level the emitter can use to bypass the table.
     */
    level?: "debug" | "info" | "warn" | "error";
    /**
     * Shallow, JSON-scalar detail fields. Deliberately NOT `Record<string, unknown>`: an open bag
     * would carry nested structures into the entry (the handler writes it verbatim), bypassing the
     * size cap every other payload field goes through. Arrays are numeric-only (segment token
     * counts) and are summarized as text by the recorder.
     */
    details?: Record<string, string | number | boolean | null | readonly number[]>;
    error?: string;
  };
  /** The one aggregated bootstrap row: attempted / active / failed extension counts. */
  "session:bootstrap-summary": {
    attempted: number;
    active: number;
    failed: number;
  };
  /** The user-visible name of the session changed (auto-title or `/rename`). */
  "session:title": {
    ok: boolean;
    name?: string;
    error?: string;
  };
  /** A persisted session was deleted. Emitted by its live owner before teardown, when one exists. */
  "session:deleted": {
    sessionId?: string;
  };
  /** A mid-conversation reset (session switch / teardown) that clears transient state. */
  "session:reset": {
    reason: string;
    previousStatus?: string;
    hadTodos?: boolean;
  };
  /**
   * The effective model changed (a `/models` switch, or a persisted-model fallback on resume).
   *
   * Without it the only evidence was the next `llm:request`, so "why did the answers change" had no
   * answer in the timeline.
   */
  "model:change": {
    from: string;
    to: string;
    style?: string;
    /** True when the requested model was not available and the previous/served one was kept. */
    fallback?: boolean;
    reason?: string;
  };
  /**
   * Auto mode or reasoning depth changed.
   *
   * The retained `session:mode` channel cannot serve the log: it is a projection event (an explicit
   * `false` in the policy table) and it re-publishes on every state change, so a reader of
   * `agent.log` could not tell that 595 of one session's 665 approvals were answered by the agent
   * itself. This is the append-only counterpart, emitted once per actual change.
   */
  "mode:change": {
    field: ModeChangeField;
    auto: boolean;
    reasoningEffort?: string;
  };
  "prompt:submit": {
    prompt?: string;
    contextMessageCount?: number;
    /**
     * Where the message came from: a normal send, or a queued steer/follow-up released into a
     * running turn. A released message is appended to the transcript by the queue drain, not by a
     * new `send`, so without this row (and this flag) the timeline showed a user message the model
     * answered with no prompt record behind it.
     */
    source?: "user" | "queued";
  };
  "prompt:before": {
    prompt?: string;
    hasTurnContext?: boolean;
  };
  /**
   * The model began reasoning on a turn.
   *
   * It used to carry no payload at all, which made the row (`Model reasoning started`) pure noise:
   * one real session wrote 280 of them with nothing to correlate against. The turn index is the same
   * run-scoped number `llm:request` / `llm:response` report, so the row can be read next to them.
   */
  "agent:thinking": { iteration?: number; model?: string };
  /**
   * One model turn began.
   *
   * `index` is the **run-scoped** model turn (1-based, counted per model call across every
   * tool-phase chat of the turn) — the same number `llm:request` / `llm:response` carry, so a
   * consumer can pair those with it. It is NOT `agent:iteration`.current, which restarts at 1 for
   * every `chat()`; the two scales are deliberately different and must not be paired.
   *
   * `max` is the per-`chat()` `maxIterations` budget (0 when unbudgeted), i.e. the ceiling on the
   * engine that is running this turn — NOT the denominator of `index`. After a few tool phases a
   * run legitimately reports `{ index: 7, max: 50 }` because each phase gets a fresh budget.
   */
  "turn:start": { index: number; max: number };
  /**
   * One model turn finished (a model request plus the tool calls it issued).
   *
   * Completes the `index` its own `turn:start` opened (run-scoped). An aborted turn is not reported
   * as finished.
   */
  "turn:end": { index: number; finishReason: string | null; toolCalls: number };
  /**
   * An assistant message began streaming. `firstOutput` marks the run's first assistant output — the
   * general fact behind "did the model actually answer?".
   */
  "message:start": { role: "assistant"; messageId: string; firstOutput: boolean };
  /** An assistant message was finalized (assistant text and tool-call count, not the part tree). */
  "message:end": {
    role: "assistant";
    messageId: string;
    firstOutput: boolean;
    text: string;
    toolCalls: number;
    finishReason: string | null;
  };
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
  };
  "agent:tool-approval-request": {
    tool_name?: string;
    tool_call_id?: string;
    approval_id?: string;
    tool_input?: unknown;
    /**
     * Nobody is being asked: auto mode / plan execution answers this approval itself.
     *
     * The flag rides the REQUEST because the decision may arrive in the same tick (auto-approve),
     * so a reader (and the log policy) can tell "a question was put to a human" from "the pump
     * parked for one microtask". Without it a real session recorded 1,330 approval rows for 665
     * calls that never involved the user.
     */
    auto?: boolean;
  };
  "agent:tool-approval-resolved": {
    tool_name?: string;
    tool_call_id?: string;
    approval_id?: string;
    decision: "approved" | "denied";
    reason?: string;
    /**
     * Who decided: the operator, auto/plan mode, or the command-safety policy.
     *
     * `reason` alone could not answer this (2 of 12,126 resolutions carried one), and the log's
     * approval rows are only meaningful if "the user approved this" and "the agent approved this"
     * are distinguishable.
     */
    source?: ToolApprovalSource;
  };
  /**
   * A CLIENT tool (`ask_user`) returned its result, supplied by the host.
   *
   * Client tools are executed by the host, so the server-side tool lifecycle has no end for them:
   * the request appears as `agent:tool-start` (the middleware sees the call) and the answer arrived
   * nowhere — a real session logged 2 questions and 0 answers. The host's `addToolResult` is the
   * one place every transport funnels through, so the fact is emitted there.
   */
  "agent:client-tool-result": {
    tool_call_id?: string;
    tool_name?: string;
    /** The same object the host supplied (summarized by the log consumer). */
    output?: unknown;
  };
  "agent:tool-end": {
    tool_name?: string;
    tool_call_id?: string;
    duration_ms?: number;
    tool_output?: unknown;
    /**
     * Whether the call itself succeeded.
     *
     * Always `true` today — the middleware routes a throw to `agent:tool-error`, so a returned
     * result means the tool ran. Carried anyway so a consumer does not have to infer "success"
     * from the event NAME (a tool may return an `exitCode: 1` result, which is a successful call
     * with a failing command). A future branch that reports a soft failure can then use the value
     * instead of minting another event shape.
     */
    ok?: boolean;
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
  };
  "agent:tool-error": {
    tool_name?: string;
    tool_call_id?: string;
    /** Wall-clock of the failed call, so a failure can be told from a hang. */
    duration_ms?: number;
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
  /** A tool's model-facing projection (`toModelOutput`) failed; the call still settles. */
  "tool:projection-error": {
    tool_name?: string;
    error: string;
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
    /**
     * Throw site, when the producer had an `Error`.
     *
     * The payload carries a message only by default; a loop step that threw (command safety,
     * plan sync) is exactly the case where the stack is the evidence, and dropping it sent readers
     * to the log module instead.
     */
    stack?: string;
  };
  "agent:stop": {
    reason?: string;
  };
  /**
   * One agent status transition. The policy table decides whether it is recorded: transitions whose
   * meaning is already carried by a dedicated event (approval, compaction, run start/finish) are
   * suppressed, so this is a fact about the state machine, not a line per flip.
   */
  "agent:status": {
    from: string;
    to: string;
    /** Why the status moved; the same closed union `setStatus` accepts. */
    trigger?: AgentStatusTrigger;
  };
  "agent:extension-error": {
    extensionId?: string;
    /**
     * Where the failure happened — a free string because the runner reports a dozen phases
     * (`activate`, `deactivate`, `flush`, `interceptor`, `event-observer`, `message-transform`,
     * `disable-notice`, `model-access`, `turn-context`) and bootstrap adds its own (`load`, `config`,
     * `disk`). Kept open so a new phase is not a type change in a wire contract.
     */
    phase?: string;
    error?: string;
  };
  /**
   * An extension's own log output (`ctx.logger`). Observable on purpose: the log consumer is the
   * wildcard subscriber, and internal events are withheld from it — an internal `extension:log`
   * would never be recorded (the same trap `validate-extension-event-observation` §7b documents).
   */
  "extension:log": {
    extensionId: string;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    /**
     * Requested log category, when the caller named one (`ctx.logger.log(level, category, msg)`).
     *
     * A plain string rather than `LogCategory`: this file describes the wire payload, and the log
     * vocabulary lives in the log layer — the handler narrows it and falls back to `hooks`.
     */
    category?: string;
  };
  /** One middleware hook invocation (opt-in echo, `MY_AGENT_LOG_HOOKS`). */
  "hooks:echo": {
    middleware: string;
    hook: string;
    phase?: string;
    iteration?: number;
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
    /**
     * 1-based model-call index within the current user turn.
     *
     * Counted per model call (`onIteration`), the only hook that fires for a pump's one-call chat
     * AND for a worker's multi-iteration chat alike. `llm:request` announces the turn it is about
     * to run; `llm:response` reports the index that turn actually got. A restart-style retry
     * (429 / capability strip / reactive compact) is another model call and takes the next index —
     * `agent:retry` is the event that marks it.
     */
    iteration?: number;
    messagesCount?: number;
    toolsCount?: number;
  };
  "llm:response": {
    model?: string;
    /** Provider id reported by the adapter usage. */
    provider?: string;
    iteration?: number;
    /**
     * Model calls this ONE chat covered.
     *
     * A pump restarts `chat()` per tool phase (1), while a subagent runs its whole loop in one
     * `chat()` (N). Without it the worker's single row read as one call and its per-round cost was
     * invisible.
     */
    iterations?: number;
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
  /**
   * A one-shot LLM call outside the conversation turn (memory selection, titles, summaries).
   *
   * `complete` marks a usable answer; `error` carries the failure so the timeline says why a title or
   * a memory pick fell back instead of silently taking the cheap path.
   */
  "side-query:mode": {
    purpose: string;
    mode: string;
    reason?: string;
    /** Model that ran (or was about to) — an extension may pick one that is not the session's. */
    model?: string;
  };
  "side-query:error": {
    purpose: string;
    mode: string;
    error: string;
    /** Model that ran (or was about to) — an extension may pick one that is not the session's. */
    model?: string;
    durationMs?: number;
    /** Raw response excerpt for a parse failure — the only evidence of what the model actually said. */
    rawExcerpt?: string;
    /** The mode the caller retried in, when this failure led to a fallback attempt. */
    fallback?: string;
  };
  "turn:summary": {
    outcome?: RunFinalizeReason;
    /**
     * The turn stopped to wait for something (approval / `ask_user`), so it has no outcome yet.
     *
     * Set instead of `outcome` — the two are mutually exclusive, and the reason this field exists: a
     * summary that says "Turn complete" while the run is parked on an approval reads as a finished
     * turn, which is how 423 of 846 recorded summaries described a turn that had not ended.
     */
    paused?: true;
    /** Driver-level tool-phase continuations executed in this run (each one streamed once). */
    phases?: number;
    /**
     * Tool calls that reached an outcome in THIS pump — settled, not created.
     *
     * "Settled" is `state: "complete" | "error"`, which covers ran, failed and **cancelled**
     * (`settleToolCalls` marks in-flight calls complete/error on abort). A **denied** call is not
     * counted: it stays `approval-responded` (with a synthesized `tool-result`) and never runs.
     */
    toolCalls?: number;
    /** Token/cost deltas for THIS pump — a turn split by approvals reports each pump separately. */
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
    /** Wall-clock of this pump (a waiting pump's duration is its own, not the whole turn's). */
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
  /**
   * A bus observer/interceptor threw and the failure was contained.
   *
   * It used to be a direct `AgentLog` write from the bus scope: the one diagnostic with no event
   * behind it, invisible to the policy table and to every other consumer.
   */
  "agent:event-handler-error": {
    /** Interceptor pattern (or event type) that failed. */
    pattern: string;
    /** Event type being dispatched when it threw. */
    event: string;
    /** Which dispatch mode failed. */
    kind: "interceptor" | "observer";
    error?: string;
  };
  /**
   * A turn nobody prompted (a background job finished, or a reminder fired). It explains why the
   * agent started working without a `prompt:submit`, which was otherwise unreadable.
   */
  "run:wake": {
    cause: "job" | "reminder" | "unknown";
  };
  /**
   * A background job changed lifecycle state (created, or reached a terminal status).
   *
   * `session:jobs` is the retained SNAPSHOT and is deliberately not logged; this is the
   * append-only row. Without it a finished job existed only as a wake turn, and the timeline could
   * not say which command finished or how it ended.
   */
  "job:changed": {
    jobId: string;
    command?: string;
    status: SessionJobSummary["status"];
    /** Absent on the first observation (the job was just created). */
    previousStatus?: SessionJobSummary["status"];
    exitCode?: number | null;
  };
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

// Completeness is enforced where it can actually fail: `AGENT_EVENT_META` is
// `satisfies Record<AgentEventType, …>` (a new event fails to compile until it has an entry), and
// every emit site is typed against `AgentEventPayloadMap[T]`. The former check here was
// `Exclude<AgentEventType, keyof AgentEventPayloadMap>` — and `AgentEventType` IS that key union, so
// it was `never` by construction and could never fail.
