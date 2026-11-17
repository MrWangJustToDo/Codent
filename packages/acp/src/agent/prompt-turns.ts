/**
 * Prompt turns: `session/prompt`, `session/cancel`, and the wait that makes a prompt mean "the TURN
 * is over".
 *
 * Three rules decide this file's shape:
 *
 * - **a prompt resolves when the turn ends, not when a pump returns.** A turn can suspend on an
 *   approval or an `ask_user`: the dispatch returns, the client answers, and a new pump resumes the
 *   same turn. Resolving at that point tells the client the turn is over while its continuation
 *   still streams.
 * - **reads serialize per session, except the one that must not.** `bridge.chain` is one in-flight
 *   prompt per session — and a text-mode question is the exception, because the prompt it would
 *   queue behind is the very turn waiting for its answer (a parked `ask_user` keeps the status
 *   ACTIVE, so that turn never drains: a deadlock, not a pause).
 * - **settling comes before stopping.** Core's `stop` deliberately skips an approval nobody
 *   answered, so a turn only ends if its pending interactions are settled first.
 */

import { methods, RequestError } from "@agentclientprotocol/sdk";
import { findBuiltinCommand, isActiveStatus } from "@codent/core";

import { hasPendingTextAsk } from "../interaction/interactions.js";
import { dispatchSlashCommand, parseSlashCommand } from "../session/commands.js";
import { stopReasonFor } from "../session/session-status.js";
import { promptBlocksToContent } from "../wire/content.js";

import { notify } from "./notice.js";
import { TRACE_UPDATES } from "./trace.js";

import type { AcpAgentContext } from "./context.js";
import type { SessionBridge } from "./session-bridge.js";
import type { PromptRequest, StopReason } from "@agentclientprotocol/sdk";

