/**
 * The repeat-call nudge — a condition + counter reminder sharing the `reminder` kind with
 * the todo nag. A block is identified by `(kind, scope)`: this domain writes
 * `chain`/`count`, the todo nag writes `cycle`/`rounds`, and each recovery filters by its
 * own scope attr, so one kind cannot mask the other.
 *
 * Advisory loop hygiene: when the model calls the same tool with identical arguments
 * repeatedly, the result will not change and the task stops progressing. At the configured
 * consecutive-repeat counts this section asks the model to inspect the previous result and
 * change approach or finish. It is advisory, never a veto — it counts and injects, it never
 * blocks, delays, or rewrites a call.
 *
 * Scan (newest → oldest over the model-visible window):
 *
 * 1. If the nearest tracked tool call has no repetition, there is no loop — skip.
 * 2. Otherwise keep walking left while the calls are identical; that run is the counter and
 *    its hash is the scope.
 * 3. Look for the nearest `<repeat-reminder>` block **inside that run**: its `count` is the
 *    last admitted round. Inject only when the current count crosses a threshold and is
 *    strictly greater than that; the next injection is `episode + 1`.
 * 4. The first call that does not belong to the run ends the slice — a reminder before it
 *    belongs to an earlier loop and must not suppress this one.
 *
 * Detection is exact-match only: the tool name plus the canonically stringified arguments
 * (object keys deep-sorted). Untracked calls (`excludeTools`) are transparent — they
 * neither count nor break the chain.
 */

import { BUILTIN_TOOL_NAMES } from "../../tools/catalog/tool-names.js";
import {
  REMINDER_TAGS,
  TURN_CONTEXT_KINDS,
  hashTurnContextPayload,
  isGenuineUserMessage,
} from "../turn-context-message.js";

import { buildCounterReminderSection, findCounterReminder } from "./counter-reminder.js";

import type { WireToolCall } from "../background-jobs.js";
import type { TurnContextSection } from "../turn-context-message.js";
import type { ModelMessage } from "@tanstack/ai";

// ============================================================================
// Policy defaults
// ============================================================================

/** Consecutive-repeat counts that trigger a reminder. */
export const DEFAULT_REPEAT_THRESHOLDS = [3, 5, 8] as const;

/** Max characters of the repeated arguments quoted in the detailed reminder. */
export const DEFAULT_ARGUMENTS_PREVIEW_CHARS = 500;

/**
 * Tools excluded by default: `get_command_output` is meant to be polled, so the
 * same call repeated while a background job runs is legitimate, not a loop.
 */
export const DEFAULT_REPEAT_EXCLUDED_TOOLS = [BUILTIN_TOOL_NAMES.getCommandOutput] as const;

const REMINDER_KIND = TURN_CONTEXT_KINDS.reminder;
const REMINDER_TAG = REMINDER_TAGS.repeat;
const SCOPE_ATTR = "chain";
const VALUE_ATTR = "count";

const GENTLE_REMINDER =
  "You are repeating the exact same tool call with identical arguments. " +
  "Carefully analyze the previous result before calling again: if the task is not " +
  "complete, try a different approach or different arguments instead of repeating the call.";

// ============================================================================
// Pure helpers (exported for validation)
// ============================================================================

/** Deep key-sort so two argument objects differing only in property order canonicalize identically. */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key]);
    }
    return sorted;
  }
  return value;
}

