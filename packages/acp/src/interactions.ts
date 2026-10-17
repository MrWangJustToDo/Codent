/**
 * The two client round-trips a run can need: permission for a tool, and a question for the user.
 *
 * Both are fire-and-forget from the projector's point of view — the session's own channels carry the
 * result, so nothing here returns a value. What they share is the shape: register a controller in
 * `bridge.pending` (so cancel/close can abort it), ask the client, dispatch the answer back, and
 * never throw (a closed connection is the session's problem to time out, not a reason to fail a run).
 *
 * Split out of `agent.ts` for size, which is also why the bridge state arrives as a narrow interface
 * rather than the app's own `SessionBridge`: these handlers touch six fields and nothing else.
 */

import { methods } from "@agentclientprotocol/sdk";
import { buildAskUserOutput } from "@codent/core";

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
import type { AgentSession } from "@codent/core";

/** What an interaction handler reads and writes on a live session. */
export interface InteractionBridge {
  session: AgentSession;
  /** The external ACP session id every request/notification is tagged with. */
  acpId: string;
  /** Client-backed env, when `--client-env` is on — decides who owns a write approval. */
  clientEnv?: AcpClientEnv;
  /** Client advertises `elicitation.form`, so `ask_user` can be a real question. */
  elicitation: boolean;
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
  /** Workspace root, for the absolute paths a tool call's `locations` carry. */
  rootPath: string;
  onClientOwnedApproval: () => void;
}

/** What {@link createInteractionHandlers} hands back — the projector's `onInteraction` entry points. */
export interface InteractionHandlers {
  handleInteractions: (bridge: InteractionBridge, payload: unknown) => Promise<void>;
}

export function createInteractionHandlers(context: InteractionHandlerContext): InteractionHandlers {
  const { client, emit, rootPath } = context;

  const requestApproval = async (bridge: InteractionBridge, approval: ApprovalRequest): Promise<void> => {
    const controller = new AbortController();
    bridge.pending.add(controller);
    bridge.pendingApprovals.set(approval.approvalId, controller);
    try {
      // The prompt has to carry WHAT is being approved. It used to send the tool NAME as the title
      // and nothing else, so a `run_command` arrived as a bare "Run": the client had no command to
      // show, and the user was asked to approve something they could not read.
      const messages = bridge.session.getSnapshot().messages ?? [];
      const info = toolCallInfo(
        approval.toolName,
        toolInputFor(messages, approval.toolCallId),
        rootPath,
        toolPartFor(messages, approval.toolCallId)?.display?.text
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
      const response = await client().request(methods.client.session.requestPermission, params, {
        cancellationSignal: controller.signal,
      });
      const decision = mapPermissionOutcome(response);
      if (!decision) return;
      await bridge.session.dispatch({
        type: "respondApproval",
        approvalId: approval.approvalId,
        approved: decision.approved,
      });
    } catch {
      // connection closed / cancelled — the session's own approval timeout settles it
    } finally {
      bridge.pendingApprovals.delete(approval.approvalId);
      bridge.pending.delete(controller);
    }
  };

  const requestElicitation = async (bridge: InteractionBridge, ask: AskUserRequest): Promise<void> => {
    const controller = new AbortController();
    const startedAt = Date.now();
    bridge.pending.add(controller);
    try {
      if (!bridge.elicitation) {
        emit(bridge.acpId, {
          sessionUpdate: "agent_message_chunk",
          messageId: `${bridge.acpId}-ask-${ask.toolCallId}`,
          content: { type: "text", text: `The agent asked: ${ask.question}` },
        });
        await bridge.session.dispatch({
          type: "addToolResult",
          toolCallId: ask.toolCallId,
          output: buildAskUserOutput({
            question: ask.question,
            hasOptions: Boolean(ask.options?.length),
            cancelled: true,
            durationMs: Date.now() - startedAt,
          }),
        });
        return;
      }
      const response = await client().request(
        methods.client.elicitation.create,
        buildElicitationRequest(bridge.acpId, ask),
        { cancellationSignal: controller.signal }
      );
      const answer = mapElicitationResponse(response);
      await bridge.session.dispatch({
        type: "addToolResult",
        toolCallId: ask.toolCallId,
        // Core owns the result shape and the multi-select + free-text merge; the host only reports
        // which labels were ticked and what was typed.
        output: buildAskUserOutput({
          question: ask.question,
          hasOptions: Boolean(ask.options?.length),
          ...(answer?.selected?.length ? { selected: answer.selected } : { answer: answer?.answer ?? "" }),
          ...(answer?.draft ? { draft: answer.draft } : {}),
          durationMs: Date.now() - startedAt,
        }),
      });
    } catch {
      // connection closed / cancelled — leave the interaction to time out
    } finally {
      bridge.pending.delete(controller);
    }
  };

  const handleInteractions = async (bridge: InteractionBridge, payload: unknown): Promise<void> => {
    const snapshot = payload as {
      approvals?: ApprovalRequest[];
      askUser?: AskUserRequest[];
    };

    // Settle the requests whose question no longer exists. An approval is normally answered by the
    // client's own response, but the session can resolve it first — switching to auto mode answers
    // every pending approval, and plan execution auto-approves too. Without this the client keeps
    // the dialog open for a tool that already ran, and its late answer re-decides the approval.
    const liveApprovals = new Set((snapshot.approvals ?? []).map((approval) => approval.approvalId));
    for (const [approvalId, controller] of bridge.pendingApprovals) {
      if (liveApprovals.has(approvalId)) continue;
      bridge.pendingApprovals.delete(approvalId);
      controller.abort();
    }

    for (const approval of snapshot.approvals ?? []) {
      if (bridge.seenApprovals.has(approval.approvalId)) continue;
      bridge.seenApprovals.add(approval.approvalId);
      // Under `--client-env` some approvals are the client's to grant, and it already did (it
      // served the `fs/*` call we made). Asking again would be the same question twice, so the
      // answer is given here instead — see `approvals.ts` for the exact set and the exclusions.
      if (
        bridge.clientEnv &&
        shouldSuppressApproval({
          approval,
          messages: bridge.session.getSnapshot().messages ?? [],
          clientEnv: bridge.clientEnv,
          mode: bridge.session.getSnapshot().mode,
        })
      ) {
        bridge.clientOwnedApprovals += 1;
        context.onClientOwnedApproval();
        void bridge.session
          .dispatch({ type: "respondApproval", approvalId: approval.approvalId, approved: true })
          .catch(() => undefined);
        continue;
      }
      void requestApproval(bridge, approval);
    }
    for (const ask of snapshot.askUser ?? []) {
      if (bridge.seenAskUser.has(ask.toolCallId)) continue;
      bridge.seenAskUser.add(ask.toolCallId);
      void requestElicitation(bridge, ask);
    }
  };

  return { handleInteractions };
}
