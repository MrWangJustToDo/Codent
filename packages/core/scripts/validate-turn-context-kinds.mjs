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
 * - **One kind, scope-identified blocks.** The todo nag and the repeat nudge both use
 *   `reminder`; the scope attrs (`cycle` / `chain`) are what keep them apart. A block of
 *   the other scope must not suppress this one, and must not make it look like a
 *   supersede (a nag may not tell the model to ignore a loop warning).
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
  AgentUIChannel,
  buildCounterReminderSection,
  createTurnContextMiddleware,
  contextAttributesFromText,
  DEFAULT_REPEAT_THRESHOLDS,
  formatContextSectionUserContent,
  formatSectionTag,
  REMINDER_TAGS,
  readCounterReminderState,
  readRepeatReminderWindowState,
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
  "the repeat nudge does not need its own kind — the scope attr identifies the block"
);

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
assert.equal(nag.key, TURN_CONTEXT_KINDS.reminder);

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
assert.ok(!("cycle" in repeat.section.attrs) && !("chain" in nag.attrs), "the scope attr is what differs");

// ---------------------------------------------------------------------------
// 3. Recovery is scoped: other cycles/chains never count, prompts end turn scopes.
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
const withOtherCycle = [reminderMessage(REMINDER_TAGS.todo, { cycle: "call_old", rounds: "18", episode: "3" })];
assert.deepEqual(
  readCounterReminderState(withOtherCycle, { ...todoSpec, scope: "call_new" }),
  { episodes: 0, lastValue: 0 },
  "a block from another cycle is cleanup, not state"
);
assert.deepEqual(
  readCounterReminderState(withOtherCycle, todoSpec),
  { episodes: 1, lastValue: 18 },
  "the owning cycle recovers it"
);

// The subtype, not just the attrs, decides: a repeat-tagged block that carries a cycle attr
// (or a todo-tagged one carrying a chain) must never count for the other reminder.
assert.deepEqual(
  readCounterReminderState(
    [reminderMessage(REMINDER_TAGS.repeat, { cycle: "call_old", rounds: "18", episode: "3" })],
    todoSpec
  ),
  { episodes: 0, lastValue: 0 },
  "the todo counter ignores a repeat-tagged block even with a matching cycle attr"
);
assert.deepEqual(
  readCounterReminderState([reminderMessage(REMINDER_TAGS.todo, { chain: "abc12345", count: "3", episode: "1" })], {
    kind: TURN_CONTEXT_KINDS.reminder,
    tag: REMINDER_TAGS.repeat,
    scopeAttr: "chain",
    scope: "abc12345",
    valueAttr: "count",
  }),
  { episodes: 0, lastValue: 0 },
  "the repeat counter ignores a todo-tagged block even with a matching chain attr"
);

const repeatScope = {
  kind: TURN_CONTEXT_KINDS.reminder,
  tag: REMINDER_TAGS.repeat,
  scopeAttr: "chain",
  scope: "abc12345",
  valueAttr: "count",
  withinTurnOnly: true,
};
const previousTurn = [
  reminderMessage(REMINDER_TAGS.repeat, { chain: "abc12345", count: "3", episode: "1" }),
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

// ---------------------------------------------------------------------------
// 4. A sibling block of the same kind (other scope) neither suppresses nor supersedes.
// ---------------------------------------------------------------------------
{
  const channel = new AgentUIChannel();
  channel.setMessages([{ id: "u1", role: "user", parts: [{ type: "text", content: "work" }] }]);
  // The repeat nudge already in the window, same kind, different scope.
  const repeatBlock = formatContextSectionUserContent(repeat.section);
  const wire = [{ role: "user", content: "work" }, ...todoWire.slice(1), { role: "user", content: repeatBlock }];
  let currentSection = nag;
  const middleware = createTurnContextMiddleware({
    getFrozenSystemPrompt: () => undefined,
    getSections: async () => [currentSection],
    getUIChannel: () => channel,
    persistMessages: () => {},
    getManagedAgent: () => null,
  });
  const result = await middleware.onConfig({}, { messages: wire });
  const injected = (result.messages ?? wire).slice(wire.length);
  assert.equal(injected.length, 1, "a repeat block does not satisfy the todo nag's scope");
  assert.ok(String(injected[0].content).includes("unchanged for"), "the todo nag is injected");
  assert.ok(
    !String(injected[0].content).includes("authoritative"),
    "a different scope is not a supersede: the nag must not tell the model to ignore the loop warning"
  );

  // Same scope DOES supersede: a later round of the same cycle carries the notice.
  const sameScopeWire = [...wire, { role: "user", content: injected[0].content }];
  currentSection = { ...nag, content: nag.content.replace("unchanged for 3 rounds", "unchanged for 9 rounds") };
  const second = await middleware.onConfig({}, { messages: sameScopeWire });
  const secondInjected = (second.messages ?? sameScopeWire).slice(sameScopeWire.length);
  assert.equal(secondInjected.length, 1, "a later round injects a fresh nag");
  assert.ok(String(secondInjected[0].content).includes("authoritative"), "the same cycle's earlier nag is superseded");
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
  "agent/turn-context/reminder/todo-reminder.ts",
  "agent/turn-context/reminder/repeat-reminder.ts",
  "managers/middleware/background-notification-middleware.ts",
];
// Only a whole-string literal (`"<tag>"`) is a second renderer. Backtick-delimited mentions
// inside prose (``the `<session_id>` block``) are documentation, not construction.
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

console.log("turn-context kinds validation passed");
