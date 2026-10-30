/**
 * The two client round-trips a run can need: permission for a tool, and a question for the user.
 *
 * Both are fire-and-forget from the projector's point of view — the session's own channels carry the
 * result, so nothing here returns a value. What they share is the shape: register a controller in
 * `bridge.pending` (so cancel/close can abort it), ask the client, dispatch the answer back, and
 * never leave the session parked. Every suspend point settles: a client cancel, a timeout, a
 * transport failure and `session/cancel` all resolve the corresponding approval/question.
 *
 * Split out of `agent.ts` for size, which is also why the bridge state arrives as a narrow interface
 * rather than the app's own `SessionBridge`: these handlers touch a handful of fields.
 */

import { methods } from "@agentclientprotocol/sdk";
import {
  BUILTIN_TOOL_NAMES,
  buildAskUserOutput,
  getBuiltinToolPresentation,
  resolvePendingInteractions,
} from "@codent/core";

import { shouldSuppressApproval, toolInputFor, toolPartFor } from "./approvals.js";
import {
  buildElicitationRequest,
  mapElicitationResponse,
  mapPermissionOutcome,
  permissionOptions,
} from "./permissions.js";
import { toolCallInfo } from "./tools.js";

import type { AcpClientEnv } from "./client-env.js";
import type { SessionUpdate } from "./types.js";
import type { AgentContext, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { AgentSession, PendingInteractionEntry } from "@codent/core";

/** Default window for a human to answer before the interaction is settled as denied/cancelled. */
export const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60 * 1000;

/** What an interaction handler reads and writes on a live session. */
export interface InteractionBridge {
  session: AgentSession;
  /** The external ACP session id every request/notification is tagged with. */
  acpId: string;
  /** The session's workspace root, for the absolute paths a tool call's `locations` carry. */
  rootPath: string;
  /** Client-backed env, when `--client-env` is on — decides who owns a write approval. */
  clientEnv?: AcpClientEnv;
  /** Client advertises `elicitation.form`, so `ask_user` can be a real question. */
  elicitation: boolean;
  /** Client advertises `session.notices`, so a cancelled/timed-out interaction can be announced. */
  notices: boolean;
  /** Already-asked approvals / questions, so a replayed channel snapshot asks once. */
  seenApprovals: Set<string>;
  seenAskUser: Set<string>;
  /** In-flight requests, aborted on cancel/close. */
  pending: Set<AbortController>;
  /**
   * The in-flight `session/request_permission` per approval id.
   *
   * `pending` alone cannot answer "which request belongs to this approval", and an approval can be
   * settled by something other than the client — turning on auto mode resolves every pending approval
   * in the session. That request must be cancelled, or the client keeps a dialog for a tool that
   * already ran and a late answer re-decides it.
   */
  pendingApprovals: Map<string, AbortController>;
  /**
   * The in-flight question per `ask_user` tool call. `mode: "text"` is the no-elicitation fallback:
   * the next plain-text prompt answers it (`answer`), instead of cancelling the tool immediately.
   */
  pendingAskUser: Map<
    string,
    {
      controller: AbortController;
      ask: AskUserRequest;
      mode: "form" | "text";
      answer?: (text: string) => Promise<void>;
    }
  >;
  /**
   * Session-scoped "always" decisions, keyed by tool identity.
   *
   * `true` = allow, `false` = reject. The key is the tool name, or for `run_command` the leading
   * program, so an `allow_always` on `git` does not auto-approve `rm -rf`.
   */
  approvalPolicy: Map<string, boolean>;
  /** Counted so close can report how many approvals the client granted itself. */
  clientOwnedApprovals: number;
}

/** A tool approval the session is waiting on. */
export interface ApprovalRequest {
  approvalId: string;
  toolName: string;
  toolCallId: string;
}

/** An `ask_user` question the session is waiting on. */
export interface AskUserRequest {
  toolCallId: string;
  question: string;
  options?: string[];
  multiSelect?: boolean;
}

export interface InteractionHandlerContext {
  /** The agent-side connection handle (read lazily — it may not be up yet). */
  client: () => AgentContext;
  /** Send a `session/update` for one session. */
  emit: (acpId: string, update: SessionUpdate) => void;
  /** How long a client has to answer. Defaults to {@link DEFAULT_INTERACTION_TIMEOUT_MS}. */
  timeoutMs?: number;
  onClientOwnedApproval: () => void;
}

/** What {@link createInteractionHandlers} hands back — the projector's `onInteraction` entry points. */
export interface InteractionHandlers {
  handleInteractions: (bridge: InteractionBridge, payload: unknown) => Promise<void>;
  /**
   * Answer the first text-mode `ask_user` with a plain-text prompt (the no-elicitation fallback).
   * Returns false when no text-mode question is pending.
   */
  answerPendingTextAsk: (bridge: InteractionBridge, text: string) => Promise<boolean>;
  /**
   * Resolve every outstanding approval/question as denied/cancelled.
   *
   * Called by `session/cancel`, a force-submit prompt and connection close: the client is no longer
   * going to answer, and leaving the approval pending parks the next prompt forever.
   */
  settlePendingInteractions: (bridge: InteractionBridge) => Promise<void>;
}

/**
 * The identity an "always" decision applies to.
 *
 * Most tools are approved by name. A shell command is not: `allow_always` on `git status` must not
 * approve `rm -rf /`, so the leading program is part of the key.
 */
export function approvalPolicyKey(
  approval: Pick<ApprovalRequest, "toolName" | "toolCallId">,
  messages: ReadonlyArray<{ parts?: ReadonlyArray<unknown> }>
): string {
  if (approval.toolName !== BUILTIN_TOOL_NAMES.runCommand) return approval.toolName;
  const input = toolInputFor(messages, approval.toolCallId) as { command?: unknown } | undefined;
  const command = typeof input?.command === "string" ? input.command.trim() : "";
  const program = command.split(/\s+/)[0] ?? "";
  return `${approval.toolName}:${program}`;
}

/**
 * Whether the session is parked on a TEXT-mode question — the no-form fallback, where the answer
 * arrives as the NEXT plain prompt instead of as a client request.
 *
 * The owning turn must END when this is true (see `waitForTurnEnd`): that answer prompt cannot be
 * queued behind the very turn it answers, or the queue never drains.
 */
export function hasPendingTextAsk(bridge: Pick<InteractionBridge, "pendingAskUser">): boolean {
  for (const entry of bridge.pendingAskUser.values()) if (entry.mode === "text") return true;
  return false;
}

export function createInteractionHandlers(context: InteractionHandlerContext): InteractionHandlers {
  const { client, emit } = context;
  // A zero/negative timeout would fire on the next tick and cancel every interaction; clamp to a
  // positive window. The default is the documented five minutes.
  const timeoutMs = Math.max(1, context.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS);

  const notify = (bridge: InteractionBridge, message: string, level: "info" | "warning" | "error"): void => {
    if (bridge.notices) {
      emit(bridge.acpId, { sessionUpdate: "notice", severity: level, title: message });
      return;
    }
    emit(bridge.acpId, {
      sessionUpdate: "agent_message_chunk",
      messageId: `${bridge.acpId}-interaction-${Date.now()}`,
      content: { type: "text", text: message },
    });
  };

  const requestApproval = async (bridge: InteractionBridge, approval: ApprovalRequest): Promise<void> => {
    const controller = new AbortController();
    bridge.pending.add(controller);
    bridge.pendingApprovals.set(approval.approvalId, controller);
    let settled = false;
    let timedOut = false;
    let rejectTimeout: ((error: Error) => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout?.(new Error("interaction timed out"));
    }, timeoutMs);
    // `unref` so a pending question never keeps a one-shot process alive.
    timer.unref?.();

    const stillOurs = (): boolean => bridge.pendingApprovals.get(approval.approvalId) === controller;
    const settle = async (approved: boolean): Promise<void> => {
      if (settled) return;
      settled = true;
      // The approval disappeared first (auto mode / plan execution answered it): do not re-decide a
      // call that already ran. `handleInteractions` deletes the map entry before aborting, so this
      // check is what keeps that path from denying a completed tool.
      if (!stillOurs()) return;
      await bridge.session
        .dispatch({ type: "respondApproval", approvalId: approval.approvalId, approved })
        .catch(() => undefined);
    };

    try {
      // The prompt has to carry WHAT is being approved. It used to send the tool NAME as the title
      // and nothing else, so a `run_command` arrived as a bare "Run": the client had no command to
      // show, and the user was asked to approve something they could not read.
      const messages = bridge.session.getSnapshot().messages ?? [];
      const info = toolCallInfo(
        approval.toolName,
        toolInputFor(messages, approval.toolCallId),
        bridge.rootPath,
        toolPartFor(messages, approval.toolCallId)?.display?.text,
        // Same lookup as the transcript row: an extension tool must not arrive as `other`, and a
        // tool that shadows a built-in must not arrive with the built-in's kind.
        {
          // Same fallback as the projector's `presentationOf`: a session that does not expose the
          // lookup (a minimal host double) keeps the static table.
          resolvePresentation: (name) =>
            bridge.session.getToolPresentation
              ? bridge.session.getToolPresentation(name)
              : getBuiltinToolPresentation(name),
          isBuiltin: (name) => bridge.session.isBuiltinTool?.(name) ?? true,
        }
      );
      // Named at the boundary so a field the client's schema rejects is reported here, on the
      // literal, rather than silently degrading the call's result type to `unknown`.
      const params: RequestPermissionRequest = {
        sessionId: bridge.acpId,
        toolCall: {
          toolCallId: approval.toolCallId,
          ...info,
          status: "pending",
        },
        options: permissionOptions(),
      };
      const response = await Promise.race([
        client().request(methods.client.session.requestPermission, params, {
          cancellationSignal: controller.signal,
        }),
        timeoutPromise,
      ]);
      const decision = mapPermissionOutcome(response);
      // A client-cancelled permission is a DENIAL, not a no-op. Doing nothing left the approval
      // pending, `hasPendingToolApprovals` true, and the next prompt parked in `waiting` forever.
      if (!decision) {
        await settle(false);
        return;
      }
      // Remember the decision BEFORE dispatching it: the dispatch can synchronously surface the
      // next approval (a session that queues two calls), and that approval must see the policy.
      if (decision.always && stillOurs()) {
        const key = approvalPolicyKey(approval, messages);
        bridge.approvalPolicy.set(key, decision.approved);
      }
      await settle(decision.approved);
    } catch {
      // Cancelled / timed out / connection closed. All settle as a denial; the map check above
      // keeps a request that was already answered elsewhere from being re-decided.
      if (bridge.pendingApprovals.has(approval.approvalId)) {
        await settle(false);
        if (timedOut) notify(bridge, "The permission request timed out and was denied.", "warning");
      }
    } finally {
      clearTimeout(timer);
      bridge.pendingApprovals.delete(approval.approvalId);
      bridge.pending.delete(controller);
    }
  };

  const requestElicitation = async (bridge: InteractionBridge, ask: AskUserRequest): Promise<void> => {
    const controller = new AbortController();
    const startedAt = Date.now();
    bridge.pending.add(controller);
    bridge.pendingAskUser.set(ask.toolCallId, { controller, ask, mode: "form" });
    let settled = false;
    let timedOut = false;
    let rejectTimeout: ((error: Error) => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout?.(new Error("interaction timed out"));
    }, timeoutMs);
    timer.unref?.();

    const stillOurs = (): boolean => bridge.pendingAskUser.get(ask.toolCallId)?.controller === controller;
    const settle = async (output: Record<string, unknown>): Promise<void> => {
      if (settled) return;
      settled = true;
      if (!stillOurs()) return;
      await bridge.session
        .dispatch({ type: "addToolResult", toolCallId: ask.toolCallId, output })
        .catch(() => undefined);
    };
    const cancelledOutput = (): Record<string, unknown> =>
      buildAskUserOutput({
        question: ask.question,
        hasOptions: Boolean(ask.options?.length),
        cancelled: true,
        durationMs: Date.now() - startedAt,
      });

    if (!bridge.elicitation) {
      // A client without form elicitation has no control to answer. Do not settle as cancelled at
      // t=0 (that made reply / single-select / multi-select impossible); park the question and let
      // the next plain-text prompt become its answer (`answerPendingTextAsk`).
      clearTimeout(timer);
      const options = ask.options ?? [];
      const hint = options.length
        ? `\n\nOptions:\n${options.map((option, index) => `${index + 1}. ${option}`).join("\n")}\n\n` +
          "Reply with an option, or type your own answer."
        : "\n\nReply with your answer.";
      emit(bridge.acpId, {
        sessionUpdate: "agent_message_chunk",
        messageId: `${bridge.acpId}-ask-${ask.toolCallId}`,
        content: { type: "text", text: `The agent asked: ${ask.question}${hint}` },
      });
      const textTimer = setTimeout(() => {
        if (!stillOurs()) return;
        void (async () => {
          await settle(cancelledOutput());
          notify(bridge, "The question timed out and was cancelled.", "warning");
          bridge.pendingAskUser.delete(ask.toolCallId);
          bridge.pending.delete(controller);
        })();
      }, timeoutMs);
      textTimer.unref?.();
      const entry = bridge.pendingAskUser.get(ask.toolCallId);
      if (entry) {
        entry.mode = "text";
        entry.answer = async (text: string) => {
          clearTimeout(textTimer);
          // The message numbers the options; "2" means the second one, not the literal "2".
          const trimmed = text.trim();
          const index = /^\d+$/.test(trimmed) ? Number(trimmed) - 1 : -1;
          const answer = index >= 0 && index < options.length ? options[index] : trimmed;
          await settle(
            buildAskUserOutput({
              question: ask.question,
              hasOptions: options.length > 0,
              answer,
              ...(ask.multiSelect ? { multiSelect: true } : {}),
              durationMs: Date.now() - startedAt,
            })
          );
          bridge.pendingAskUser.delete(ask.toolCallId);
          bridge.pending.delete(controller);
        };
      }
      return;
    }

    try {
      const response = await Promise.race([
        client().request(methods.client.elicitation.create, buildElicitationRequest(bridge.acpId, ask), {
          cancellationSignal: controller.signal,
        }),
        timeoutPromise,
      ]);
      const answer = mapElicitationResponse(response);
      // `decline` / `cancel` are answers, not failures: settle the tool as cancelled instead of
      // dispatching an empty-string answer (which looked like the user had typed nothing).
      if (!answer) {
        await settle(cancelledOutput());
        return;
      }
      await settle(
        buildAskUserOutput({
          question: ask.question,
          hasOptions: Boolean(ask.options?.length),
          ...(ask.multiSelect ? { multiSelect: true } : {}),
          ...(answer.selected?.length ? { selected: answer.selected } : { answer: answer.answer ?? "" }),
          ...(answer.draft ? { draft: answer.draft } : {}),
          durationMs: Date.now() - startedAt,
        })
      );
    } catch {
      if (stillOurs()) {
        await settle(cancelledOutput());
        if (timedOut) notify(bridge, "The question timed out and was cancelled.", "warning");
      }
    } finally {
      clearTimeout(timer);
      bridge.pendingAskUser.delete(ask.toolCallId);
      bridge.pending.delete(controller);
    }
  };

  const answerPendingTextAsk = async (bridge: InteractionBridge, text: string): Promise<boolean> => {
    for (const entry of bridge.pendingAskUser.values()) {
      if (entry.mode !== "text" || !entry.answer) continue;
      await entry.answer(text);
      return true;
    }
    return false;
  };

  const settlePendingInteractions = async (bridge: InteractionBridge): Promise<void> => {
    // Snapshot + delete BEFORE dispatching/aborting: the in-flight handler checks the map to decide
    // whether it still owns the approval, so removing first makes it a no-op instead of a duplicate
    // decision on a tool that already ran.
    const approvals = [...bridge.pendingApprovals.entries()];
    for (const [approvalId, controller] of approvals) {
      bridge.pendingApprovals.delete(approvalId);
      controller.abort();
      await bridge.session.dispatch({ type: "respondApproval", approvalId, approved: false }).catch(() => undefined);
    }
    const questions = [...bridge.pendingAskUser.entries()];
    for (const [toolCallId, { controller, ask }] of questions) {
      bridge.pendingAskUser.delete(toolCallId);
      controller.abort();
      await bridge.session
        .dispatch({
          type: "addToolResult",
          toolCallId,
          output: buildAskUserOutput({
            question: ask.question,
            hasOptions: Boolean(ask.options?.length),
            cancelled: true,
            durationMs: 0,
          }),
        })
        .catch(() => undefined);
    }
  };

  const handleInteractions = async (bridge: InteractionBridge, payload: unknown): Promise<void> => {
    const snapshot = payload as {
      pending?: PendingInteractionEntry[];
      approvals?: ApprovalRequest[];
      askUser?: AskUserRequest[];
    };

    // ONE source for both halves: core publishes the ordered queue, and the typed lists are views
    // of it. Reconciling against a different list than the one we dispatch from let a payload with
    // only `pending` abort every live dialog and then never re-ask it.
    const ordered = resolvePendingInteractions(snapshot);

    // Settle the requests whose question no longer exists. An approval is normally answered by the
    // client's own response, but the session can resolve it first — switching to auto mode answers
    // every pending approval, and plan execution auto-approves too. Without this the client keeps
    // the dialog open for a tool that already ran, and its late answer re-decides the approval.
    const liveApprovals = new Set(
      ordered.filter((entry) => entry.kind === "approval").map((entry) => entry.approvalId)
    );
    for (const [approvalId, controller] of bridge.pendingApprovals) {
      if (liveApprovals.has(approvalId)) continue;
      bridge.pendingApprovals.delete(approvalId);
      controller.abort();
    }

    // Same reconciliation for elicitation: core can resolve an `ask_user` out of band (run stopped,
    // `/new`, tool cancelled). Leaving the dialog pending makes the next prompt believe the
    // session is still suspended and cancel it.
    const liveAskUser = new Set(
      ordered.filter((entry) => entry.kind === "clientTool").map((entry) => entry.toolCallId)
    );
    for (const [toolCallId, entry] of bridge.pendingAskUser) {
      if (liveAskUser.has(toolCallId)) continue;
      bridge.pendingAskUser.delete(toolCallId);
      entry.controller.abort();
    }

    for (const entry of ordered) {
      if (entry.kind === "clientTool") {
        if (bridge.seenAskUser.has(entry.toolCallId)) continue;
        bridge.seenAskUser.add(entry.toolCallId);
        void requestElicitation(bridge, entry);
        continue;
      }
      if (bridge.seenApprovals.has(entry.approvalId)) continue;
      bridge.seenApprovals.add(entry.approvalId);
      // Under `--client-env` some approvals are the client's to grant, and it already did (it
      // served the `fs/*` call we made). Asking again would be the same question twice, so the
      // answer is given here instead — see `approvals.ts` for the exact set and the exclusions.
      if (
        bridge.clientEnv &&
        shouldSuppressApproval({
          approval: entry,
          messages: bridge.session.getSnapshot().messages ?? [],
          clientEnv: bridge.clientEnv,
          mode: bridge.session.getSnapshot().mode,
        })
      ) {
        bridge.clientOwnedApprovals += 1;
        context.onClientOwnedApproval();
        void bridge.session
          .dispatch({ type: "respondApproval", approvalId: entry.approvalId, approved: true })
          .catch(() => undefined);
        continue;
      }
      // A remembered `allow_always` / `reject_always` answers without another dialog. The tool row
      // still goes through the transcript, so the user can see what was auto-decided.
      const policy = bridge.approvalPolicy.get(approvalPolicyKey(entry, bridge.session.getSnapshot().messages ?? []));
      if (policy !== undefined) {
        void bridge.session
          .dispatch({ type: "respondApproval", approvalId: entry.approvalId, approved: policy })
          .catch(() => undefined);
        continue;
      }
      void requestApproval(bridge, entry);
    }
  };

  return { handleInteractions, answerPendingTextAsk, settlePendingInteractions };
}
