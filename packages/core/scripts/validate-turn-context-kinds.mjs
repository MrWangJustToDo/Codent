/**
 * Validates the turn-context **kind catalog** and the shared reminder mechanism.
 *
 * Three injection shapes share one catalog. This guard keeps them honest:
 *
 * 1. hash-admitted sections (turn-context middleware) — inject when content differs;
 * 2. condition + counter reminders (todo nag, repeat nudge) — shared recovery/builder in
 *    `agent/turn-context/reminder/counter-reminder.ts`, per-domain due rules;
 * 3. background-result pushes (job completion, later background tasks) — appended per result.
 *
 * It asserts three things a refactor can silently break:
 *
 * - **Every tag comes from the catalog.** No source file outside `turn-context-message.ts`
 *   may spell a catalog kind as a quoted literal — that is how `repeat_tool_reminder` and
 *   `background_notification` drifted out of the catalog in the first place.
 * - **The reminder domains share the mechanism**, not just the prose: both build through
 *   `buildCounterReminderSection`, so both carry the same recovery attrs (scope + counter +
 *   episode) and both are recoverable with `readCounterReminderState`.
 * - **Recovery is scoped.** A block from another cycle/chain never counts, and a
 *   turn-scoped counter stops at a genuine user prompt.
 *
 * Run: pnpm --filter @codent/core run validate:turn-context-kinds
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCounterReminderSection,
  contextAttributesFromText,
  DEFAULT_REPEAT_THRESHOLDS,
  formatContextSectionUserContent,
  readCounterReminderState,
  readRepeatReminderWindowState,
  REPEAT_REMINDER_KIND,
  resolveRepeatReminder,
  resolveTodoReminder,
  TURN_CONTEXT_KINDS,
  TodoManager,
} from "../dist/dev.mjs";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const CATALOG_FILE = join(SRC_DIR, "agent/turn-context/turn-context-message.ts");

// ---------------------------------------------------------------------------
// 1. The catalog owns every tag — including the two derived ones.
// ---------------------------------------------------------------------------
assert.equal(TURN_CONTEXT_KINDS.repeatReminder, "repeat_tool_reminder", "repeat kind is in the catalog");
assert.equal(
  TURN_CONTEXT_KINDS.backgroundNotification,
  "background_notification",
  "notification kind is in the catalog"
);
assert.equal(REPEAT_REMINDER_KIND, TURN_CONTEXT_KINDS.repeatReminder, "the reminder exports the catalog value");

const kinds = Object.values(TURN_CONTEXT_KINDS);
assert.equal(new Set(kinds).size, kinds.length, "catalog values are unique");

/** Every `.ts` under `src`, excluding the catalog itself. */
function sourceFiles(dir = SRC_DIR, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(path, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && path !== CATALOG_FILE) {
      out.push(path);
    }
  }
  return out;
}

const offenders = [];
for (const file of sourceFiles()) {
  const text = readFileSync(file, "utf8");
  for (const kind of kinds) {
    // A hand-written TAG is the real offence (`<ctx kind=mode>`); a plain `"mode"` is a
    // legitimate word elsewhere (the command catalog, status strings) and is not a tag.
    const tagLiteral = new RegExp(`<ctx kind=${kind}[\\s>]`);
    if (tagLiteral.test(text)) {
      offenders.push(`${relative(SRC_DIR, file)} → <ctx kind=${kind}>`);
    }
    // Compound values are unambiguous: they must never be spelled outside the catalog
    // (that is exactly how `repeat_tool_reminder` / `background_notification` drifted).
    if (kind.includes("_") && (text.includes(`"${kind}"`) || text.includes(`'${kind}'`))) {
      offenders.push(`${relative(SRC_DIR, file)} → "${kind}"`);
    }
  }
}
assert.deepEqual(
  offenders,
  [],
  `a turn-context kind must be written once, in the catalog (TURN_CONTEXT_KINDS). Offenders:\n  ${offenders.join("\n  ")}`
);

