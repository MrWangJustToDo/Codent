/**
 * Permission and elicitation mapping.
 *
 * - approvals  ↔ `session/request_permission` (four option kinds → `respondApproval`)
 * - `ask_user` ↔ `elicitation/create` (form), degrading to an agent message when
 *   the client did not advertise the `elicitation` capability.
 * - an MCP server's `elicitation/create` ↔ the same ACP request, one form for one question
 *   (`buildMcpElicitationRequest` / `mapMcpElicitResult`; the driver is `mcp-elicitation.ts`).
 */

import type {
  PermissionOption,
  RequestPermissionResponse,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationSchema,
} from "@agentclientprotocol/sdk";
import type { McpElicitResult } from "@codent/core";

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
  /** The selected option survives this turn: remember it for the session (allow/reject always). */
  always?: boolean;
}

/**
 * Map a `session/request_permission` outcome to a `respondApproval` decision. `null` = cancelled.
 *
 * ACP v1's `SelectedPermissionOutcome` carries only `optionId` — there is no rejection reason on
 * the wire, which is why {@link ApprovalDecision} has no `reason` field.
 */
export function mapPermissionOutcome(response: RequestPermissionResponse): ApprovalDecision | null {
  const outcome = response.outcome;
  if (outcome.outcome === "cancelled") return null;
  if (outcome.outcome === "selected") {
    // Any option we did not offer (custom extension) is treated as a rejection.
    return {
      approved: ALLOW_OPTION_IDS.has(outcome.optionId),
      ...(outcome.optionId === "allow-always" || outcome.optionId === "reject-always" ? { always: true } : {}),
    };
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
        properties: { answer: { type: "string", title: "Answer" } },
        required: ["answer"],
      },
    };
  }
  // The question is the form's `message`; repeating it as the field's title rendered it twice (reported
  // from Zed as a duplicated title). Each field gets a label instead.
  const choice = ask.multiSelect
    ? { type: "array" as const, items: { type: "string" as const, enum: options }, title: "Select all that apply" }
    : { type: "string" as const, enum: options, title: "Choose one" };
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
      // NOT required: `custom` is a legitimate answer on its own. The ACP schema subset has no
      // object-level `anyOf`, so requiring `answer` made "type your own instead of picking"
      // unsubmittable (and a client without `array` support could never satisfy a multi-select).
      // An all-empty submission is mapped to `null` (cancelled) below.
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
  const custom = typeof content.custom === "string" ? content.custom.trim() : "";
  const value = content.answer;
  // Multi-select and the free-form field are BOTH answers, not alternatives: a user who ticks two options
  // and types one more expects all three. Dropping the ticks when `custom` was filled was reported as
  // "only my typing was sent" — the typed text is one more entry in the list, kept separately as `draft`.
  if (Array.isArray(value)) {
    const selected = value.map(String).filter((item) => item.trim().length > 0);
    if (selected.length === 0 && !custom) return null;
    const parts = [...selected, ...(custom ? [custom] : [])];
    return {
      answer: parts.join(", "),
      ...(selected.length > 0 ? { selected } : {}),
      ...(custom ? { draft: custom } : {}),
    };
  }
  // Single select: typing overrides the radio choice, so the typed text is the answer (and a draft).
  if (custom) return { answer: custom, draft: custom };
  // A selection is not a "custom answer": `draft` is documented as the free-form text the user typed, and
  // an answer without options already IS that text. An empty/whitespace-only accept is NOT an answer —
  // mapping it to "" made a cancelled form look like the user typed nothing (the bug this file fixes).
  const text = value == null ? "" : String(value);
  if (!text.trim()) return null;
  return { answer: text };
}

