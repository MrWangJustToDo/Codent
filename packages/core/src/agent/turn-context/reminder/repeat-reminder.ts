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
 * Same two halves as the todo nag:
 *
 * - **Counter + scope**: the repeat chain is the run of trailing identical tool calls in the
 *   window, and its hash is the scope. A different tracked call ends the chain; a genuine
 *   user prompt ends the window slice (`withinTurnOnly`), so repetition across a fresh
 *   instruction is not a loop and an earlier turn's nudge cannot suppress a later one.
 * - **Admitted state**: {@link readCounterReminderState} reads the newest reminder blocks of
 *   this kind that carry the same chain, and their highest `count`.
 *
 * Detection is exact-match only: the tool name plus the canonically stringified arguments
 * (object keys deep-sorted). Untracked calls (`excludeTools`) are transparent — they
 * neither count nor break the chain.
 */

import { BUILTIN_TOOL_NAMES } from "../../tools/catalog/tool-names.js";
import { TURN_CONTEXT_KINDS, hashTurnContextPayload, isContextModelMessage } from "../turn-context-message.js";

import { buildCounterReminderSection, readCounterReminderState } from "./counter-reminder.js";

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

/** Whether a wire message is a real user prompt (not a synthetic `<ctx ...>` injection). */
export function isGenuineUserMessage(message: ModelMessage): boolean {
  return message.role === "user" && !isContextModelMessage(message);
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
}

interface WireToolCall {
  id: string;
  function: { name: string; arguments?: string };
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
  let head: { chain: string; toolName: string; canonicalArguments: string; count: number } | undefined;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "user") {
      if (isContextModelMessage(message)) continue;
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
      if (!head) head = { chain: key.chain, toolName: name, canonicalArguments: key.canonical, count: 0 };
      head.count += 1;
    }
  }

  return head;
}

/** Admitted reminders of the repeat kind for one chain (turn-scoped). */
export interface RepeatReminderWindowState {
  /** The chain those reminders belong to. */
  chain: string;
  /** Reminders already admitted for this chain in the current turn. */
  episodes: number;
  /** Highest `count` recorded on those reminders (`0` when none). */
  lastCount: number;
}

/** Recover the admitted repeat reminders that can still speak for `chain`. */
export function readRepeatReminderWindowState(
  messages: readonly ModelMessage[],
  chain: string
): RepeatReminderWindowState {
  const admitted = readCounterReminderState(messages, {
    kind: REMINDER_KIND,
    scopeAttr: SCOPE_ATTR,
    scope: chain,
    valueAttr: VALUE_ATTR,
    withinTurnOnly: true,
  });
  return { chain, episodes: admitted.episodes, lastCount: admitted.lastValue };
}

/** Render the reminder body for a repeat at `count`. */
export function buildRepeatReminderBody(input: {
  toolName: string;
  count: number;
  canonicalArguments: string;
  firstThreshold: number;
  previewChars: number;
}): string {
  if (input.count === input.firstThreshold) return GENTLE_REMINDER;
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
 * Due when the count is one of `thresholds` AND this chain has not already been nudged at
 * or past that count. A dropped reminder (compaction cut) simply makes it due again; a
 * retry that re-runs `onConfig` on the same wire changes nothing.
 */
export function resolveRepeatReminder(
  messages: readonly ModelMessage[],
  options: { thresholds?: readonly number[]; excludeTools?: readonly string[]; previewChars?: number } = {}
): RepeatReminderDecision | undefined {
  const thresholds = [...(options.thresholds ?? DEFAULT_REPEAT_THRESHOLDS)].sort((a, b) => a - b);
  const firstThreshold = thresholds[0] ?? DEFAULT_REPEAT_THRESHOLDS[0];
  const previewChars = options.previewChars ?? DEFAULT_ARGUMENTS_PREVIEW_CHARS;

  const chain = readTrailingRepeatChain(messages, { excludeTools: options.excludeTools });
  if (!chain || !thresholds.includes(chain.count)) return undefined;

  const state = readRepeatReminderWindowState(messages, chain.chain);
  if (state.episodes > 0 && state.lastCount >= chain.count) return undefined;

  const episode = state.episodes + 1;
  return {
    chain,
    section: buildCounterReminderSection({
      kind: REMINDER_KIND,
      scopeAttr: SCOPE_ATTR,
      scope: chain.chain,
      valueAttr: VALUE_ATTR,
      value: chain.count,
      episode,
      content: buildRepeatReminderBody({
        toolName: chain.toolName,
        count: chain.count,
        canonicalArguments: chain.canonicalArguments,
        firstThreshold,
        previewChars,
      }),
    }),
  };
}