// ---------------------------------------------------------------------------
// 2. Both reminder domains build through the same section shape.
// ---------------------------------------------------------------------------
const section = buildCounterReminderSection({
  kind: TURN_CONTEXT_KINDS.reminder,
  scopeAttr: "cycle",
  scope: "call_1",
  valueAttr: "rounds",
  value: 7,
  episode: 2,
  content: "<reminder>body</reminder>",
});
assert.deepEqual(section.attrs, { cycle: "call_1", rounds: "7", episode: "2" }, "scope + counter + episode");
const rendered = formatContextSectionUserContent(section);
assert.deepEqual(
  contextAttributesFromText(rendered),
  { cycle: "call_1", rounds: "7", episode: "2" },
  "the shell attrs round-trip through the rendered message"
);

// The todo nag and the repeat nudge produce the same attr shape.
const todoManager = new TodoManager();
todoManager.update([{ content: "step", status: "in_progress", priority: "high" }], "Plan");
const todoWire = [
  { role: "user", content: "work" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_todo", type: "function", function: { name: "todo", arguments: "{}" } }],
  },
  { role: "tool", content: "ok", toolCallId: "call_todo" },
  ...Array.from({ length: 3 }, (_, index) => ({ role: "assistant", content: `step ${index}` })),
];
const nag = resolveTodoReminder(todoManager, todoWire);
assert.ok(nag, "the todo nag resolves at its threshold");
assert.deepEqual(Object.keys(nag.attrs).sort(), ["cycle", "episode", "rounds"]);

const repeatWire = [
  { role: "user", content: "go" },
  ...Array.from({ length: DEFAULT_REPEAT_THRESHOLDS[0] }, (_, index) => [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `call_${index}`,
          type: "function",
          function: { name: "grep", arguments: JSON.stringify({ pattern: "foo" }) },
        },
      ],
    },
    { role: "tool", content: "ok", toolCallId: `call_${index}` },
  ]).flat(),
];
const repeat = resolveRepeatReminder(repeatWire);
assert.ok(repeat, "the repeat reminder resolves at its threshold");
assert.deepEqual(Object.keys(repeat.section.attrs).sort(), ["chain", "count", "episode"]);

// ---------------------------------------------------------------------------
// 3. Recovery is scoped: other cycles/chains never count, prompts end turn scopes.
// ---------------------------------------------------------------------------
const reminderMessage = (attrs) => ({
  role: "user",
  content: formatContextSectionUserContent({
    key: TURN_CONTEXT_KINDS.reminder,
    content: "<reminder>body</reminder>",
    attrs,
  }),
});
const withOtherCycle = [reminderMessage({ cycle: "call_old", rounds: "18", episode: "3" })];
assert.deepEqual(
  readCounterReminderState(withOtherCycle, {
    kind: TURN_CONTEXT_KINDS.reminder,
    scopeAttr: "cycle",
    scope: "call_new",
    valueAttr: "rounds",
  }),
  { episodes: 0, lastValue: 0 },
  "a block from another cycle is cleanup, not state"
);
assert.deepEqual(
  readCounterReminderState(withOtherCycle, {
    kind: TURN_CONTEXT_KINDS.reminder,
    scopeAttr: "cycle",
    scope: "call_old",
    valueAttr: "rounds",
  }),
  { episodes: 1, lastValue: 18 },
  "the owning cycle recovers it"
);

const repeatScope = {
  kind: TURN_CONTEXT_KINDS.repeatReminder,
  scopeAttr: "chain",
  scope: "abc12345",
  valueAttr: "count",
  withinTurnOnly: true,
};
const previousTurn = [
  {
    role: "user",
    content: formatContextSectionUserContent({
      key: TURN_CONTEXT_KINDS.repeatReminder,
      content: "body",
      attrs: { chain: "abc12345", count: "3", episode: "1" },
    }),
  },
  { role: "user", content: "a new instruction" },
];
assert.deepEqual(
  readCounterReminderState(previousTurn, repeatScope),
  { episodes: 0, lastValue: 0 },
  "a turn-scoped counter stops at the newest genuine prompt"
);
assert.equal(
  readRepeatReminderWindowState(previousTurn, "abc12345").episodes,
  0,
  "the repeat domain applies that rule"
);

console.log("turn-context kinds validation passed");
