import { captureSessionStaleness } from "../../agent/turn-context/session-staleness.js";
import {
  injectSyntheticMessages,
  nextSyntheticNonces,
  selectChangedSections,
} from "../../agent/turn-context/synthetic-injection.js";
import {
  TURN_CONTEXT_KINDS,
  formatContextSectionUserContent,
  isContextUIMessage,
} from "../../agent/turn-context/turn-context-message.js";
import { buildSystemPromptWithTurnContext, buildProjectInstructionsSection } from "../managed-agent-prompt.js";

import { defineMiddleware } from "./phase.js";

import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { TurnContextSection } from "../../agent/turn-context/turn-context-message.js";
import type { AgentUIChannel } from "../../agent/ui/ui-channel.js";
import type { ChatMiddleware, ModelMessage, UIMessage } from "@tanstack/ai";

/**
 * Kinds a subagent may receive — everything else is filtered out so subagents
 * stay context-isolated (no memory / todo / plan / extension context).
 */
// `section.key` is a string: extension-contributed sections use the extension id
// as their kind, so it is not necessarily a built-in TurnContextKind.
export const SUBAGENT_ALLOWED_KINDS: ReadonlySet<string> = new Set<string>([
  TURN_CONTEXT_KINDS.currentDate,
  TURN_CONTEXT_KINDS.gitStatus,
  TURN_CONTEXT_KINDS.projectInstructions,
]);

export interface TurnContextMiddlewareDeps {
  /** Frozen system prompt (ends with SYSTEM_PROMPT_DYNAMIC_BOUNDARY when present). */
  getFrozenSystemPrompt: () => string | undefined;
  /** Current dynamic sections for this agent (computed per call, hash-deduped below). */
  getSections: () => Promise<TurnContextSection[]>;
  getUIChannel: () => AgentUIChannel | undefined;
  /** Persist the updated UI messages (no-op for subagents without a session store). */
  persistMessages: (next: UIMessage[]) => void;
  getManagedAgent: () => { parentId?: string; isSessionSwitching?: () => boolean } | undefined;
  /** Agent-doc content for subagents (their own agentDocContent is empty). */
  getProjectInstructions?: () => string | undefined;
}

/**
 * Injects dynamic context as synthetic `<ctx kind=...>` user messages, AFTER the
 * compaction middleware has produced the real wire payload — so admission is
 * judged against what the model actually receives.
 *
 * Admission is one rule, evaluated fresh on every call:
 * 1. read the latest admitted block per kind from the (post-compaction) wire,
 * 2. compare its hash with the block this turn would build, and inject only the
 *    kinds whose content differs (or that are absent entirely).
 *
 * Nothing is remembered across calls, so a compaction cut, a session restore, or a
 * session switch need no reset plumbing: a block that fell out of the window is
 * simply absent (and re-injected), and one that survived keeps suppressing itself.
 *
 * - Subagents: kinds are filtered to {@link SUBAGENT_ALLOWED_KINDS} and the
 *   parent's `<project_instructions>` is added (their frozen prompt lacks it).
 *
 * This middleware is deliberately **only** the hash-admitted family. Condition + counter
 * reminders (todo nag, repeat nudge) and the background pushes own their own middlewares: they
 * decide from a counter or a completion, not from a content hash, and mixing the two here is
 * what made the admission rules hard to follow.
 */
export function createTurnContextMiddleware(deps: TurnContextMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  return defineMiddleware("context-transform", {
    name: "turn-context",
    onConfig: async (_ctx, config) => {
      const systemPrompts = buildSystemPromptWithTurnContext(deps.getFrozenSystemPrompt());
      const result: Partial<typeof config> = systemPrompts ? { systemPrompts } : {};

      const managed = deps.getManagedAgent();
      const isSubagent = Boolean(managed?.parentId);
      // The wire the model is about to receive, after compaction. This is the only
      // admission input — never the durable channel, which keeps pre-cut rows.
      const wire = config.messages as ModelMessage[];

      // Everything computed for the session being unloaded is garbage once a switch starts: it is
      // DISCARDED, never written into the target. See `captureSessionStaleness` for why both the
      // switching flag and the session generation are needed.
      const isStaleSession = captureSessionStaleness(
        deps.getUIChannel(),
        () => managed?.isSessionSwitching?.() === true
      );

      const sections = [...(await deps.getSections())];
      if (isStaleSession()) return result;
      const admitted: TurnContextSection[] = isSubagent
        ? [...sections.filter((section) => SUBAGENT_ALLOWED_KINDS.has(section.key))]
        : [...sections];
      if (isSubagent) {
        const instructions = deps.getProjectInstructions?.();
        if (instructions) admitted.push(buildProjectInstructionsSection(instructions));
      }
      if (admitted.length === 0) return result;

      const ui = deps.getUIChannel();
      if (!ui) return result;
      const uiMessages = ui.getMessages();
      // Only admit once a real user message exists — otherwise the synthetic
      // message would land before the first user turn (malformed epoch order).
      if (!uiMessages.some((message) => message.role === "user" && !isContextUIMessage(message))) {
        return result;
      }

      // One admission rule (shared with the background middleware): a kind is due when the
      // wire has no block of it, or its newest block differs.
      const changed = selectChangedSections(wire, admitted);
      if (changed.length === 0) return result;

      // Per-kind admission episode: a unique id even when content repeats (state cycles), so
      // the id dedupe cannot swallow a legitimate re-injection.
      const nonces = nextSyntheticNonces(
        uiMessages,
        changed.map(({ section }) => section.key)
      );

      const entries = changed.map(({ section, isUpdate }) => ({
        kind: section.key,
        content: formatContextSectionUserContent(section, { isUpdate }),
        nonce: nonces.get(section.key)!,
      }));
      const { messages: wireMessages } = injectSyntheticMessages(wire, entries, {
        ui,
        persist: deps.persistMessages,
      });
      // Synthetic ctx always APPENDS (see injectSyntheticMessages): keeps injected
      // ctx in time order and never rewrites already-streamed content. Inserting
      // after the last real user message would put new ctx ahead of previously
      // injected ctx on mid-loop re-admission (mode changes), inverting per-turn
      // order AND invalidating the prompt-cache prefix for every message after the
      // user turn. At the start of a fresh user turn append is equivalent (the user
      // message is the last entry), so only the mid-loop case differs — where
      // append is the cache-safe choice.

      return { ...result, messages: wireMessages };
    },
  });
}
