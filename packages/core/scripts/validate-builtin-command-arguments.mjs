/**
 * Builtin command ARGUMENT grammar — one definition, asserted against every host's needs.
 *
 * The grammar lives in core (`parseModeCommand` / `parseModelsCommand`) because it is the command
 * contract, not a surface detail. It used to live in the TUI's handlers alone: the ACP slash handler
 * recognised `plan|auto|off` and treated everything else as a toggle, so the advertised
 * `/mode execute|done|cancel|status|save|load|list` flipped the mode instead of building the plan.
 *
 * The catalog-drift check below is the part that keeps that from returning: every subcommand the
 * `/mode` usage advertises must parse.
 *
 * Run: pnpm --filter @codent/core run validate:builtin-command-arguments
 */

import assert from "node:assert/strict";

import {
  BUILTIN_COMMAND_CATALOG,
  offerableReasoningEfforts,
  parseModeCommand,
  parseModelsCommand,
  REASONING_EFFORT_VALUES,
  resolveSessionRef,
  supportedReasoningEfforts,
} from "../dist/index.mjs";

// ============================================================================
// /mode
// ============================================================================

const modeCases = [
  ["", { kind: "toggle" }, "no argument toggles (the interactive cycle)"],
  ["toggle", { kind: "toggle" }],
  ["plan", { kind: "set", mode: "plan" }],
  ["plan off", { kind: "set", mode: "normal" }],
  ["auto", { kind: "set", mode: "auto" }],
  ["auto off", { kind: "set", mode: "normal" }],
  ["switch plan", { kind: "set", mode: "plan" }],
  ["switch auto", { kind: "set", mode: "auto" }],
  ["switch", undefined, "an incomplete switch is not a command"],
  ["off", { kind: "set", mode: "normal" }],
  ["normal", { kind: "set", mode: "normal" }],
  ["status", { kind: "status" }],
  ["execute", { kind: "execute" }],
  ["run", { kind: "execute" }, "documented alias"],
  ["build", { kind: "execute" }, "documented alias"],
  ["done", { kind: "done" }],
  ["complete", { kind: "done" }, "documented alias"],
  ["cancel", { kind: "cancel" }],
  ["save", { kind: "save" }],
  ["save My Plan", { kind: "save", name: "My Plan" }, "a name keeps the user's spelling"],
  ["load foo", { kind: "load", name: "foo" }],
  ["load", undefined, "load requires a name"],
  ["list", { kind: "list" }],
  ["bogus", undefined],
];

for (const [raw, expected, note] of modeCases) {
  assert.deepEqual(parseModeCommand(raw), expected, note ? `/mode ${raw} — ${note}` : `/mode ${raw}`);
}

// Case-insensitive head, preserved name.
assert.deepEqual(parseModeCommand("SAVE My Plan"), { kind: "save", name: "My Plan" });

// Every advertised subcommand parses — the drift check. The usage is the contract a client renders,
// so a token it offers but the parser rejects (or misroutes) is the original bug.
const modeUsage = BUILTIN_COMMAND_CATALOG.find((entry) => entry.name === "mode")?.usage ?? "";
const usageBody = modeUsage.slice(modeUsage.indexOf("[") + 1, modeUsage.lastIndexOf("]"));
assert.ok(usageBody.length > 0, "the /mode catalog entry advertises its subcommands");
for (const alternative of usageBody.split("|")) {
  const token = alternative.trim().replace(/\[name\]|<name>/g, "x");
  assert.notEqual(parseModeCommand(token), undefined, `/mode usage advertises "${alternative.trim()}"`);
}

// ============================================================================
// /models — one command for the model AND its thinking depth
// ============================================================================

const modelsCases = [
  ["", { kind: "list" }, "no argument lists the entries"],
  ["0:gpt-5.1", { kind: "set", model: "gpt-5.1", entryIndex: 0 }],
  ["0:gpt-5.1 high", { kind: "set", model: "gpt-5.1", entryIndex: 0, effort: "high" }],
  ["0:gpt-5.1 off", { kind: "set", model: "gpt-5.1", entryIndex: 0, clearEffort: true }],
  ["0:a:b", { kind: "set", model: "a:b", entryIndex: 0 }, "the model id may contain a colon"],
  ["bare-model", { kind: "set", model: "bare-model" }, "no entry → the host resolves it"],
  ["bare-model high", { kind: "set", model: "bare-model", effort: "high" }, "a bare model + depth"],
  ["0:x turbo", { kind: "invalid", value: "0:x turbo" }, "an unknown level is not forwarded"],
  ["a b c", { kind: "invalid", value: "a b c" }, "more than two arguments is not a command"],
  ["0:", { kind: "invalid", value: "0:" }, "an entry without a model names nothing"],
];

