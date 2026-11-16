/**
 * `ask_user` ↔ `elicitation/create`: the form schema, the answer mapping, and the empty-accept edge.
 *
 * Extracted from the projection validator (which hit the file-size gate). The checks are about the
 * user-facing question contract, not the transcript projector: the options must carry a free-form
 * sibling, `custom` alone must be a submittable answer, multi-select must be an array of enums, and
 * an empty/whitespace accept must be treated as cancelled rather than as "" (which looked like the
 * user had typed nothing).
 *
 * Run: pnpm --filter @codent/acp run validate:acp:elicitation
 */

import {
  buildMcpElicitationRequest,
  buildElicitationRequest,
  createMcpElicitation,
  mapElicitationResponse,
  mapMcpElicitResult,
} from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";
import { zod } from "./acp-scenario.mjs";

const checker = createChecker();
const check = checker.check;

// ===========================================================================
// 10. `ask_user` keeps the free-form answer the TUI offers
// ===========================================================================
//
// The tool's contract is "the user can still provide a free-form answer", and the TUI gives them a text
// field next to the options. A form whose only field is an `enum` takes that away — the client can render
// buttons and nothing else — so the options carry a companion string, and a typed answer outranks the
// selection (and is reported as the answer's `draft`).
{
  const withOptions = buildElicitationRequest("s1", { toolCallId: "c1", question: "Pick", options: ["a", "b"] });
  const properties = withOptions.requestedSchema.properties ?? {};
  check(
    "an options question also offers a free-form field",
    properties.custom?.type === "string" && Array.isArray(properties.answer?.enum),
    JSON.stringify(Object.keys(properties))
  );
  check(
    "…and passes the protocol's own elicitation schema",
    (() => {
      const parsed = zod.zCreateElicitationRequest.safeParse(withOptions);
      return parsed.success ? true : JSON.stringify(parsed.error.issues.slice(0, 2));
    })() === true
  );
  check(
    "a typed answer becomes the answer AND the draft (not the selected option)",
    JSON.stringify(mapElicitationResponse({ action: "accept", content: { answer: "a", custom: "my own" } })) ===
      JSON.stringify({ answer: "my own", draft: "my own" }),
    JSON.stringify(mapElicitationResponse({ action: "accept", content: { answer: "a", custom: "my own" } }))
  );
  check(
    "a selection still maps to the option, with no draft",
    JSON.stringify(mapElicitationResponse({ action: "accept", content: { answer: "a" } })) ===
      JSON.stringify({ answer: "a" })
  );
  check(
    "a multi-select answer keeps its selected list",
    JSON.stringify(mapElicitationResponse({ action: "accept", content: { answer: ["a", "b"] } })) ===
      JSON.stringify({ answer: "a, b", selected: ["a", "b"] })
  );
  // Ticking options AND typing is not either/or: dropping the ticks lost which options were chosen.
  check(
    "…and a typed answer is an ADDITIONAL entry, not a replacement",
    JSON.stringify(mapElicitationResponse({ action: "accept", content: { answer: ["a", "b"], custom: "mine" } })) ===
      JSON.stringify({ answer: "a, b, mine", selected: ["a", "b"], draft: "mine" }),
    JSON.stringify(mapElicitationResponse({ action: "accept", content: { answer: ["a", "b"], custom: "mine" } }))
  );
  // The question is the form's `message`; a field title repeating it rendered the question twice in Zed.
  check(
    "the question is not repeated in the field labels",
    withOptions.message === "Pick" && properties.answer?.title !== "Pick" && properties.custom?.title !== "Pick",
    JSON.stringify({ message: withOptions.message, labels: [properties.answer?.title, properties.custom?.title] })
  );
  const noOptions = buildElicitationRequest("s1", { toolCallId: "c2", question: "Why?" });
  const plain = noOptions.requestedSchema.properties?.answer ?? {};
  check(
    "a question with no options is plain free text",
    plain.type === "string" && !Array.isArray(plain.enum),
    JSON.stringify(plain)
  );
  check("…and its free-text schema passes the protocol", zod.zCreateElicitationRequest.safeParse(noOptions).success);
  // `custom` is a legitimate answer on its own: requiring `answer` made "type your own" unsubmittable.
  check(
    "an options question does not require one of its options",
    withOptions.requestedSchema.required === undefined,
    JSON.stringify(withOptions.requestedSchema.required)
  );
  const multi = buildElicitationRequest("s1", {
    toolCallId: "c3",
    question: "Pick many",
    options: ["a", "b"],
    multiSelect: true,
  });
  check(
    "multi-select is an array of enum strings",
    multi.requestedSchema.properties?.answer?.type === "array" &&
      Array.isArray(multi.requestedSchema.properties?.answer?.items?.enum),
    JSON.stringify(multi.requestedSchema.properties?.answer)
  );
  check(
    "…and passes the protocol's own elicitation schema",
    zod.zCreateElicitationRequest.safeParse(multi).success,
    JSON.stringify(zod.zCreateElicitationRequest.safeParse(multi).error?.issues?.slice(0, 2))
  );
  check(
    "declining an elicitation is a null answer, not an empty string",
    mapElicitationResponse({ action: "decline" }) === null
  );
  // Empty / whitespace / no content are NOT answers (they used to map to "").
  check(
    "an empty accept is cancelled, not an empty answer",
    mapElicitationResponse({ action: "accept", content: { answer: [] } }) === null &&
      mapElicitationResponse({ action: "accept", content: { answer: "   " } }) === null &&
      mapElicitationResponse({ action: "accept" }) === null
  );
  check(
    "a typed answer still wins when the options are untouched",
    JSON.stringify(mapElicitationResponse({ action: "accept", content: { custom: "my own" } })) ===
      JSON.stringify({ answer: "my own", draft: "my own" })
  );
}
// ===========================================================================
// 11. An MCP server's question is the same form (and its answer, an MCP result)
// ===========================================================================
//
// An MCP server asks with `{ message, requestedSchema }`; ACP wants the same two fields plus a form
// mode and the session. The schema travels through: rewriting it would cost the server's titles and
// enums, and ACP's schema type is a structural superset.
{
  const params = {
    message: "Which profile should I use?",
    requestedSchema: {
      type: "object",
      properties: {
        profile: { type: "string", title: "Profile", enum: ["work", "personal"] },
        remember: { type: "boolean", title: "Remember" },
      },
      required: ["profile"],
    },
  };
  const request = buildMcpElicitationRequest("ses_1", "browsermcp", params);
  check(
    "an MCP question becomes a form scoped to the session",
    request.mode === "form" && request.sessionId === "ses_1"
  );
  check("the server's own message is the prompt", request.message === params.message);
  check(
    "the server's schema travels untouched (titles, enum, required)",
    JSON.stringify(request.requestedSchema) === JSON.stringify(params.requestedSchema),
    JSON.stringify(request.requestedSchema)
  );
  check("no tool call id is invented (the hook is not told one)", !("toolCallId" in request));
  check(
    "the derived request passes the protocol's own schema",
    zod.zCreateElicitationRequest.safeParse(request).success,
    JSON.stringify(zod.zCreateElicitationRequest.safeParse(request).error?.issues?.slice(0, 2))
  );

  // The two rewrites the mapping owes ACP's stricter schema. Both are proved usable: the un-normalized
  // shape is shown to be REJECTED, so the check cannot pass on an implementation that skips them.
  const rawSchema = {
    type: "array",
    properties: {
      when: { type: "string", format: "uuid" },
      day: { type: "string", format: "date" },
      profile: { type: "string", enum: ["work", "personal"], enumNames: ["Work", "Personal"] },
    },
  };
  const normalized = buildMcpElicitationRequest("ses_1", "browsermcp", { message: "m", requestedSchema: rawSchema });
  const fields = normalized.requestedSchema.properties;
  check("a server's schema type is forced to object", normalized.requestedSchema.type === "object");
  check(
    "an unknown string format is dropped (ACP has no `uuid`)",
    !("format" in fields.when) && fields.when.title === undefined && fields.when.type === "string"
  );
  check("a format ACP does define is kept", fields.day.format === "date");
  check(
    "enumNames becomes oneOf, so the labels survive instead of the bare values",
    JSON.stringify(fields.profile) ===
      JSON.stringify({
        type: "string",
        oneOf: [
          { const: "work", title: "Work" },
          { const: "personal", title: "Personal" },
        ],
      }),
    JSON.stringify(fields.profile)
  );
  check(
    "…and the normalized request passes the protocol's own schema",
    zod.zCreateElicitationRequest.safeParse(normalized).success,
    JSON.stringify(zod.zCreateElicitationRequest.safeParse(normalized).error?.issues?.slice(0, 2))
  );
  check(
    "the un-normalized shape is what a validating client rejects",
    !zod.zCreateElicitationRequest.safeParse({
      mode: "form",
      sessionId: "ses_1",
      message: "m",
      requestedSchema: { type: "object", properties: { when: { type: "string", format: "uuid" } } },
    }).success
  );
  check(
    "MCP's URL mode is not turned into an empty form",
    buildMcpElicitationRequest("ses_1", "browsermcp", {
      mode: "url",
      message: "Sign in",
      elicitationId: "e1",
      url: "https://example.test/auth",
    }) === undefined
  );

  const bare = buildMcpElicitationRequest("ses_1", "browsermcp", undefined);
  check("a message-less request names the server asking", bare.message.includes("browsermcp"));
  check("…and is still a renderable form, not an empty object", bare.requestedSchema.type === "object");
  check("…that the protocol accepts", zod.zCreateElicitationRequest.safeParse(bare).success);

  check(
    "an accepted form returns its content",
    JSON.stringify(mapMcpElicitResult({ action: "accept", content: { profile: "work" } })) ===
      JSON.stringify({ action: "accept", content: { profile: "work" } })
  );
  check(
    "an accepted empty form still accepts",
    JSON.stringify(mapMcpElicitResult({ action: "accept" })) === JSON.stringify({ action: "accept" })
  );
  check("decline is core's bare string, not an object", mapMcpElicitResult({ action: "decline" }) === "decline");
  check("cancel is core's bare string too", mapMcpElicitResult({ action: "cancel" }) === "cancel");
  check(
    "a custom action is refused as decline rather than forwarded (MCP has three)",
    mapMcpElicitResult({ action: "escalate", content: { a: 1 } }) === "decline"
  );
  check(
    "content submitted with a decline is dropped",
    mapMcpElicitResult({ action: "decline", content: { profile: "work" } }) === "decline"
  );
}

