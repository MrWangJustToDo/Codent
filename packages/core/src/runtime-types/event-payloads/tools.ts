/**
 * Tool call lifecycle: start, approval, end, error and projection failure.
 *
 * One family of {@link AgentEventPayloadMap} (`agent-event-payloads.ts`), split so the map stays
 * readable and no single file sits at the line ceiling.
 */

import type { ToolApprovalSource } from "./payload-primitives.js";

export type ToolEventPayloads = {
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
};
