/**
 * `<reminder>` todo nag — round/backoff state recovered from the window.
 *
 * The nag used to be decided and recorded inside `TodoManager` (a live round counter plus
 * the last nag round, the nags-per-cycle and a monotonic episode id). That state was
 * invisible to the message chain, so a compaction cut or a session restore either replayed
 * a stale schedule or lost it entirely.
 *
 * The rule is now the one every injecting section follows: **derive the state from the
 * model-visible window**.
 *
 * - The cycle is the id of the newest `todo` tool call in the window. If that call is gone
 *   (compaction dropped it), the nag is skipped — the model can no longer see the list it
 *   would be asked to update, so a nag is noise.
 * - Rounds = assistant turns after that call (one per completed model turn). It restarts at
 *   0 exactly when the model updates the list, because the update becomes the newest `todo`
 *   call.
 * - Episodes / last round come from the `<ctx kind=reminder>` blocks carrying this cycle's
 *   id in their `cycle` attribute (a cut is a prefix cut, so a cycle that survives keeps
 *   all of its reminders).
 *
 * No counter, no episode id and no reset path lives outside the message chain.
 */

import { extractTextFromContent } from "../compaction/message-utils.js";
import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";

import { TURN_CONTEXT_KINDS, extractContextSection, isContextModelMessage } from "./turn-context-message.js";

import type { TurnContextSection } from "./turn-context-message.js";
import type { TodoManager } from "../todo";
import type { ModelMessage } from "@tanstack/ai";

/** Structural view of a wire assistant tool call (TanStack `ToolCall` is assignable). */
interface WireToolCall {
  id: string;
  function: { name: string; arguments?: string };
}

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

const REMINDER_KIND = TURN_CONTEXT_KINDS.reminder;

/**
 * Locate the current todo cycle and count completed turns since it, from the wire.
 *
 * Returns `undefined` when no `todo` call is visible — the caller then skips the nag.
 */
export function readTodoReminderWindowState(messages: readonly ModelMessage[]): TodoReminderWindowState | undefined {
  let turns = 0;
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
    turns += 1;
  }
  if (cycle === undefined) return undefined;

  let episodes = 0;
  let lastRound = 0;
  for (const message of messages) {
    if (!isContextModelMessage(message)) continue;
    const section = extractContextSection(extractTextFromContent(message.content));
    if (!section || section.key !== REMINDER_KIND) continue;
    if (section.attrs?.cycle !== cycle) continue;
    episodes += 1;
    const recorded = Number(section.attrs.rounds);
    if (Number.isFinite(recorded) && recorded > lastRound) lastRound = recorded;
  }

  return { cycle, rounds: turns, episodes, lastRound };
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
  return {
    key: REMINDER_KIND,
    content: buildTodoReminderContent(state.rounds, episode),
    attrs: { cycle: state.cycle, rounds: String(state.rounds), episode: String(episode) },
  };
}
