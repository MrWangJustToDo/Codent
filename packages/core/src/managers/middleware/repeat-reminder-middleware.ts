/**
 * Repeat-tool-call reminder — advisory loop hygiene.
 *
 * When the model calls the same tool with identical arguments repeatedly, it is
 * often stuck: the result will not change and the task stops progressing. At the
 * configured consecutive-repeat counts this middleware appends a short synthetic
 * `<ctx kind=repeat_tool_reminder>` message asking the model to inspect the
 * previous result and change approach or finish.
 *
 * It is advisory, never a veto: it counts attempts and injects a message onto the
 * next wire; it never blocks, delays, or rewrites a call.
 *
 * **The count is derived from the wire, not remembered.** The repeat chain is the run
 * of trailing identical tool calls in the model-visible messages, so the same two
 * steps every injecting section uses apply: read the newest reminder of this kind from
 * the window (its `chain` / `count` attrs), compare it with the chain this turn would
 * report, and inject only when the chain has moved past it. A compaction cut, a
 * restore, a restart or an aborted run therefore cannot lose, double, or replay the
 * counter — there is nothing to lose.
 *
 * Detection is exact-match only: a call is "the same" when the tool name and the
 * canonically stringified arguments (object keys deep-sorted) match. A different
 * tracked call ends the chain; a genuine user prompt does too. Untracked calls
 * (`excludeTools`) are transparent — they neither count nor break the chain.
 */

import { extractTextFromContent } from "../../agent/compaction/message-utils.js";
import { BUILTIN_TOOL_NAMES } from "../../agent/tools/catalog/tool-names.js";
import { injectSyntheticMessages } from "../../agent/turn-context/synthetic-injection.js";
import {
  contextAttributesFromText,
  formatContextSectionUserContent,
  hashTurnContextPayload,
  isContextModelMessage,
  syntheticKindFromId,
} from "../../agent/turn-context/turn-context-message.js";

import { defineMiddleware } from "./phase.js";

import type { AgentUIChannel } from "../../agent/ui/ui-channel.js";
import type { ChatMiddleware, ModelMessage, UIMessage } from "@tanstack/ai";

// ============================================================================
// Constants
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

/** Synthetic-message kind (also the `<ctx kind=...>` tag). */
export const REPEAT_REMINDER_KIND = "repeat_tool_reminder";

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

/**
 * Whether a wire message is a real user prompt (not a synthetic `<ctx ...>`
 * injection). Reuses the shared context classifier so the `<ctx kind=` envelope
 * has a single reader.
 */
export function isGenuineUserMessage(message: ModelMessage): boolean {
  return message.role === "user" && !isContextModelMessage(message);
}

/** One run of trailing identical tool calls, read from the wire. */
export interface RepeatChain {
  /** Stable identity of the repeated call (tool name + canonical arguments), hashed for the attr. */
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
 * The trailing repeat chain of the wire, or `undefined` when the last tool call is unique.
 *
 * Walks newest-first across assistant messages, skipping tool results and synthetic
 * `<ctx>` user messages. A genuine user message or an assistant message without tool
 * calls ends the chain; so does the first tracked call whose identity differs. Excluded
 * tools are transparent.
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

/** The newest repeat reminder still in the window, with the chain it belongs to. */
export function readLatestRepeatReminder(
  messages: readonly ModelMessage[]
): { chain: string; count: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    // Reminders from an earlier turn cannot speak for the current chain.
    if (isGenuineUserMessage(message)) return undefined;
    if (!isContextModelMessage(message)) continue;
    const text = extractTextFromContent(message.content);
    if (!text.includes(REPEAT_REMINDER_KIND)) continue;
    const attrs = contextAttributesFromText(text);
    const count = Number(attrs.count);
    if (!attrs.chain || !Number.isFinite(count)) continue;
    return { chain: attrs.chain, count };
  }
  return undefined;
}

