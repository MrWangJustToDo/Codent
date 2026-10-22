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
 * Detection is exact-match only: a call is "the same" when the tool name and the
 * canonically stringified arguments (object keys deep-sorted) match the previous
 * tracked call. A different tracked call resets the count. Untracked calls
 * (`excludeTools`) are transparent — they neither count nor reset. The chain
 * resets when a new user prompt arrives, so repetition across a fresh instruction
 * is not treated as a loop.
 *
 * State is per-agent (the runner, and hence this middleware instance, is cached on
 * the agent) and in-memory only: a resumed session starts with a fresh chain, which
 * is the accepted cost of a heuristic nudge.
 */

import { BUILTIN_TOOL_NAMES } from "../../agent/tools/catalog/tool-names.js";
import { formatContextSectionUserContent, isContextModelMessage } from "../../agent/turn-context";
import { injectSyntheticMessages } from "../../agent/turn-context/synthetic-injection.js";

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

function detailedReminder(toolName: string, count: number, canonicalArguments: string): string {
  return (
    "Repeated tool call detected:\n" +
    `- tool: ${toolName}\n` +
    `- consecutive_calls: ${count}\n` +
    `- arguments: ${canonicalArguments}\n` +
    "The repeated calls are not making progress. Do not call this tool with " +
    "these exact arguments again. Inspect the latest result and choose a " +
    "different action, different arguments, or finish the task if enough " +
    "evidence has been gathered."
  );
}

/** Render the synthetic reminder body for a repeat at `count`. */
export function buildRepeatReminderContent(
  toolName: string,
  count: number,
  canonicalArguments: string,
  firstThreshold: number,
  previewChars: number
): string {
  const body =
    count === firstThreshold
      ? GENTLE_REMINDER
      : detailedReminder(toolName, count, previewRepeatArguments(canonicalArguments, previewChars));
  return formatContextSectionUserContent({ key: REPEAT_REMINDER_KIND, content: body });
}

/**
 * Whether a wire message is a real user prompt (not a synthetic `<ctx ...>`
 * injection). Reuses the shared context classifier so the `<ctx kind=` envelope
 * has a single reader.
 */
export function isGenuineUserMessage(message: ModelMessage): boolean {
  return message.role === "user" && !isContextModelMessage(message);
}

// ============================================================================
// Middleware
// ============================================================================

export interface RepeatReminderMiddlewareDeps {
  /** Consecutive-repeat counts that trigger a reminder (default [3, 5, 8]). */
  thresholds?: number[];
  /** Tool names never tracked (default ["get_command_output"]). */
  excludeTools?: string[];
  /** Max characters of arguments shown in the detailed reminder (default 500). */
  argumentsPreviewChars?: number;
  /** Live access to the UI channel (to persist the synthetic reminder). */
  getUIChannel: () => AgentUIChannel | undefined;
  /** Persist the updated UI messages (no-op for subagents without a session store). */
  persistMessages: (next: UIMessage[]) => void;
}

interface Chain {
  key: string;
  count: number;
}

/**
 * Add-run loop hygiene: nudge the model out of identical tool-call loops.
 *
 * Counting happens in `onBeforeToolCall` (every attempted call) and the pending
 * reminder is injected in `onConfig` — the next model call — so it lands after the
 * repeated call's result, matching the shared synthetic-injection path used by
 * turn-context and background notifications.
 */
export function createRepeatReminderMiddleware(deps: RepeatReminderMiddlewareDeps): ChatMiddleware {
  const thresholds = [...(deps.thresholds ?? DEFAULT_REPEAT_THRESHOLDS)].sort((a, b) => a - b);
  const firstThreshold = thresholds[0] ?? DEFAULT_REPEAT_THRESHOLDS[0];
  const thresholdSet = new Set(thresholds);
  const excluded = new Set(deps.excludeTools ?? DEFAULT_REPEAT_EXCLUDED_TOOLS);
  const previewChars = deps.argumentsPreviewChars ?? DEFAULT_ARGUMENTS_PREVIEW_CHARS;

  let chain: Chain | undefined;
  let pending: string | undefined;
  let seenUserMessages = 0;

  return defineMiddleware("tools", {
    name: "repeat-reminder",
    onBeforeToolCall: (_ctx, hookCtx) => {
      const toolName = hookCtx.toolName;
      if (excluded.has(toolName)) return;

      const canonical = canonicalizeRepeatArguments(hookCtx.args);
      const key = JSON.stringify([toolName, canonical]);
      const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1;
      chain = { key, count };

      if (thresholdSet.has(count)) {
        pending = buildRepeatReminderContent(toolName, count, canonical, firstThreshold, previewChars);
      }
      return;
    },
    onConfig: async (_ctx, config) => {
      const messages = config.messages as ModelMessage[];

      // A new user prompt changes the context; repetition across it is not a loop.
      // Drop any un-delivered reminder too: it belongs to the chain being abandoned,
      // and injecting it into an unrelated turn would misattribute the loop.
      const userMessages = messages.filter(isGenuineUserMessage).length;
      if (userMessages > seenUserMessages) {
        chain = undefined;
        pending = undefined;
      }
      seenUserMessages = userMessages;

      if (pending === undefined) return {};
      const content = pending;
      pending = undefined;

      const ui = deps.getUIChannel();
      if (!ui) {
        // No channel: transient wire-only injection (still a new array).
        return { messages: [...messages, { role: "user", content }] };
      }

      // Per-kind admission episode (same rule as turn-context): count the existing
      // `ctx-<kind>-` ids so a repeat loop that recurs later in the session gets a
      // fresh id. Without it the content-hash id collides with the earlier reminder
      // (the gentle body is constant, the detailed one is stable per tool/args) and
      // `injectSyntheticMessages` dedupes it away — so the second loop got no nudge.
      let kindCount = 0;
      const prefix = `ctx-${REPEAT_REMINDER_KIND}-`;
      for (const message of ui.getMessages()) {
        if (typeof message.id === "string" && message.id.startsWith(prefix)) kindCount++;
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