/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
export function canonicalizeRepeatArguments(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

/** Head-truncate canonical arguments for the detailed reminder, marking the omission. */
export function previewRepeatArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical;
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`;
}

/** One run of trailing identical tool calls, read from the wire. */
export interface RepeatChain {
  /** Scope identity of the repeated call (tool name + canonical arguments), hashed. */
  chain: string;
  toolName: string;
  /** Canonical (key-sorted) arguments of the repeated call. */
  canonicalArguments: string;
  /** How many times the call repeats consecutively at the tail. */
  count: number;
  /** Index of the earliest message in this run — the slice a prior reminder must sit in. */
  start: number;
}

/** Identity of one call, tolerant of an unparseable argument stream. */
function repeatChainKey(name: string, rawArguments: string | undefined): { chain: string; canonical: string } {
  const raw = rawArguments ?? "";
  try {
    const canonical = canonicalizeRepeatArguments(JSON.parse(raw));
    return { chain: hashTurnContextPayload(`${name}\n${canonical}`), canonical };
  } catch {
    return { chain: hashTurnContextPayload(`${name}\n${raw}`), canonical: raw };
  }
}

/**
 * The trailing repeat chain of the wire, or `undefined` when the last tracked call is unique.
 *
 * Walks newest-first across assistant messages, skipping tool results and synthetic `<ctx>`
 * user messages. A genuine user message or an assistant message without tool calls ends the
 * chain; so does the first tracked call whose identity differs. Excluded tools are transparent.
 */
export function readTrailingRepeatChain(
  messages: readonly ModelMessage[],
  options: { excludeTools?: Iterable<string> } = {}
): RepeatChain | undefined {
  const excluded = new Set(options.excludeTools ?? DEFAULT_REPEAT_EXCLUDED_TOOLS);
  let head: { chain: string; toolName: string; canonicalArguments: string; count: number; start: number } | undefined;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "user") {
      if (!isGenuineUserMessage(message)) continue;
      break;
    }
    if (message.role !== "assistant") continue;
    const calls = (message as { toolCalls?: readonly WireToolCall[] }).toolCalls;
    if (!calls || calls.length === 0) break;

    for (let index = calls.length - 1; index >= 0; index--) {
      const call = calls[index]!;
      const name = call.function?.name;
      if (!name || excluded.has(name)) continue;
      const key = repeatChainKey(name, call.function?.arguments);
      if (head && key.chain !== head.chain) return head;
      if (!head) head = { chain: key.chain, toolName: name, canonicalArguments: key.canonical, count: 0, start: i };
      head.count += 1;
      head.start = i;
    }
  }

  return head;
}

/** The reminder already admitted inside `chain`'s run, if any. */
export interface RepeatReminderWindowState {
  /** Injection round of that reminder (`0` when the run has none). */
  episode: number;
  /** `count` recorded on it (`0` when the run has none). */
  lastCount: number;
}

/** Recover the reminder admitted inside the run (only blocks inside it can speak for it). */
export function readRepeatReminderWindowState(
  messages: readonly ModelMessage[],
  chain: Pick<RepeatChain, "chain" | "start">
): RepeatReminderWindowState {
  const admitted = findCounterReminder(messages.slice(chain.start), {
    kind: REMINDER_KIND,
    tag: REMINDER_TAG,
    scopeAttr: SCOPE_ATTR,
    scope: chain.chain,
    valueAttr: VALUE_ATTR,
  });
  return { episode: admitted?.episode ?? 0, lastCount: admitted?.value ?? 0 };
}

/**
 * Render the reminder body for a repeat at `count`.
 *
 * The gentle text is the FIRST nudge of a chain (episode 1), not "the first threshold value":
 * a parallel batch can jump over a threshold, and the first nudge the model sees must still be
 * the soft one.
 */
export function buildRepeatReminderBody(input: {
  toolName: string;
  count: number;
  canonicalArguments: string;
  episode: number;
  previewChars: number;
}): string {
  if (input.episode <= 1) return GENTLE_REMINDER;
  return (
    "Repeated tool call detected:\n" +
    `- tool: ${input.toolName}\n` +
    `- consecutive_calls: ${input.count}\n` +
    `- arguments: ${previewRepeatArguments(input.canonicalArguments, input.previewChars)}\n` +
    "The repeated calls are not making progress. Do not call this tool with " +
    "these exact arguments again. Inspect the latest result and choose a " +
    "different action, different arguments, or finish the task if enough " +
    "evidence has been gathered."
  );
}

/** Resolved reminder: the section to inject and the chain it describes. */
export interface RepeatReminderDecision {
  section: TurnContextSection;
  chain: RepeatChain;
}

/**
 * The reminder for this turn's trailing chain, or `undefined` when it is not due.
 *
 * Due when the count has **crossed** a threshold since the last admission (not when it equals
 * one: a parallel batch can jump 2 → 4 and would otherwise skip 3 forever) and the chain has
 * not already been nudged at or past that count. A dropped reminder (compaction cut) simply
 * makes it due again; a retry that re-runs `onConfig` on the same wire changes nothing.
 */
export function resolveRepeatReminder(
  messages: readonly ModelMessage[],
  options: { thresholds?: readonly number[]; excludeTools?: readonly string[]; previewChars?: number } = {}
): RepeatReminderDecision | undefined {
  const thresholds = [...(options.thresholds ?? DEFAULT_REPEAT_THRESHOLDS)].sort((a, b) => a - b);
  const previewChars = options.previewChars ?? DEFAULT_ARGUMENTS_PREVIEW_CHARS;

  const chain = readTrailingRepeatChain(messages, { excludeTools: options.excludeTools });
  if (!chain) return undefined;

  const state = readRepeatReminderWindowState(messages, chain);
  if (state.episode > 0 && state.lastCount >= chain.count) return undefined;

  const crossed = thresholds.some((threshold) => threshold > state.lastCount && chain.count >= threshold);
  if (!crossed) return undefined;

  const episode = state.episode + 1;
  return {
    chain,
    section: {
      ...buildCounterReminderSection({
        kind: REMINDER_KIND,
        tag: REMINDER_TAG,
        scopeAttr: SCOPE_ATTR,
        scope: chain.chain,
        valueAttr: VALUE_ATTR,
        value: chain.count,
        episode,
        content: buildRepeatReminderBody({
          toolName: chain.toolName,
          count: chain.count,
          canonicalArguments: chain.canonicalArguments,
          episode,
          previewChars,
        }),
      }),
      // Name our own tag, never the shared kind: a nudge supersedes only earlier nudges.
      ...(state.episode > 0 ? { supersedes: REMINDER_TAG } : {}),
    },
  };
}