for (const [raw, expected, note] of modelsCases) {
  assert.deepEqual(parseModelsCommand(raw), expected, note ? `/models ${raw} — ${note}` : `/models ${raw}`);
}
assert.deepEqual(
  parseModelsCommand("0:X HIGH"),
  { kind: "set", model: "X", entryIndex: 0, effort: "high" },
  "the level is case-insensitive and the model id is not"
);

// Every level the catalog advertises as an argument parses — the same drift check as /mode.
const modelsUsage = BUILTIN_COMMAND_CATALOG.find((entry) => entry.name === "models")?.usage ?? "";
assert.ok(modelsUsage.includes("effort"), "the /models usage advertises the depth argument");
for (const value of REASONING_EFFORT_VALUES) {
  assert.deepEqual(
    parseModelsCommand(`0:m ${value}`),
    { kind: "set", model: "m", entryIndex: 0, effort: value },
    `/models 0:m ${value}`
  );
}

// `/effort` is gone from the catalog: a headless host cannot advertise what does not exist.
assert.equal(
  BUILTIN_COMMAND_CATALOG.find((entry) => entry.name === "effort"),
  undefined,
  "/effort is not a built-in command any more — /models owns the thinking depth"
);

// ============================================================================
// offerableReasoningEfforts — what a MENU may offer (stricter than validation)
// ============================================================================

assert.deepEqual(
  offerableReasoningEfforts({ capabilities: ["reasoning"], reasoningConfig: { effortValues: ["low", "high"] } }),
  ["low", "high"],
  "a reasoning model's advertised levels are the menu"
);
assert.deepEqual(
  offerableReasoningEfforts({ capabilities: [], reasoningConfig: { effortValues: ["low"] } }),
  [],
  "no `reasoning` capability means no depth menu, even if levels leaked in"
);
assert.deepEqual(
  offerableReasoningEfforts({ capabilities: ["reasoning"] }),
  [],
  "reasoning without advertised levels offers nothing — the list is evidence, not a guess"
);
assert.deepEqual(offerableReasoningEfforts(undefined), [], "an unknown model offers nothing");
// The validation rule stays permissive, which is the deliberate asymmetry.
assert.deepEqual(supportedReasoningEfforts(undefined), REASONING_EFFORT_VALUES, "validation keeps the fallback");

// ============================================================================
// supportedReasoningEfforts
// ============================================================================

assert.deepEqual(supportedReasoningEfforts(undefined), REASONING_EFFORT_VALUES, "no model info → every level");
assert.deepEqual(
  supportedReasoningEfforts({ reasoningConfig: { effortValues: ["low", "high"] } }),
  ["low", "high"],
  "the model's advertised levels win"
);
assert.deepEqual(
  supportedReasoningEfforts({ reasoningConfig: { effortValues: [] } }),
  REASONING_EFFORT_VALUES,
  "an empty advertisement means unknown, not none"
);

// ============================================================================
// resolveSessionRef
// ============================================================================

const sessions = [
  { id: "ses_a", name: "Refactor the parser" },
  { id: "ses_b", name: "Parser notes" },
  { id: "ses_a_lookalike", name: "Other" },
];

assert.equal(resolveSessionRef(sessions, "ses_a")?.id, "ses_a", "an id wins over a lookalike id");
assert.equal(resolveSessionRef(sessions, "Other")?.id, "ses_a_lookalike", "exact name");
assert.equal(resolveSessionRef(sessions, "Refactor")?.id, "ses_a", "name contains, in list order");
assert.equal(resolveSessionRef(sessions, "   ")?.id, undefined, "an empty query matches nothing");
assert.equal(resolveSessionRef(sessions, "missing"), undefined);

console.log("builtin command arguments validation passed");
