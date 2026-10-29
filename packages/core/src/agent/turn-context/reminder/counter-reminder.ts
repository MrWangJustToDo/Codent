/**
 * Shared mechanism for **condition + counter** reminders.
 *
 * Two sections inject this way: the todo nag and the repeat-call nudge. Both ask the same
 * question — "the window shows a counter (rounds since the list changed / consecutive
 * identical calls); has it moved past the block we already injected?" — and both answer it
 * from the message chain alone, because a compaction cut, `/resume`, a session switch or a
 * process restart must not reset the schedule.
 *
 * Each domain owns its **scan** (what the counter is, and which slice of the window it
 * applies to); this module owns the two pieces both need:
 *
 * 1. {@link findCounterReminder} — the nearest admitted block of this reminder inside the
 *    slice the caller decided on. Its `episode` attr is the injection round so far and its
 *    value attr is the counter at that round; the next injection must be a strictly later
 *    round with a strictly larger counter (see the domains).
 * 2. {@link buildCounterReminderSection} — writes the reminder's own tag
 *    (`<todo-reminder>` / `<repeat-reminder>`) inside the shared `reminder` envelope and the
 *    counter state into the shell attrs. A block's identity is `(kind, tag)`; the scope attr
 *    says which cycle/chain it counts and `episode` counts admissions within it.
 */

import { extractTextFromContent } from "../../../utils/message-content.js";
import {
  extractContextSection,
  formatSectionTag,
  isContextModelMessage,
  sectionTagOf,
} from "../turn-context-message.js";

import type { TurnContextSection } from "../turn-context-message.js";
import type { ModelMessage } from "@tanstack/ai";

/** Identity of one reminder kind inside the shared `reminder` section kind. */
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
  /** The scope value this reminder belongs to. */
  scope: string;
  /** Shell attr holding the counter value at admission (`rounds` / `count`). */
  valueAttr: string;
}

/** A previously admitted reminder of the same kind + scope. */
export interface CounterReminderRecord {
  /** Injection round within the scope (1-based). */
  episode: number;
  /** Counter value recorded on that block. */
  value: number;
}

/**
 * The nearest admitted block of this reminder inside `messages`, or `undefined`.
 *
 * `messages` is the slice the caller's scan produced (from the todo update / the start of the
 * repeat run to the head), so this walk can be a plain newest-first search: nothing older than
 * the slice can speak for the current counter.
 */
export function findCounterReminder(
  messages: readonly ModelMessage[],
  spec: CounterReminderSpec
): CounterReminderRecord | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || !isContextModelMessage(message)) continue;
    const section = extractContextSection(extractTextFromContent(message.content));
    if (!section || section.key !== spec.kind) continue;
    if (sectionTagOf(section.content) !== spec.tag) continue;
    if (section.attrs?.[spec.scopeAttr] !== spec.scope) continue;
    const episode = Number(section.attrs.episode);
    const value = Number(section.attrs[spec.valueAttr]);
    if (!Number.isFinite(episode) || !Number.isFinite(value)) continue;
    return { episode, value };
  }
  return undefined;
}

/** Input for {@link buildCounterReminderSection}. */
export interface CounterReminderSectionInput extends CounterReminderSpec {
  /** Counter value this admission reports. */
  value: number;
  /** Admission episode within the scope (1-based, strictly greater than the previous one). */
  episode: number;
  /** Reminder body (without its inner tag; this layer adds the tag). */
  content: string;
}

/**
 * Build the reminder section with its recovery state on the shell.
 *
 * The body is what the model reads (and what the hash/id is derived from); the attrs are
 * what the next scan reads back. A later admission never hashes identically to an earlier one
 * because either the counter in the body advanced (todo nag: rounds/episode) or the shell
 * attrs did (repeat nudge: count/episode) — and both are part of the rendered message.
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
