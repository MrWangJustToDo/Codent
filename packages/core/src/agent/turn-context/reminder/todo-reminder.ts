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
 * 4. **No `todo` call in the window** (a plan-seeded list, or the call was compacted away) →
 *    fall back to a per-turn anchor: the newest genuine user prompt is the cycle and rounds are
 *    the turns after it. Without that, a list the agent was *given* would never nag, which is
 *    exactly the long stale cycle the nag exists for.
 *
 * `TodoManager` keeps only the policy (threshold / cooldown / growth).
 */

import { BUILTIN_TOOL_NAMES } from "../../tools/catalog/tool-names.js";
import { REMINDER_TAGS, TURN_CONTEXT_KINDS, isGenuineUserMessage } from "../turn-context-message.js";

import { buildCounterReminderSection, findCounterReminder } from "./counter-reminder.js";

import type { TodoManager } from "../../todo";
import type { WireToolCall } from "../background-jobs.js";
import type { TurnContextSection } from "../turn-context-message.js";
import type { ModelMessage } from "@tanstack/ai";

const REMINDER_KIND = TURN_CONTEXT_KINDS.reminder;
const REMINDER_TAG = REMINDER_TAGS.todo;
const SCOPE_ATTR = "cycle";
const VALUE_ATTR = "rounds";
/**
 * Scope used when the window carries no `todo` call to anchor the cycle on (plan-seeded list,
 * or the call was compacted away). The slice is the current turn, so each new prompt restarts
 * the countdown — the list is still stale and worth one nudge per turn, not one per cooldown.
 */
const WINDOW_SCOPE = "window";

/** What the newest markers in the window say about the current todo cycle. */
export interface TodoReminderWindowState {
  /** The `todo` tool-call id that started this cycle. */
  cycle: string;
  /** Completed model turns since that call. */
  rounds: number;
  /** The nearest reminder of this cycle, when the first marker was one. */
  prior?: { episode: number; rounds: number };
}

/** The `todo` tool-call id in an assistant message, if it made one. */
function todoCallIdOf(message: ModelMessage): string | undefined {
  if (message.role !== "assistant") return undefined;
  const calls = (message as { toolCalls?: readonly WireToolCall[] }).toolCalls;
  return (calls ?? []).find((call) => call.function?.name === BUILTIN_TOOL_NAMES.todo)?.id;
}

/** Assistant turns strictly after `index` (model calls, one per completed turn). */
function turnsAfter(messages: readonly ModelMessage[], index: number): number {
  let rounds = 0;
  for (let i = index + 1; i < messages.length; i++) {
    if (messages[i]?.role === "assistant") rounds += 1;
  }
  return rounds;
}

/** The nearest reminder of `cycle` inside `messages` (a slice that starts after the cycle). */
function priorIn(messages: readonly ModelMessage[], cycle: string): { episode: number; rounds: number } | undefined {
  const prior = findCounterReminder(messages, {
    kind: REMINDER_KIND,
    tag: REMINDER_TAG,
    scopeAttr: SCOPE_ATTR,
    scope: cycle,
    valueAttr: VALUE_ATTR,
  });
  return prior ? { episode: prior.episode, rounds: prior.value } : undefined;
}

/**
 * The current todo cycle and its counter, recovered from the window.
 *
 * The cycle is the newest `todo` call. When the window has none (the list was seeded by plan
 * mode, or the call fell out of the kept window), the current turn is the cycle: rounds count
 * from the newest genuine user prompt, so a list the agent was handed still gets nudged.
 */
export function readTodoReminderWindowState(messages: readonly ModelMessage[]): TodoReminderWindowState | undefined {
  // 1. The newest `todo` call anywhere in the window anchors the cycle. A prompt does NOT end
  //    it: the list stays current across turns, so the countdown must not restart per prompt.
  for (let i = messages.length - 1; i >= 0; i--) {
    const cycle = messages[i] ? todoCallIdOf(messages[i]!) : undefined;
    if (!cycle) continue;
    const prior = priorIn(messages.slice(i + 1), cycle);
    return { cycle, rounds: turnsAfter(messages, i), ...(prior ? { prior } : {}) };
  }

  // 2. No call at all (plan-seeded list / the call left the kept window): the current turn is
  //    the cycle, so a list the agent was handed still gets nudged.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || !isGenuineUserMessage(message)) continue;
    const prior = priorIn(messages.slice(i + 1), WINDOW_SCOPE);
    return { cycle: WINDOW_SCOPE, rounds: turnsAfter(messages, i), ...(prior ? { prior } : {}) };
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
 * the same round: the counter must have advanced past the previous admission. "Rounds" are
 * completed model turns, so the nag now lands one turn later than the removed per-iteration
 * counter — the gaps (3 / 8 / 18 / 33) are unchanged.
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
    // Name our own tag: the two reminders share `reminder`, and only the todo nag may be
    // declared authoritative over an earlier todo nag.
    ...(state.prior ? { supersedes: REMINDER_TAG } : {}),
  };
}
