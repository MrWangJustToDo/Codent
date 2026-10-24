import { injectSyntheticMessages } from "../../agent/turn-context/synthetic-injection.js";
import {
  TURN_CONTEXT_KINDS,
  contextSectionIdentity,
  findLatestContextSectionsFromWire,
  formatContextSectionUserContent,
  hashTurnContextSection,
  isContextUIMessage,
  syntheticKindFromId,
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
  getSections: (messages: readonly ModelMessage[]) => Promise<TurnContextSection[]>;
  /**
   * Build the `<background_jobs>` section for the model-visible wire (after compaction). Only jobs
   * whose `run_command` tool call is still in `messages` belong there.
   */
  getBackgroundJobsSection?: (messages: readonly ModelMessage[]) => Promise<TurnContextSection | undefined>;
  getUIChannel: () => AgentUIChannel | undefined;
  /** Persist the updated UI messages (no-op for subagents without a session store). */
  persistMessages: (next: UIMessage[]) => void;
  getManagedAgent: () => { parentId?: string } | undefined;
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

      const sections = [...(await deps.getSections(wire))];
      if (!isSubagent && deps.getBackgroundJobsSection) {
        const backgroundJobs = await deps.getBackgroundJobsSection(wire);
        if (backgroundJobs) sections.push(backgroundJobs);
      }
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

      // Identity, not kind: the two condition+counter reminders share `reminder` and are told
      // apart by their inner tag, so each is compared (and superseded) only against its own
      // earlier block.
      const injected = findLatestContextSectionsFromWire(
        wire,
        new Set(admitted.map((section) => contextSectionIdentity(section)))
      );

      const changed: { section: TurnContextSection; isUpdate: boolean }[] = [];
      for (const section of admitted) {
        const prior = injected.get(contextSectionIdentity(section));
        if (prior && hashTurnContextSection(prior) === hashTurnContextSection(section)) continue;
        changed.push({ section, isUpdate: prior !== undefined });
      }
      if (changed.length === 0) return result;

      // Per-kind admission episode: count existing channel ids for the kind so
      // each admission gets a unique id even when content repeats (state cycles).
      const kindCounts = new Map<string, number>();
      for (const message of uiMessages) {
        const kind = syntheticKindFromId(message.id);
        if (kind) kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
      }

      const entries = changed.map(({ section, isUpdate }) => ({
        kind: section.key,
        content: formatContextSectionUserContent(section, { isUpdate }),
        nonce: (kindCounts.get(section.key) ?? 0) + 1,
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