// ===========================================================================
// 12. The driver answers on every path — no hook throw, no hang
// ===========================================================================
{
  const noCaps = createMcpElicitation(undefined, { client: () => ({}) });
  check("no hook when the client advertised nothing", noCaps === undefined);
  const otherMode = createMcpElicitation({ elicitation: {} }, { client: () => ({}) });
  check("no hook when the client did not advertise a FORM", otherMode === undefined);

  const sent = [];
  const session = { acpId: "ses_1", pending: new Set(), closed: false };
  const elicit = createMcpElicitation(
    { elicitation: { form: {} } },
    {
      client: () => ({
        request: async (method, params) => {
          sent.push({ method, params });
          return { action: "accept", content: { name: "ada" } };
        },
      }),
      timeoutMs: 1000,
    }
  );

  // Before `bind`: the session does not exist yet (MCP connects inside `host.create`).
  const unbound = await elicit.hook({ server: "srv", params: { message: "hi" } });
  check("a question before the session is bound is declined, not hung", unbound === "decline");
  check("…and nothing was sent to the client", sent.length === 0);

  elicit.bind(session);
  const accepted = await elicit.hook({
    server: "srv",
    params: { message: "Name?", requestedSchema: { type: "object", properties: { name: { type: "string" } } } },
  });
  check("the question goes to the client as an elicitation request", sent[0]?.method === "elicitation/create");
  check("…scoped to the bound session", sent[0]?.params?.sessionId === "ses_1");
  check(
    "the answer is MCP content",
    JSON.stringify(accepted) === JSON.stringify({ action: "accept", content: { name: "ada" } })
  );
  check("the in-flight controller is released", session.pending.size === 0);

  // The handle is read per call, so a fork (which re-keys the same bridge) needs no re-binding.
  session.acpId = "ses_clone";
  await elicit.hook({ server: "srv", params: { message: "again" } });
  check("a re-keyed session is followed without re-binding", sent.at(-1)?.params?.sessionId === "ses_clone");

  // A dead session is declined BEFORE anything is sent: there is no dialog left to attach it to.
  const closedSession = { acpId: "ses_closed", pending: new Set(), closed: true };
  const sentClosed = [];
  const onClosed = createMcpElicitation(
    { elicitation: { form: {} } },
    { client: () => ({ request: async () => void sentClosed.push(1) }), timeoutMs: 1000 }
  );
  onClosed.bind(closedSession);
  check(
    "a closed session declines instead of asking",
    (await onClosed.hook({ server: "srv", params: {} })) === "decline" && sentClosed.length === 0
  );

  // A client that rejects: `cancel`, never a rejected promise (a throw would become an unexplained
  // tool failure on the server side).
  const failing = createMcpElicitation(
    { elicitation: { form: {} } },
    {
      client: () => ({
        request: async () => {
          throw new Error("connection closed");
        },
      }),
      timeoutMs: 1000,
    }
  );
  failing.bind({ acpId: "ses_2", pending: new Set(), closed: false });
  check("a failing client answers cancel", (await failing.hook({ server: "srv", params: {} })) === "cancel");

  // An MCP URL-mode request never reaches the client (it is not a form), and is answered.
  const sentUrl = [];
  const urlHook = createMcpElicitation(
    { elicitation: { form: {} } },
    { client: () => ({ request: async () => void sentUrl.push(1) }), timeoutMs: 1000 }
  );
  urlHook.bind({ acpId: "ses_url", pending: new Set(), closed: false });
  check(
    "a URL-mode question is declined without asking for a form",
    (await urlHook.hook({ server: "srv", params: { mode: "url", url: "https://example.test" } })) === "decline" &&
      sentUrl.length === 0
  );

  // Timeout: the client never answers. The SDK does NOT settle a request when its `cancellationSignal`
  // aborts (it only sends `$/cancel_request`), so this fake client reproduces that exactly — it ignores
  // the signal and never resolves. A hook that trusted the signal would hang here forever.
  const pendingControllers = new Set();
  let signalled = false;
  const slow = createMcpElicitation(
    { elicitation: { form: {} } },
    {
      client: () => ({
        request: (_method, _params, options) => {
          options?.cancellationSignal?.addEventListener("abort", () => {
            signalled = true;
          });
          return new Promise(() => {});
        },
      }),
      timeoutMs: 5,
    }
  );
  slow.bind({ acpId: "ses_3", pending: pendingControllers, closed: false });
  // The hook's own timer is `unref`ed (it must not keep a real process alive), so this check keeps the
  // loop alive itself — and then a hook that never settles fails as `"never"` instead of as an
  // unsettled await with no output.
  const timed = await Promise.race([
    slow.hook({ server: "srv", params: {} }),
    new Promise((resolve) => setTimeout(() => resolve("never"), 2000)),
  ]);
  check("an unanswered question times out as cancel, even when the client ignores the abort", timed === "cancel");
  check("…after telling a cooperative client to close its dialog", signalled === true);
  check("…and leaves no dialog controller behind", pendingControllers.size === 0);

  // Cancelled mid-flight (what `session/cancel` / `closeBridge` do): the pending controller is aborted
  // and the question ends as `cancel` — not as consent if the user submits afterwards.
  let submitLate;
  const abortSession = { acpId: "ses_4", pending: new Set(), closed: false };
  const abortable = createMcpElicitation(
    { elicitation: { form: {} } },
    {
      client: () => ({
        request: () => new Promise((resolve) => (submitLate = resolve)),
      }),
      timeoutMs: 5000,
    }
  );
  abortable.bind(abortSession);
  const inFlight = abortable.hook({ server: "srv", params: {} });
  for (const controller of abortSession.pending) controller.abort();
  submitLate({ action: "accept", content: { name: "late" } });
  check("an aborted question ends as cancel, not as the late submit", (await inFlight) === "cancel");
  check("…and its controller is released", abortSession.pending.size === 0);

  // A form submitted after the session closed is NOT consent, even when nothing aborted our request
  // (the close can land between the client's answer and our reading of it).
  let submitAfterClose;
  const dyingSession = { acpId: "ses_5", pending: new Set(), closed: false };
  const dying = createMcpElicitation(
    { elicitation: { form: {} } },
    { client: () => ({ request: () => new Promise((resolve) => (submitAfterClose = resolve)) }), timeoutMs: 5000 }
  );
  dying.bind(dyingSession);
  const dyingQuestion = dying.hook({ server: "srv", params: {} });
  dyingSession.closed = true;
  submitAfterClose({ action: "accept", content: { name: "ghost" } });
  check("an answer to a session that closed meanwhile is cancelled", (await dyingQuestion) === "cancel");
}

finish(checker.failures);
