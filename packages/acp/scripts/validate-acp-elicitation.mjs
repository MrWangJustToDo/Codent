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

import { buildElicitationRequest, mapElicitationResponse } from "../dist/index.mjs";

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
finish(checker.failures);
