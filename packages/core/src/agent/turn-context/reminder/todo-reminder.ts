/**
 * Todo nag — a condition + counter reminder.
 *
 * Scan (newest → oldest over the model-visible window):
 *
 * 1. Walk back for the **nearest** of two markers: a `<todo-reminder>` block, or the `todo`
 *    tool call that updated the list.
 * 2. If the first marker is the **call** — the list was updated and nothing has nagged since
 *    — the cycle starts here and the round counter is the assistant turns after it.
 * 3. If the first marker is a **reminder** — this cycle already nagged, at `episode`/`rounds`
 *    from its attrs. Keep the counter from the call that started the cycle (further left) and
 *    nag again only when the schedule says so. The next admission is `episode + 1` and a
 *    strictly larger `rounds`, so one round can never be reported twice.
 * 4. No `todo` call in the window (compacted away) → no nag: the model can no longer see the
 *    list it would be asked to update.
 *
 * `TodoManager` keeps only the policy (threshold / cooldown / growth).
 */

import { extractTextFromContent } from "../../compaction/message-utils.js";
import { BUILTIN_TOOL_NAMES } from "../../tools/catalog/tool-names.js";
import {
  REMINDER_TAGS,
  TURN_CONTEXT_KINDS,
  extractContextSection,
  isContextModelMessage,
  sectionTagOf,
} from "../turn-context-message.js";

import { buildCounterReminderSection, findCounterReminder } from "./counter-reminder.js";

import type { TodoManager } from "../../todo";
import type { TurnContextSection } from "../turn-context-message.js";
import type { ModelMessage } from "@tanstack/ai";

/** Structural view of a wire assistant tool call (TanStack `ToolCall` is assignable). */
interface WireToolCall {
  id: string;
  function: { name: string; arguments?: string };
}

const REMINDER_KIND = TURN_CONTEXT_KINDS.reminder;
const REMINDER_TAG = REMINDER_TAGS.todo;
const SCOPE_ATTR = "cycle";
const VALUE_ATTR = "rounds";

/** What the newest markers in the window say about the current todo cycle. */
export interface TodoReminderWindowState {
  /** The `todo` tool-call id that started this cycle. */
  cycle: string;
  /** Completed model turns since that call. */
  rounds: number;
  /** The nearest reminder of this cycle, when the first marker was one. */
  prior?: { episode: number; rounds: number };
}

/** Whether `message` is a `<todo-reminder>` block (the nag itself). */
function isTodoReminderMessage(message: ModelMessage): boolean {
  if (!isContextModelMessage(message)) return false;
  const section = extractContextSection(extractTextFromContent(message.content));
  return section?.key === REMINDER_KIND && sectionTagOf(section.content) === REMINDER_TAG;
}

/** The `todo` tool-call id in an assistant message, if it made one. */
function todoCallIdOf(message: ModelMessage): string | undefined {
  if (message.role !== "assistant") return undefined;
  const calls = (message as { toolCalls?: readonly WireToolCall[] }).toolCalls;
  return (calls ?? []).find((call) => call.function?.name === BUILTIN_TOOL_NAMES.todo)?.id;
}

/**
 * The current todo cycle and its counter, recovered from the window.
 *
 * Returns `undefined` when no `todo` call is visible. The reminder found on the way is the
 * nearest one after the call, i.e. it belongs to this cycle by construction.
 */
export function readTodoReminderWindowState(messages: readonly ModelMessage[]): TodoReminderWindowState | undefined {
  // `rounds` counts assistant turns after the call; the reminder's own block does not count.
  let rounds = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    // The nearest reminder of this cycle: remember it, keep walking for its `todo` call.
    if (isTodoReminderMessage(message)) continue;
    const cycle = todoCallIdOf(message);
    if (cycle) {
      const prior = findCounterReminder(messages.slice(i + 1), {
        kind: REMINDER_KIND,
        tag: REMINDER_TAG,
        scopeAttr: SCOPE_ATTR,
        scope: cycle,
        valueAttr: VALUE_ATTR,
      });
      return {
        cycle,
        rounds,
        ...(prior ? { prior: { episode: prior.episode, rounds: prior.value } } : {}),
      };
    }
    if (message.role === "assistant") rounds += 1;
  }
  return undefined;
}

/** Render the nag body (the round/episode text is also what makes each nag hash-unique). */
export function buildTodoReminderBody(rounds: number, episode: number): string {
  return [
    "Update your todos - mark completed tasks and update progress.",
    `(nag #${episode}, unchanged for ${rounds} rounds)`,
  ].join("\n");
}

/**
 * The nag section for this turn, or `undefined` when it is not due.
 *
 * Backoff (unchanged from the previous in-memory policy): the first gap after a nag is
 * `cooldown`, then each subsequent gap grows by `growth`. A nag is never admitted twice for
 * the same round: the counter must have advanced past the previous admission.
 */
export function resolveTodoReminder(
  todoManager: TodoManager | null,
  messages: readonly ModelMessage[]
): TurnContextSection | undefined {
  if (!todoManager || !todoManager.hasTodos() || !todoManager.hasIncompleteTodos()) return undefined;

  const state = readTodoReminderWindowState(messages);
  if (!state) return undefined;

  const policy = todoManager.getNagPolicy();
  if (state.rounds < policy.threshold) return undefined;
  if (state.prior) {
    if (state.rounds <= state.prior.rounds) return undefined;
    const growthSteps = Math.max(0, state.prior.episode - 1);
    const cooldown = policy.cooldown + growthSteps * policy.growth;
    if (state.rounds - state.prior.rounds < cooldown) return undefined;
  }

  const episode = (state.prior?.episode ?? 0) + 1;
  return {
    ...buildCounterReminderSection({
      kind: REMINDER_KIND,
      tag: REMINDER_TAG,
      scopeAttr: SCOPE_ATTR,
      scope: state.cycle,
      valueAttr: VALUE_ATTR,
      value: state.rounds,
      episode,
      content: buildTodoReminderBody(state.rounds, episode),
    }),
    admitAsUpdate: state.prior !== undefined,
  };
}
