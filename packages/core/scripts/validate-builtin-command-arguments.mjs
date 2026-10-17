/**
 * Builtin command ARGUMENT grammar — one definition, asserted against every host's needs.
 *
 * The grammar lives in core (`parseModeCommand` / `parseEffortCommand`) because it is the command
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
  isReasoningEffort,
  parseEffortCommand,
  parseModeCommand,
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
// /effort
// ============================================================================

const effortCases = [
  ["", { kind: "status" }],
  ["status", { kind: "status" }],
  ["display", { kind: "display", action: "toggle" }],
  ["display toggle", { kind: "display", action: "toggle" }],
  ["display on", { kind: "display", action: "on" }],
  ["display off", { kind: "display", action: "off" }],
  ["display?", { kind: "display", action: "status" }],
  ["off", { kind: "clear" }],
  ["low", { kind: "set", effort: "low" }],
  ["minimal", { kind: "set", effort: "minimal" }],
];

for (const [raw, expected] of effortCases) {
  assert.deepEqual(parseEffortCommand(raw), expected, `/effort ${raw}`);
}

assert.deepEqual(parseEffortCommand("DISPLAY ON"), { kind: "display", action: "on" }, "case-insensitive");
assert.deepEqual(parseEffortCommand("bogus"), { kind: "invalid", value: "bogus" });

// Every value the union exposes is accepted, and the guard agrees with the list.
for (const value of REASONING_EFFORT_VALUES) {
  assert.equal(isReasoningEffort(value), true, `${value} is an effort value`);
  assert.deepEqual(parseEffortCommand(value), { kind: "set", effort: value });
}
assert.equal(isReasoningEffort("display"), false);

// A value outside the union is invalid, not forwarded to the model.
assert.deepEqual(parseEffortCommand("turbo"), { kind: "invalid", value: "turbo" });

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
