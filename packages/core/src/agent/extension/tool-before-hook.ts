/**
 * One `tool:before:*` interception per tool call.
 *
 * The authorization pipeline runs before an approval prompt (so an extension can deny without
 * asking), while the extensions middleware runs before execution (so it can apply a skip/args
 * rewrite). Both must observe the SAME interception: running the event twice would double side
 * effects, and letting the middleware win would mean the pipeline decided without the extension's
 * verdict. This ledger is the shared per-call outcome.
 */

import type { ExtensionRunner } from "./runner.js";
import type { ToolBeforeEvent } from "./types.js";

export interface ToolBeforeHookOutcome {
  skip: boolean;
  reason?: string;
  modifiedArgs?: unknown;
}

export interface ToolBeforeHookInput {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** Omitted when the agent has no disk session (see `ToolBeforePayload.sessionId`). */
  sessionId?: string;
}

/** Reason attached when a gate cannot produce a verdict (threw, or the chain timed out). */
export const TOOL_GATE_FAILED_REASON = "A tool:before hook failed, so the call was refused rather than approved.";

/** Emit the interceptable event once and return its verdict. */
export async function emitToolBeforeHook(
  runner: ExtensionRunner,
  input: ToolBeforeHookInput
): Promise<ToolBeforeHookOutcome> {
  const event: ToolBeforeEvent = {
    type: `tool:before:${input.toolName}`,
    payload: {
      toolName: input.toolName,
      args: input.args,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
    defaultReturn: undefined,
  };
  await runner.getEventBus().intercept(event);
  // Two ways to be refused: an interceptor said so (`skip`, whether it set the field or returned
  // `false` — the bus normalizes both), or a gate failed and left no verdict (`handlerError`).
  // Failing closed is the same rule the timeout path already applied; reading only `skip` let a
  // throwing deny-hook approve every call it matched.
  //
  // `failed` is checked independently of `skip`: the timeout path sets BOTH, and it must still name
  // the failure reason rather than look like a deliberate extension veto.
  const failed = event.handlerError === true;
  const reason = event.reason ?? (failed ? TOOL_GATE_FAILED_REASON : undefined);
  return {
    skip: event.skip === true || failed,
    ...(reason !== undefined ? { reason } : {}),
    ...(event.modifiedArgs !== undefined ? { modifiedArgs: event.modifiedArgs } : {}),
  };
}

export class ToolBeforeHookLedger {
  private readonly outcomes = new Map<string, ToolBeforeHookOutcome>();
  private readonly inFlight = new Map<string, Promise<ToolBeforeHookOutcome>>();
  /** Bumped by `clear`; a producer that settles after a turn boundary must not repopulate. */
  private epoch = 0;

  /**
   * Run the producer once per toolCallId; concurrent callers join the same promise.
   *
   * The outcome is kept so the other seam can read it without re-emitting. `clear()` at the tool
   * phase boundary bounds the map.
   */
  runOnce(toolCallId: string, producer: () => Promise<ToolBeforeHookOutcome>): Promise<ToolBeforeHookOutcome> {
    const existing = this.outcomes.get(toolCallId);
    if (existing) return Promise.resolve(existing);
    const running = this.inFlight.get(toolCallId);
    if (running) return running;

    const epoch = this.epoch;
    const promise = producer()
      .then((outcome) => {
        if (this.epoch === epoch) this.outcomes.set(toolCallId, outcome);
        return outcome;
      })
      .finally(() => this.inFlight.delete(toolCallId));
    this.inFlight.set(toolCallId, promise);
    return promise;
  }

  /** A previously produced outcome (no event emitted), if the other seam already ran. */
  get(toolCallId: string): ToolBeforeHookOutcome | undefined {
    return this.outcomes.get(toolCallId);
  }

  clear(): void {
    this.epoch += 1;
    this.outcomes.clear();
    this.inFlight.clear();
  }
}