/**
 * Build an ACP form elicitation from an MCP server's `elicitation/create` request, or `undefined`
 * when the request is one this host does not relay.
 *
 * Both protocols describe the same interaction — a message plus a flat JSON Schema of primitive
 * fields — so the server's schema travels as-is: rewriting it would only cost its titles and
 * descriptions. Two fields DO get rewritten, because ACP validates them more strictly than MCP and a
 * rejected request means the user sees no form at all:
 * - an unknown `format` is dropped (ACP defines `email`/`uri`/`date`/`date-time`), and
 * - MCP's `enumNames` becomes the equivalent `oneOf` const/title list, so labels survive.
 *
 * The server's own `message` is the prompt; when it is missing the message names the server, because
 * a form with no text leaves the user no way to know who is asking.
 *
 * `toolCallId` is deliberately omitted: the hook is not told which tool call the server is serving,
 * so the request is scoped to the session rather than inventing an id the client would then attach to
 * the wrong row (ACP documents the session scope as the same thing without a specific call).
 *
 * `undefined` is returned for MCP's URL mode, where the server sends the user to a URL and answers
 * out of band: an ACP form cannot express it, and rendering it as an empty form would ask the user
 * for values nobody reads. Core advertises only form elicitation, so a compliant server cannot send
 * it — this is what keeps a non-compliant one from producing a meaningless dialog.
 */
export function buildMcpElicitationRequest(
  sessionId: string,
  server: string,
  params: unknown
): CreateElicitationRequest | undefined {
  const payload = (params ?? {}) as { mode?: unknown; message?: unknown; requestedSchema?: unknown };
  if (payload.mode === "url") return undefined;
  const message =
    typeof payload.message === "string" && payload.message.trim().length > 0
      ? payload.message
      : `The MCP server "${server}" needs your input.`;
  const schema = payload.requestedSchema;
  // `type` last so a server that sent its own (malformed) one cannot turn the form into something
  // ACP will not render; everything else is passed through except the two fields above.
  const requestedSchema: ElicitationSchema =
    schema !== null && typeof schema === "object" && !Array.isArray(schema)
      ? ({ ...normalizeElicitationProperties(schema as Record<string, unknown>), type: "object" } as ElicitationSchema)
      : { type: "object", properties: {} };
  return { mode: "form", sessionId, message, requestedSchema };
}

/** The string formats ACP defines; a `format` outside this set fails the client's own validation. */
const ACP_STRING_FORMATS = new Set(["email", "uri", "date", "date-time"]);

/** Apply the two schema rewrites {@link buildMcpElicitationRequest} documents, per property. */
function normalizeElicitationProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return schema;
  const normalized: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties as Record<string, unknown>)) {
    normalized[name] = normalizeElicitationProperty(value);
  }
  return { ...schema, properties: normalized };
}

function normalizeElicitationProperty(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const property = { ...(value as Record<string, unknown>) };
  if (typeof property.format === "string" && !ACP_STRING_FORMATS.has(property.format)) delete property.format;
  const { enum: values, enumNames } = property;
  if (Array.isArray(values) && Array.isArray(enumNames) && values.length === enumNames.length) {
    property.oneOf = values.map((option, index) => ({ const: String(option), title: String(enumNames[index]) }));
    delete property.enum;
    delete property.enumNames;
  }
  return property;
}

/**
 * Map an ACP elicitation response onto the MCP result.
 *
 * The three MCP actions are the three standard ACP ones; a custom action (allowed on the wire for
 * future variants) becomes `decline`, because MCP's own client rejects a value outside its three and
 * inventing one is worse than refusing. `content` is dropped unless the action is `accept` — a client
 * that submits a form and then declines must not hand the server values it never agreed to.
 *
 * The bare-string form is core's own vocabulary: `McpElicitResult` accepts `"decline"` / `"cancel"`
 * as strings (its object member is narrowed to `accept`), and the manager normalizes them.
 */
export function mapMcpElicitResult(response: CreateElicitationResponse): McpElicitResult {
  if (response.action === "accept") {
    const content = (response as { content?: Record<string, unknown> }).content;
    return content ? { action: "accept", content } : { action: "accept" };
  }
  return response.action === "cancel" ? "cancel" : "decline";
}
