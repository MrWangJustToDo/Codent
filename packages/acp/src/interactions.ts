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
import { BUILTIN_TOOL_NAMES } from "@codent/core";

import { shouldSuppressApproval } from "./approvals.js";
import {
  buildElicitationRequest,
  mapElicitationResponse,
  mapPermissionOutcome,
  permissionOptions,
} from "./permissions.js";
import { toolKindFor } from "./tools.js";

import type { AcpClientEnv } from "./client-env.js";
import type { SessionUpdate } from "./types.js";
import type { AgentContext } from "@agentclientprotocol/sdk";
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
  onClientOwnedApproval: () => void;
}

/** What {@link createInteractionHandlers} hands back — the projector's `onInteraction` entry points. */
export interface InteractionHandlers {
  handleInteractions: (bridge: InteractionBridge, payload: unknown) => Promise<void>;
}

/**
 * `ask_user` result shaped for `askUserOutputSchema` (the client tool's contract).
 *
 * Moved here verbatim from `agent.ts`: the shape is the tool's, not this module's, and `ask_user`
 * failing to parse would resurface as "Edited undefined"-style renderers reading fields that are
 * not there.
 */
function askUserOutput(
  ask: { question: string; options?: string[] },
  answer: { answer: string; selected?: string[]; draft?: string } | null,
  cancelled: boolean
): Record<string, unknown> {
  return {
    question: ask.question,
    answer: answer?.answer ?? "",
    hasOptions: Boolean(ask.options?.length),
    durationMs: 0,
    cachedOutputPath: null,
    success: true,
    tool: BUILTIN_TOOL_NAMES.askUser,
    ...(answer?.selected ? { selected: answer.selected, multiSelect: true } : {}),
    ...(answer?.draft !== undefined ? { draft: answer.draft } : {}),
    ...(cancelled ? { cancelled: true } : {}),
  };
}

export function createInteractionHandlers(context: InteractionHandlerContext): InteractionHandlers {
  const { client, emit } = context;

  const requestApproval = async (bridge: InteractionBridge, approval: ApprovalRequest): Promise<void> => {
    const controller = new AbortController();
    bridge.pending.add(controller);
    try {
      const response = await client().request(
        methods.client.session.requestPermission,
        {
          sessionId: bridge.acpId,
          toolCall: {
            toolCallId: approval.toolCallId,
            title: approval.toolName,
            kind: toolKindFor(approval.toolName),
            status: "pending",
          },
          options: permissionOptions(),
        },
        { cancellationSignal: controller.signal }
      );
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
      bridge.pending.delete(controller);
    }
  };

  const requestElicitation = async (bridge: InteractionBridge, ask: AskUserRequest): Promise<void> => {
    const controller = new AbortController();
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
          output: askUserOutput(ask, null, true),
        });
        return;
      }
      const response = await client().request(
        methods.client.elicitation.create,
        buildElicitationRequest(bridge.acpId, ask),
        { cancellationSignal: controller.signal }
      );
      await bridge.session.dispatch({
        type: "addToolResult",
        toolCallId: ask.toolCallId,
        output: askUserOutput(ask, mapElicitationResponse(response), false),
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
