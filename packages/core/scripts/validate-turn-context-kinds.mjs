/**
 * Validates the turn-context **kind catalog**, the shared reminder mechanism, and the split
 * between the three injection shapes.
 *
 * 1. **Hash-admitted sections** — turn-context middleware: inject when the content differs
 *    from the newest block of the same identity in the wire.
 * 2. **Condition + counter reminders** — todo nag and repeat nudge: their own middlewares,
 *    sharing `agent/turn-context/reminder/counter-reminder.ts` (nearest-block recovery +
 *    attr-carrying builder) and each owning its scan and due rule.
 * 3. **Background pushes** — completion notifications, plus the `<background_jobs>` pointer
 *    which is hash-admitted but owned by the background middleware.
 *
 * It asserts what a refactor can silently break:
 *
 * - **Every tag comes from the catalog** and every section body is rendered by
 *   `formatSectionTag` — a literal tag drifts from what admission/recovery reads back.
 * - **One kind, tag-identified blocks**: both reminders use `reminder`; the inner tag
 *   (`todo-reminder` / `repeat-reminder`) is the discriminator, so a block of the other
 *   reminder can never be counted for this one.
 * - **The families stay separate**: turn context no longer contributes a reminder section, and
 *   the reminder middlewares are their own entries in the pipeline.
 *
 * Run: pnpm --filter @codent/core run validate:turn-context-kinds
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCounterReminderSection,
  buildTurnContextSections,
  CANONICAL_MIDDLEWARE_ORDER,
  contextAttributesFromText,
  DEFAULT_REPEAT_THRESHOLDS,
  findCounterReminder,
  formatContextSectionUserContent,
  formatSectionTag,
  readRepeatReminderWindowState,
  REMINDER_TAGS,
  resolveRepeatReminder,
  resolveTodoReminder,
  TURN_CONTEXT_KINDS,
  TodoManager,
} from "../dist/dev.mjs";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const CATALOG_FILE = join(SRC_DIR, "agent/turn-context/turn-context-message.ts");

// ---------------------------------------------------------------------------
// 1. The catalog owns every tag.
// ---------------------------------------------------------------------------
assert.equal(
  TURN_CONTEXT_KINDS.backgroundNotification,
  "background_notification",
  "notification kind is in the catalog"
);
assert.equal(
  Object.values(TURN_CONTEXT_KINDS).filter((kind) => kind === "reminder").length,
  1,
  "both counter reminders share one catalog entry"
);
assert.ok(
  !("repeatReminder" in TURN_CONTEXT_KINDS),
  "the repeat nudge does not need its own kind — its inner tag identifies the block"
);
const kinds = Object.values(TURN_CONTEXT_KINDS);
assert.equal(new Set(kinds).size, kinds.length, "catalog values are unique");

// ---------------------------------------------------------------------------
// 2. Both reminders build the same shape from one mechanism.
// ---------------------------------------------------------------------------
const section = buildCounterReminderSection({
  kind: TURN_CONTEXT_KINDS.reminder,
  tag: REMINDER_TAGS.todo,
  scopeAttr: "cycle",
  scope: "call_1",
  valueAttr: "rounds",
  value: 7,
  episode: 2,
  content: "body",
});
assert.deepEqual(section.attrs, { cycle: "call_1", rounds: "7", episode: "2" }, "scope + counter + episode");
assert.equal(section.content, formatSectionTag(REMINDER_TAGS.todo, "body"), "the body carries the reminder tag");
const rendered = formatContextSectionUserContent(section);
assert.deepEqual(
  contextAttributesFromText(rendered),
  { cycle: "call_1", rounds: "7", episode: "2" },
  "the shell attrs round-trip through the rendered message"
);

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
assert.equal(nag.key, TURN_CONTEXT_KINDS.reminder);
assert.match(nag.content, /^<todo-reminder>/, "the nag declares its own tag");

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
assert.equal(repeat.section.key, nag.key, "both reminders use the same kind");
assert.match(repeat.section.content, /^<repeat-reminder>/, "the nudge declares its own tag");
assert.ok(!("cycle" in repeat.section.attrs) && !("chain" in nag.attrs), "the scope attr is what differs");

// ---------------------------------------------------------------------------
// 3. Recovery: the tag identifies the reminder, the scope attr identifies the cycle/chain.
// ---------------------------------------------------------------------------
const todoSpec = {
  kind: TURN_CONTEXT_KINDS.reminder,
  tag: REMINDER_TAGS.todo,
  scopeAttr: "cycle",
  scope: "call_old",
  valueAttr: "rounds",
};
const reminderMessage = (tag, attrs) => ({
  role: "user",
  content: formatContextSectionUserContent({
    key: TURN_CONTEXT_KINDS.reminder,
    content: formatSectionTag(tag, "body"),
    attrs,
  }),
});

assert.equal(findCounterReminder([], todoSpec), undefined, "an empty window has no admitted block");
assert.deepEqual(
  findCounterReminder(
    [reminderMessage(REMINDER_TAGS.todo, { cycle: "call_old", rounds: "18", episode: "3" })],
    todoSpec
  ),
  { episode: 3, value: 18 },
  "the owning cycle recovers its block"
);
assert.equal(
  findCounterReminder([reminderMessage(REMINDER_TAGS.todo, { cycle: "call_old", rounds: "18", episode: "3" })], {
    ...todoSpec,
    scope: "call_new",
  }),
  undefined,
  "a block from another cycle is cleanup, not state"
);
// The subtype, not just the attrs, decides: a repeat-tagged block carrying a cycle attr (or a
// todo-tagged one carrying a chain) never counts for the other reminder.
assert.equal(
  findCounterReminder(
    [reminderMessage(REMINDER_TAGS.repeat, { cycle: "call_old", rounds: "18", episode: "3" })],
    todoSpec
  ),
  undefined,
  "the todo counter ignores a repeat-tagged block even with a matching cycle attr"
);
assert.equal(
  findCounterReminder([reminderMessage(REMINDER_TAGS.todo, { chain: "abc12345", count: "3", episode: "1" })], {
    kind: TURN_CONTEXT_KINDS.reminder,
    tag: REMINDER_TAGS.repeat,
    scopeAttr: "chain",
    scope: "abc12345",
    valueAttr: "count",
  }),
  undefined,
  "the repeat counter ignores a todo-tagged block even with a matching chain attr"
);

// The nearest block wins (two admissions of the same cycle).
assert.deepEqual(
  findCounterReminder(
    [
      reminderMessage(REMINDER_TAGS.todo, { cycle: "call_old", rounds: "3", episode: "1" }),
      reminderMessage(REMINDER_TAGS.todo, { cycle: "call_old", rounds: "8", episode: "2" }),
    ],
    todoSpec
  ),
  { episode: 2, value: 8 },
  "the newest admission of the scope is the state"
);

// The repeat scan is bounded by the run: a reminder before the run does not speak for it.
const repeatState = readRepeatReminderWindowState(
  [{ ...reminderMessage(REMINDER_TAGS.repeat, { chain: "abc12345", count: "3", episode: "1" }) }],
  { chain: "abc12345", start: 1 }
);
assert.deepEqual(repeatState, { episode: 0, lastCount: 0 }, "outside the run → no admitted block");

// ---------------------------------------------------------------------------
// 4. The families are separate: notice scope, admitted set, and pipeline entries.
// ---------------------------------------------------------------------------
// A later nag/nudge names its OWN tag in the supersede notice. Naming the shared kind would
// tell the model to ignore the other reminder family — the invariant the shared kind exists
// to avoid.
const todoWithPrior = resolveTodoReminder(todoManager, [
  ...todoWire,
  { role: "user", content: formatContextSectionUserContent(nag) },
  { role: "assistant", content: "one more turn" },
  { role: "assistant", content: "and another" },
  { role: "assistant", content: "and a third" },
  { role: "assistant", content: "and a fourth" },
  { role: "assistant", content: "and a fifth" },
]);
assert.ok(todoWithPrior?.supersedes, "a later nag supersedes an earlier one");
assert.equal(todoWithPrior.supersedes, REMINDER_TAGS.todo);
const todoNotice = formatContextSectionUserContent(todoWithPrior);
assert.match(todoNotice, new RegExp(`If earlier <${REMINDER_TAGS.todo}> blocks`), "the nag names its own tag");
assert.ok(!todoNotice.includes(`<${REMINDER_TAGS.repeat}> blocks`), "a nag never points at the repeat nudge's blocks");

const repeatWithPrior = resolveRepeatReminder([
  ...repeatWire,
  { role: "user", content: formatContextSectionUserContent(repeat.section) },
  ...Array.from({ length: DEFAULT_REPEAT_THRESHOLDS[1] - DEFAULT_REPEAT_THRESHOLDS[0] }, (_, index) => [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `after_${index}`,
          type: "function",
          function: { name: "grep", arguments: JSON.stringify({ pattern: "foo" }) },
        },
      ],
    },
    { role: "tool", content: "ok", toolCallId: `after_${index}` },
  ]).flat(),
]);
assert.ok(repeatWithPrior?.section.supersedes, "a later nudge supersedes an earlier one");
assert.equal(repeatWithPrior.section.supersedes, REMINDER_TAGS.repeat);
const repeatNotice = formatContextSectionUserContent(repeatWithPrior.section);
assert.match(repeatNotice, new RegExp(`If earlier <${REMINDER_TAGS.repeat}> blocks`), "the nudge names its own tag");
assert.ok(!repeatNotice.includes(`<${REMINDER_TAGS.todo}> blocks`), "a nudge never points at the todo nag's blocks");

// A hash-admitted section names its kind (there is no inner-tag identity any more).
assert.match(
  formatContextSectionUserContent(
    { key: "current_date", content: "<current_date>x</current_date>" },
    { isUpdate: true }
  ),
  /If earlier <current_date> blocks/,
  "hash-admitted sections name their kind"
);

// Turn context is hash-admitted sections only: its builder has no reminder input at all.
const turnContextSections = buildTurnContextSections({
  relevantMemoryContent: "",
  currentDate: "October 25, 2026",
  gitBranch: "main",
  modeContent: "<mode_state>off</mode_state>",
});
assert.deepEqual(
  turnContextSections.map((built) => built.key),
  [TURN_CONTEXT_KINDS.currentDate, TURN_CONTEXT_KINDS.gitStatus, TURN_CONTEXT_KINDS.mode],
  "turn context contributes no reminder section"
);

// Each family owns a pipeline slot.
for (const name of ["turn-context", "todo-reminder", "repeat-reminder", "background"]) {
  assert.ok(CANONICAL_MIDDLEWARE_ORDER.includes(name), `${name} is a pipeline entry`);
}

// ---------------------------------------------------------------------------
// 5. Section builders render through `formatSectionTag` — no isolated tag literals.
// ---------------------------------------------------------------------------
// A hand-written `<foo>` string element in a builder is invisible to the reader but breaks
// identity: admission and reminder recovery compare the tag that was actually rendered, so a
// literal that drifts from the catalog silently splits one section into two. Prose mentions
// inside a longer sentence (``the `<session_id>` block``) are fine — only a whole-string tag
// literal is a second renderer.
const SECTION_BUILDERS = [
  "managers/managed-agent-prompt.ts",
  "agent/turn-context/instruction-context.ts",
  "agent/turn-context/session-retrieval.ts",
  "agent/turn-context/background-jobs.ts",
  "agent/memory/memory-retrieval.ts",
  "agent/turn-context/reminder/counter-reminder.ts",
  "managers/middleware/background-middleware.ts",
];
const QUOTE = "[\"']";
const sectionTags = [...Object.values(TURN_CONTEXT_KINDS), ...Object.values(REMINDER_TAGS)];
/** Doc comments name tags for the reader; only executable literals can construct one. */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const bareTags = [];
for (const relativePath of SECTION_BUILDERS) {
  const text = stripComments(readFileSync(join(SRC_DIR, relativePath), "utf8"));
  for (const tag of sectionTags) {
    if (new RegExp(`${QUOTE}<${tag}>${QUOTE}`).test(text)) bareTags.push(`${relativePath} → "<${tag}>"`);
  }
}
assert.deepEqual(
  bareTags,
  [],
  `a section builder must render its tag through formatSectionTag(); a literal tag drifts from the ` +
    `catalog and from what recovery reads back. Offenders:\n  ${bareTags.join("\n  ")}`
);

// No source file outside the catalog spells a catalog kind as a quoted literal (compound
// values) or writes a literal `<ctx kind=...>` tag — that is how `background_notification` and
// `repeat_tool_reminder` had drifted out of it.
function sourceFiles(dir = SRC_DIR, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.isFile() && entry.name.endsWith(".ts") && path !== CATALOG_FILE) out.push(path);
  }
  return out;
}
const offenders = [];
for (const file of sourceFiles()) {
  const text = readFileSync(file, "utf8");
  for (const kind of kinds) {
    if (new RegExp(`<ctx kind=${kind}[\\s>]`).test(text)) {
      offenders.push(`${relative(SRC_DIR, file)} → <ctx kind=${kind}>`);
    }
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

console.log("turn-context kinds validation passed");
