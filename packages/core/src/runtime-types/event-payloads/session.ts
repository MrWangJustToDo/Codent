/**
 * Session lifecycle, model/mode switches and prompt submission.
 *
 * One family of {@link AgentEventPayloadMap} (`agent-event-payloads.ts`), split so the map stays
 * readable and no single file sits at the line ceiling.
 */

import type { McpConfigSourceKind, McpServerStatus } from "../mcp-status.js";
import type { PlanPhase, SessionSwitchReason, SessionDiagnosticArea, ModeChangeField } from "./payload-primitives.js";

export type SessionEventPayloads = {
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
    /**
     * The effective model after adoption. The restore path suppresses the usual
     * `model:change` / `mode:change` rows (they would be emitted while the log sink already points
     * at the target but the envelope still names the departure), so this record carries the
     * resulting identity instead.
     */
    model?: string;
    /** The persisted reasoning depth adopted by the restore. */
    reasoningEffort?: string;
    /** The persisted model id was not offered and the session's creation model was kept. */
    modelFallback?: boolean;
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
    /** Loaded but switched off by configuration; the remainder of `attempted`. */
    disabled?: number;
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
   * One synthetic context block was injected into the wire for this model call.
   *
   * The block itself is persisted as a `<ctx kind=…>` message; this row records the ADMISSION
   * decision (source + kinds), which is what explains a model call whose wire differs from the
   * transcript. Emitted only when something is actually injected (debug).
   */
  "context:inject": {
    source: "turn-context" | "todo-reminder" | "repeat-reminder" | "background";
    /** `<ctx kind=…>` values (section keys, or the shared `reminder` / background kinds). */
    kinds: string[];
    /** Characters injected into the wire, a cheap size signal (not a token count). */
    bytes?: number;
    /** `changed`/`missing` for hash admission; `counter` for reminders; `completion` for a push. */
    reason?: "changed" | "missing" | "counter" | "completion";
  };
  /**
   * A transcript write was requested (and, unless skipped, attempted).
   *
   * Long turns were unobservable: a session file could sit unchanged for 25 minutes while the run
   * was clearly alive. `written:false` with `skipped:true` means the fingerprint said "unchanged";
   * `written:false` without it means the write was refused (switch/closed) or failed.
   */
  "session:persist": {
    reason: "user-message" | "pump-complete" | "force";
    messages: number;
    written: boolean;
    /** The fingerprint short-circuit: no write was attempted. */
    skipped?: boolean;
    durationMs?: number;
  };
};
