/**
 * Shared mechanism for **condition + counter** reminders.
 *
 * Two sections inject this way: the todo nag and the repeat-call nudge. Both ask the same
 * question — "the window shows a counter (rounds since the list changed / consecutive
 * identical calls); has it moved past what we already told the model?" — and both have to
 * answer it from the message chain alone, because a compaction cut, `/resume`, a session
 * switch or a process restart must not reset the schedule.
 *
 * What is shared here:
 *
 * 1. **Recovery** — {@link readCounterReminderState} reads the admitted blocks of a kind
 *    and keeps only those belonging to the *current scope* (the todo cycle id / the repeat
 *    chain hash). Blocks from an earlier scope are the "cleanup" rule: they never count,
 *    so a new cycle starts at episode 1 without any explicit reset. `withinTurnOnly` adds
 *    the second cleanup rule the repeat nudge needs: a genuine user prompt ends the window
 *    slice, so a loop in a later turn is not suppressed by an earlier turn's block.
 * 2. **Shape** — {@link buildCounterReminderSection} writes the reminder's own tag
 *    (`<todo-reminder>` / `<repeat-reminder>`) inside the shared `reminder` envelope, and the
 *    counter state into shell attrs. Identity is `(kind, inner tag)`: the tag says WHICH
 *    reminder this is, the scope attr (`cycle` / `chain`) says which cycle/chain it counts,
 *    and `episode` counts admissions within that scope.
 *
 * What is NOT shared: *when* the counter is due. The todo nag grows its cooldown
 * (threshold + per-episode growth), the repeat nudge fires at discrete thresholds. Each
 * domain owns that rule and calls in here for the state and the section.
 */

import { extractTextFromContent } from "../../compaction/message-utils.js";
import {
  extractContextSection,
  formatSectionTag,
  isContextModelMessage,
  sectionTagOf,
} from "../turn-context-message.js";

import type { TurnContextSection } from "../turn-context-message.js";
import type { ModelMessage } from "@tanstack/ai";

/** Identity of one counter's scope, plus the attrs it travels under. */
export interface CounterReminderSpec {
  /** Section kind (`TURN_CONTEXT_KINDS.*`) — the `<ctx kind=...>` tag. */
  kind: string;
  /**
   * Inner section tag naming THIS reminder (`REMINDER_TAGS.todo` / `.repeat`).
   *
   * The two reminders share one kind, so the tag is the discriminator: recovery reads it back
   * and a block of the other tag never counts, no matter what attrs it carries.
   */
  tag: string;
  /** Shell attr naming the scope the counter belongs to (`cycle` / `chain`). */
  scopeAttr: string;
  /** Current scope value (todo tool-call id, repeat chain hash). */
  scope: string;
  /** Shell attr holding the counter value at admission (`rounds` / `count`). */
  valueAttr: string;
  /**
   * Stop recovering at the newest genuine user prompt.
   *
   * Turn-scoped counters (repeat calls) must not let an earlier turn's reminder suppress
   * this turn's; cycle-scoped counters (todos) deliberately span prompts, because a user
   * "continue" does not restart the todo cycle.
   */
  withinTurnOnly?: boolean;
}

/** Admitted state of one counter in the window, restricted to its current scope. */
export interface CounterReminderState {
  /** Reminders already admitted for this scope. */
  episodes: number;
  /** Highest counter value recorded on those reminders (`0` when none). */
  lastValue: number;
}

/** Recover the admitted state of a counter from the model-visible wire. */
export function readCounterReminderState(
  messages: readonly ModelMessage[],
  spec: CounterReminderSpec
): CounterReminderState {
  let episodes = 0;
  let lastValue = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "user" && !isContextModelMessage(message)) {
      if (spec.withinTurnOnly) break;
      // A prompt does not end a cycle-scoped counter, but it cannot carry a block either.
      continue;
    }
    if (!isContextModelMessage(message)) continue;
    const section = extractContextSection(extractTextFromContent(message.content));
    if (!section || section.key !== spec.kind) continue;
    if (sectionTagOf(section.content) !== spec.tag) continue;
    if (section.attrs?.[spec.scopeAttr] !== spec.scope) continue;
    episodes += 1;
    const recorded = Number(section.attrs[spec.valueAttr]);
    if (Number.isFinite(recorded) && recorded > lastValue) lastValue = recorded;
  }
  return { episodes, lastValue };
}

/** Input for {@link buildCounterReminderSection}. */
export interface CounterReminderSectionInput extends CounterReminderSpec {
  /** Counter value this admission reports. */
  value: number;
  /** Admission episode within the scope (1-based). */
  episode: number;
  /** Reminder body (without its inner tag; this layer adds the tag). */
  content: string;
}

/**
 * Build the reminder section with its recovery state on the shell.
 *
 * The body is what the model reads (and what the hash/id is derived from); the attrs are
 * what the next turn reads back. A section with identical body text but a later episode
 * still hashes differently only if the body carries the episode — every domain embeds it.
 */
export function buildCounterReminderSection(input: CounterReminderSectionInput): TurnContextSection {
  return {
    key: input.kind,
    content: formatSectionTag(input.tag, input.content.trim()),
    attrs: {
      [input.scopeAttr]: input.scope,
      [input.valueAttr]: String(input.value),
      episode: String(input.episode),
    },
  };
}
