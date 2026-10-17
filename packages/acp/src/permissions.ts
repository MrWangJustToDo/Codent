/**
 * Permission and elicitation mapping.
 *
 * - approvals  ↔ `session/request_permission` (four option kinds → `respondApproval`)
 * - `ask_user` ↔ `elicitation/create` (form), degrading to an agent message when
 *   the client did not advertise the `elicitation` capability.
 */

import type {
  PermissionOption,
  RequestPermissionResponse,
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk";

/** The four standard permission options, in the order ACP clients expect. */
export function permissionOptions(): PermissionOption[] {
  return [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    { optionId: "reject-always", name: "Reject always", kind: "reject_always" },
  ];
}

const ALLOW_OPTION_IDS = new Set(["allow-once", "allow-always"]);

export interface ApprovalDecision {
  approved: boolean;
  /** Present on a rejection when the client supplied a reason. */
  reason?: string;
}

/** Map a `session/request_permission` outcome to a `respondApproval` decision. `null` = cancelled. */
export function mapPermissionOutcome(response: RequestPermissionResponse): ApprovalDecision | null {
  const outcome = response.outcome;
  if (outcome.outcome === "cancelled") return null;
  if (outcome.outcome === "selected") {
    // Any option we did not offer (custom extension) is treated as a rejection.
    return { approved: ALLOW_OPTION_IDS.has(outcome.optionId) };
  }
  return null;
}

/** Shape of the `ask_user` interaction the session surfaces. */
export interface AskUserInteraction {
  toolCallId: string;
  question: string;
  options?: string[];
  multiSelect?: boolean;
}

/**
 * Build a form elicitation for an `ask_user` interaction.
 *
 * A free-form question exposes a single `answer` string; a question with options
 * exposes an `enum` (array when multi-select), so the client renders a picker.
 */
export function buildElicitationRequest(sessionId: string, ask: AskUserInteraction): CreateElicitationRequest {
  const options = ask.options ?? [];
  // The question is never a closed set: the tool's own contract says "the user can still provide a
  // free-form answer", and the TUI gives them a text field next to the options. A form whose only field
  // is an `enum` takes that away — the client can render the buttons and nothing else — so the options
  // get a companion string. `custom` wins when filled, and is reported as the answer's `draft`.
  if (options.length === 0) {
    return {
      mode: "form",
      sessionId,
      toolCallId: ask.toolCallId,
      message: ask.question,
      requestedSchema: {
        type: "object",
        properties: { answer: { type: "string", title: ask.question } },
        required: ["answer"],
      },
    };
  }
  const choice = ask.multiSelect
    ? { type: "array" as const, items: { type: "string" as const, enum: options }, title: ask.question }
    : { type: "string" as const, enum: options, title: ask.question };
  return {
    mode: "form",
    sessionId,
    toolCallId: ask.toolCallId,
    message: ask.question,
    requestedSchema: {
      type: "object",
      properties: {
        answer: choice,
        custom: { type: "string", title: "Or type your own answer", description: "Optional." },
      },
      required: ["answer"],
    },
  };
}

export interface ElicitedAnswer {
  answer: string;
  selected?: string[];
  draft?: string;
}

/** Map an elicitation response to an `ask_user` answer. `null` = declined/cancelled. */
export function mapElicitationResponse(response: CreateElicitationResponse): ElicitedAnswer | null {
  if (response.action !== "accept") return null;
  const content = (response as { content?: Record<string, unknown> }).content ?? {};
  // A typed answer outranks the buttons (see `buildElicitationRequest`): it is the one case the form
  // cannot express as a selection, and the model should see it as the user's own words.
  const custom = typeof content.custom === "string" ? content.custom.trim() : "";
  if (custom) return { answer: custom, draft: custom };
  const value = content.answer;
  if (Array.isArray(value)) {
    const selected = value.map(String);
    return { answer: selected.join(", "), selected };
  }
  // A selection is not a "custom answer": `draft` is documented as the free-form text the user typed, and
  // an answer without options already IS that text. Only `custom` (above) is a draft.
  return { answer: value == null ? "" : String(value) };
}
