/**
 * Reminder sections (condition + counter injections) and the mechanism they share.
 *
 * `counter-reminder.ts` is the mechanism; `todo-reminder.ts` and `repeat-reminder.ts` are
 * the two policies. A third reminder should follow the same shape: decide its own scan slice
 * and counter from the wire, look for its previous block with `findCounterReminder`, apply its
 * own due rule, and build through `buildCounterReminderSection`.
 */

export { buildCounterReminderSection, findCounterReminder } from "./counter-reminder.js";
export type { CounterReminderRecord, CounterReminderSectionInput, CounterReminderSpec } from "./counter-reminder.js";

export { buildTodoReminderBody, readTodoReminderWindowState, resolveTodoReminder } from "./todo-reminder.js";
export type { TodoReminderWindowState } from "./todo-reminder.js";

export {
  buildRepeatReminderBody,
  canonicalizeRepeatArguments,
  DEFAULT_ARGUMENTS_PREVIEW_CHARS,
  DEFAULT_REPEAT_EXCLUDED_TOOLS,
  DEFAULT_REPEAT_THRESHOLDS,
  isGenuineUserMessage,
  previewRepeatArguments,
  readRepeatReminderWindowState,
  readTrailingRepeatChain,
  resolveRepeatReminder,
} from "./repeat-reminder.js";
export type { RepeatChain, RepeatReminderDecision, RepeatReminderWindowState } from "./repeat-reminder.js";