export function registerPromptTurns(ctx: AcpAgentContext): void {
  const { app, options, bridges, interactions, config } = ctx;

  /**
   * End the running or suspended turn: `session/cancel`, or a prompt that arrives while it waits.
   *
   * Settling the approvals BEFORE `stop` is what bounds the turn: core's `stop` deliberately skips
   * an approval the user has not answered (`needsApproval && approved === undefined`), so without
   * this the session stays in `waiting` and the next prompt parks behind it forever.
   */
  const interrupt = async (bridge: SessionBridge): Promise<void> => {
    bridge.cancelled = true;
    await interactions.settlePendingInteractions(bridge);
    for (const controller of bridge.pending) controller.abort();
    bridge.pending.clear();
    bridge.pendingApprovals.clear();
    bridge.pendingAskUser.clear();
    await bridge.session.dispatch({ type: "stop" }).catch(() => undefined);
  };

  /**
   * Resolve when the turn is over (not merely suspended), or when this session was cancelled.
   * A hang here blocks the client's next submission (`bridge.chain` serializes prompts).
   *
   * A text-mode question is the one suspend point that must NOT be waited on, for that same reason:
   * its answer arrives as the next `session/prompt`, so this turn has to end (`end_turn`) and hand
   * the pen back. Waiting for the status to leave ACTIVE kept that answer queued behind the turn
   * that was waiting for it — a deadlock, not a pause. The tool row stays pending until the answer
   * arrives (or the interaction timeout settles it).
   */
  const waitForTurnEnd = (bridge: SessionBridge): Promise<void> =>
    new Promise((resolve) => {
      const isOver = (): boolean =>
        bridge.cancelled || hasPendingTextAsk(bridge) || !isActiveStatus(bridge.session.getSnapshot().status);
      if (isOver()) {
        resolve();
        return;
      }
      const timer = setInterval(finish, 250);
      const unsubscribe = bridge.session.subscribe(finish, { channels: ["state", "lifecycle"] });
      function finish(): void {
        if (!isOver()) return;
        clearInterval(timer);
        unsubscribe();
        resolve();
      }
    });

  const runPrompt = async (bridge: SessionBridge, params: PromptRequest): Promise<{ stopReason: StopReason }> => {
    bridge.cancelled = false;
    // The finish reason belongs to the run that just ended; a new prompt must not inherit it.
    bridge.lastFinishReason = undefined;
    const mapping = promptBlocksToContent(params.prompt, bridge.promptCaps);
    if (mapping.error) throw new Error(mapping.error);

    const text = typeof mapping.content === "string" ? mapping.content : undefined;
    // The no-elicitation fallback: a plain-text prompt answers a parked question instead of starting
    // a new turn. A slash command is still a command (the question stays pending).
    if (text && !text.trim().startsWith("/") && bridge.pendingApprovals.size === 0) {
      if (await interactions.answerPendingTextAsk(bridge, text.trim())) {
        await waitForTurnEnd(bridge);
        return { stopReason: stopReasonFor(bridge) };
      }
    }
    const parsed = text ? parseSlashCommand(text) : null;
    if (parsed && text) {
      // A slash command can change what the client's `configOptions` cache says — `/models` moves the
      // model AND the thinking depth, and `/mode …` moves the mode. The write handlers
      // (`set_config_option` / `set_mode`) re-advertise themselves, so this path must do it too:
      // without it the client keeps rendering the old selector values until something else happens.
      const before = config.mirrors(bridge);
      // The catalog's `command` is the contract, not the slash token: a rename/alias must keep
      // dispatch and rebinding working. `compact` needs its row opened before the dispatch so the
      // projector can wait for the command result instead of the restored status.
      const command = findBuiltinCommand(parsed.name)?.command;
      if (command === "compact") bridge.projector.beginManualCompaction();
      const result = await dispatchSlashCommand(
        bridge.session,
        bridge.session.getSnapshot(),
        parsed,
        options.models,
        bridge.selectedModelEntryIndex
      );
      if (command === "compact") {
        bridge.projector.finishManualCompaction(
          result.compact?.ok ? "completed" : "failed",
          result.compact?.error ?? (result.compact ? undefined : "compaction did not run")
        );
      }
      if (result.entryIndex !== undefined) bridge.selectedModelEntryIndex = result.entryIndex;
      if (result.handled) {
        // `/new` / `/clone` / `/resume` replace the underlying conversation while the client keeps
        // the same handle. Rebind before advertising, so the next update is tagged correctly.
        if (command === "session.new" || command === "session.clone" || command === "session.resume") {
          bridge.seenApprovals.clear();
          bridge.seenAskUser.clear();
          if (command === "session.new") bridge.approvalPolicy.clear();
          bridges.rebindAfterReplacement(bridge, command);
        }
        config.advertise(bridge, before);
        if (result.message) {
          ctx.emit(bridge.acpId, {
            sessionUpdate: "agent_message_chunk",
            messageId: `${bridge.acpId}-command-${Date.now()}`,
            content: { type: "text", text: result.message },
          });
        }
        return { stopReason: "end_turn" };
      }
    }

    try {
      const dispatched = await bridge.session.dispatch({ type: "send", content: mapping.content });
      // A rejected dispatch (queue full, run refused, ...) must reach the client as an error. The
      // old `await` ignored `ok`, so the prompt resolved `end_turn` having done nothing.
      if (!dispatched.ok) throw new Error(dispatched.error ?? "The agent could not start the turn");
      // A suspended turn (approval / ask_user) returns the pump while the SAME turn keeps streaming:
      // resolving here told the client the turn was over. Wait for the TURN.
      await waitForTurnEnd(bridge);
    } catch (error) {
      if (bridge.cancelled) return { stopReason: "cancelled" };
      throw error;
    }
    // A failed run has no ACP error stop reason. Emit the text before resolving, or the client
    // shows a completed turn with no explanation of what went wrong.
    const snapshot = bridge.session.getSnapshot();
    if (snapshot.status === "error") {
      notify(ctx.emit, bridge, snapshot.error?.trim() ? snapshot.error : "The run failed.", "error");
    }
    return { stopReason: stopReasonFor(bridge) };
  };

  app.onRequest(methods.agent.session.prompt, async (request) => {
    const params = request.params;
    if (await bridges.isChild(params.sessionId, false)) {
      throw RequestError.invalidParams(undefined, `Unknown session: ${params.sessionId}`);
    }
    const bridge = bridges.find(params.sessionId);
    if (!bridge) throw RequestError.invalidParams(undefined, `Unknown session: ${params.sessionId}`);
    // A prompt can follow `session/new` before the deferred seed tick ran. Flush the seed first so
    // the client gets `available_commands_update` etc. before this turn's tool/text updates.
    bridge.projector.flushDeferred();
    // A prompt arriving while the turn is SUSPENDED on the client (approval / form elicitation) is
    // force-submit: the answer it waits for was replaced by typing, so queueing waits on a client
    // that will never answer. The ONE exception is a text-mode question (a client without form
    // elicitation): its answer IS a plain prompt — but that prompt MUST NOT join `bridge.chain`,
    // because the turn it would queue behind is the very turn it answers.
    const answerText =
      params.prompt.length === 1 && params.prompt[0]?.type === "text" ? params.prompt[0].text.trim() : undefined;
    const answersTextAsk =
      Boolean(answerText) &&
      !answerText?.startsWith("/") &&
      bridge.pendingApprovals.size === 0 &&
      hasPendingTextAsk(bridge);
    if (answersTextAsk) {
      // Deliberately NOT chained: `bridge.chain` already holds the suspended turn. It becomes the
      // chain's new tail instead, so a later prompt still serializes behind the resumed run rather
      // than starting a second turn on the same session.
      const answered = (async () => {
        if (TRACE_UPDATES) {
          process.stderr.write(`[codent-acp] <- session/prompt ${params.sessionId} (answers a text-mode ask_user)\n`);
        }
        if (await interactions.answerPendingTextAsk(bridge, answerText ?? "")) {
          // The tool result resumes the parked run, and this prompt owns it until the TURN ends.
          await waitForTurnEnd(bridge);
          return { stopReason: stopReasonFor(bridge) };
        }
        // The question was settled out of band between the check and here: an ordinary prompt.
        if (bridge.pending.size > 0) await interrupt(bridge);
        return runPrompt(bridge, params);
      })();
      bridge.chain = answered.catch(() => undefined);
      return answered;
    }
    if (bridge.pending.size > 0) await interrupt(bridge);
    const run = bridge.chain.then(async () => {
      if (TRACE_UPDATES) process.stderr.write(`[codent-acp] <- session/prompt ${params.sessionId}\n`);
      const startedAt = Date.now();
      const result = await runPrompt(bridge, params);
      if (TRACE_UPDATES) process.stderr.write(`[codent-acp] -> ${result.stopReason} ${Date.now() - startedAt}ms\n`);
      return result;
    });
    bridge.chain = run.catch(() => undefined);
    return run;
  });

  app.onNotification(methods.agent.session.cancel, async (request) => {
    const bridge = bridges.find(request.params.sessionId);
    if (!bridge) return;
    await interrupt(bridge);
  });
}
