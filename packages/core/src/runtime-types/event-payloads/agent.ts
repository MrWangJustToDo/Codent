/**
 * Run/turn/message/LLM lifecycle, memory, extensions and background work.
 *
 * One family of {@link AgentEventPayloadMap} (`agent-event-payloads.ts`), split so the map stays
 * readable and no single file sits at the line ceiling.
 */

import type { AgentRetryStrategy } from "../agent-retry.js";
import type { AgentStateEventType } from "../agent-state.js";
import type { AgentStatusTrigger, RunFinalizeReason } from "../agent-status.js";
import type { SessionJobSummary } from "../session-payloads.js";

export type AgentEventPayloads = {
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
    /** The transition event that produced it (the closed state-machine vocabulary). */
    event?: AgentStateEventType;
    /** The wait the transition established, when it is a pause. */
    wait?: "approval" | "question";
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
   * A turn nobody prompted (background work finished). It explains why the agent started working
   * without a `prompt:submit`, which was otherwise unreadable. `unknown` is the wire-side fallback
   * for a value this build does not recognise; producers emit `job` or `task`.
   */
  "run:wake": {
    cause: "job" | "task" | "unknown";
  };
  /**
   * A background unit of work changed lifecycle state (created, or reached a terminal status).
   *
   * `session:jobs` is the retained SNAPSHOT and is deliberately not logged; this is the
   * append-only row. Without it a finished job existed only as a wake turn, and the timeline could
   * not say which command finished or how it ended.
   *
   * Both kinds report here (`kind` distinguishes them) — one append-only row per transition is what
   * keeps the log a story rather than two parallel ones.
   */
  "job:changed": {
    jobId: string;
    kind: SessionJobSummary["kind"];
    /** The command line, or the task's label — never rendered into the payload's attrs. */
    label: string;
    status: SessionJobSummary["status"];
    /** Absent on the first observation (the job was just created). */
    previousStatus?: SessionJobSummary["status"];
    exitCode?: number | null;
  };
};