/** Render the reminder body for a repeat at `count`. */
export function buildRepeatReminderContent(input: {
  toolName: string;
  count: number;
  canonicalArguments: string;
  firstThreshold: number;
  previewChars: number;
  chain: string;
}): string {
  const body =
    input.count === input.firstThreshold
      ? GENTLE_REMINDER
      : "Repeated tool call detected:\n" +
        `- tool: ${input.toolName}\n` +
        `- consecutive_calls: ${input.count}\n` +
        `- arguments: ${previewRepeatArguments(input.canonicalArguments, input.previewChars)}\n` +
        "The repeated calls are not making progress. Do not call this tool with " +
        "these exact arguments again. Inspect the latest result and choose a " +
        "different action, different arguments, or finish the task if enough " +
        "evidence has been gathered.";
  return formatContextSectionUserContent({
    key: REPEAT_REMINDER_KIND,
    content: body,
    attrs: { chain: input.chain, count: String(input.count) },
  });
}

// ============================================================================
// Middleware
// ============================================================================

export interface RepeatReminderMiddlewareDeps {
  thresholds?: number[];
  excludeTools?: string[];
  argumentsPreviewChars?: number;
  /** Live access to the UI channel (to persist the synthetic reminder). */
  getUIChannel: () => AgentUIChannel | undefined;
  /** Persist the updated UI messages (no-op for subagents without a session store). */
  persistMessages: (next: UIMessage[]) => void;
}

/**
 * Add-run loop hygiene: nudge the model out of identical tool-call loops.
 *
 * Runs on every model call and reads the loop straight off the wire, so a retry,
 * an aborted run, a compaction cut or a restore all produce the same answer.
 */
export function createRepeatReminderMiddleware(deps: RepeatReminderMiddlewareDeps): ChatMiddleware {
  const thresholds = [...(deps.thresholds ?? DEFAULT_REPEAT_THRESHOLDS)].sort((a, b) => a - b);
  const firstThreshold = thresholds[0] ?? DEFAULT_REPEAT_THRESHOLDS[0];
  const thresholdSet = new Set(thresholds);
  const excludeTools = deps.excludeTools ?? [...DEFAULT_REPEAT_EXCLUDED_TOOLS];
  const previewChars = deps.argumentsPreviewChars ?? DEFAULT_ARGUMENTS_PREVIEW_CHARS;

  return defineMiddleware("tools", {
    name: "repeat-reminder",
    onConfig: async (_ctx, config) => {
      const messages = config.messages as ModelMessage[];
      const chain = readTrailingRepeatChain(messages, { excludeTools });
      if (!chain || !thresholdSet.has(chain.count)) return {};

      const prior = readLatestRepeatReminder(messages);
      if (prior && prior.chain === chain.chain && prior.count >= chain.count) return {};

      const content = buildRepeatReminderContent({
        toolName: chain.toolName,
        count: chain.count,
        canonicalArguments: chain.canonicalArguments,
        firstThreshold,
        previewChars,
        chain: chain.chain,
      });

      const ui = deps.getUIChannel();
      if (!ui) {
        // No channel: transient wire-only injection (still a new array).
        return { messages: [...messages, { role: "user", content }] };
      }

      // Per-kind admission episode: count the existing channel ids for the kind so a
      // loop that recurs in a later turn gets a fresh id. The attrs already make the
      // content distinct per chain/count, but an identical chain at the same count in
      // a later turn must still land as a new message.
      let kindCount = 0;
      for (const message of ui.getMessages()) {
        if (syntheticKindFromId(message.id) === REPEAT_REMINDER_KIND) kindCount++;
      }

      const { messages: next } = injectSyntheticMessages(
        messages,
        [{ kind: REPEAT_REMINDER_KIND, content, nonce: kindCount + 1 }],
        {
          ui,
          persist: deps.persistMessages,
        }
      );
      return { messages: next };
    },
  });
}
