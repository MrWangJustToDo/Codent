/**
 * `<reminder>` todo nag — a condition + counter reminder.
 *
 * The nag used to be decided and recorded inside `TodoManager` (a live round counter plus
 * the last nag round, the nags-per-cycle and a monotonic episode id). That state was
 * invisible to the message chain, so a compaction cut or a session restore either replayed
 * a stale schedule or lost it entirely.
 *
 * Both halves now come from the model-visible window:
 *
 * - **Counter + scope**: the newest `todo` tool call in the window is the cycle, and
 *   `rounds` is the assistant turns after it. The counter restarts at 0 exactly when the
 *   model updates the list, because the update becomes the newest `todo` call. If the call
 *   is gone (compaction dropped it), the nag is skipped — the model can no longer see the
 *   list it would be asked to update, so a nag is noise.
 * - **Admitted state**: {@link readCounterReminderState} (same rule as the repeat nudge)
 *   counts the `reminder` blocks carrying this cycle's id and the highest `rounds` they
 *   recorded.
 *
 * `TodoManager` keeps only the policy (threshold / cooldown / growth).
 */

import { BUILTIN_TOOL_NAMES } from "../../tools/catalog/tool-names.js";
import { TURN_CONTEXT_KINDS } from "../turn-context-message.js";

import { buildCounterReminderSection, readCounterReminderState } from "./counter-reminder.js";

import type { TodoManager } from "../../todo";
import type { TurnContextSection } from "../turn-context-message.js";
import type { ModelMessage } from "@tanstack/ai";

/** Structural view of a wire assistant tool call (TanStack `ToolCall` is assignable). */
interface WireToolCall {
  id: string;
  function: { name: string; arguments?: string };
}

const REMINDER_KIND = TURN_CONTEXT_KINDS.reminder;
const SCOPE_ATTR = "cycle";
const VALUE_ATTR = "rounds";

/** Round/episode state recovered from the window for one todo cycle. */
export interface TodoReminderWindowState {
  /** The `todo` tool-call id that started this cycle. */
  cycle: string;
  /** Completed model turns since that call. */
  rounds: number;
  /** Nag reminders already admitted in this cycle. */
  episodes: number;
  /** `rounds` recorded on the newest of those reminders. */
  lastRound: number;
}

/** Current todo cycle + completed turns since it, from the wire. */
export function readTodoReminderWindowState(messages: readonly ModelMessage[]): TodoReminderWindowState | undefined {
  let rounds = 0;
  let cycle: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    const calls = (message as { toolCalls?: readonly WireToolCall[] }).toolCalls;
    const todoCall = (calls ?? []).find((call) => call.function?.name === BUILTIN_TOOL_NAMES.todo);
    if (todoCall) {
      cycle = todoCall.id;
      break;
    }
    rounds += 1;
  }
  if (cycle === undefined) return undefined;

  const admitted = readCounterReminderState(messages, {
    kind: REMINDER_KIND,
    scopeAttr: SCOPE_ATTR,
    scope: cycle,
    valueAttr: VALUE_ATTR,
  });

  return { cycle, rounds, episodes: admitted.episodes, lastRound: admitted.lastValue };
}

/** Render the nag body (the round/episode text is also what makes each nag hash-unique). */
export function buildTodoReminderContent(rounds: number, episode: number): string {
  return [
    "<reminder>",
    "Update your todos - mark completed tasks and update progress.",
    `(nag #${episode}, unchanged for ${rounds} rounds)`,
    "</reminder>",
  ].join("\n");
}

/**
 * The nag section for this turn, or `undefined` when it is not due.
 *
 * Backoff (unchanged from the previous in-memory policy): the first gap after a nag is
 * `cooldown`, then each subsequent gap grows by `growth`.
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
  if (state.episodes > 0) {
    const growthSteps = Math.max(0, state.episodes - 1);
    const cooldown = policy.cooldown + growthSteps * policy.growth;
    if (state.rounds - state.lastRound < cooldown) return undefined;
  }

  const episode = state.episodes + 1;
  return buildCounterReminderSection({
    kind: REMINDER_KIND,
    scopeAttr: SCOPE_ATTR,
    scope: state.cycle,
    valueAttr: VALUE_ATTR,
    value: state.rounds,
    episode,
    content: buildTodoReminderContent(state.rounds, episode),
  });
}
