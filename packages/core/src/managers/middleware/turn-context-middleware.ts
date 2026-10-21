import { injectSyntheticMessages } from "../../agent/turn-context/synthetic-injection.js";
import {
  TURN_CONTEXT_KINDS,
  findLatestTurnContextSectionHashesFromWire,
  formatContextSectionUserContent,
  hashTurnContextSection,
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

/**
 * Kinds that do NOT need the periodic same-content refresh.
 *
 * The refresh exists to keep dynamic context near the tail as the conversation grows. The background
 * job pointer is different: it is re-admitted by compaction (the generation changes) and its old row
 * remains in the wire until then, so re-injecting an unchanged list every ~100 messages only
 * duplicates it. `aboveThreshold` still refreshes every other kind.
 */
const REFRESH_EXEMPT_KINDS: ReadonlySet<string> = new Set<string>([TURN_CONTEXT_KINDS.backgroundJobs]);

/** Re-admit all sections when the conversation grows this much since last admit. */
export const DEFAULT_REFRESH_MESSAGE_THRESHOLD = 100;

export interface TurnContextMiddlewareDeps {
  /** Frozen system prompt (ends with SYSTEM_PROMPT_DYNAMIC_BOUNDARY when present). */
  getFrozenSystemPrompt: () => string | undefined;
  /** Current dynamic sections for this agent (computed per call, hash-deduped below). */
  getSections: () => Promise<TurnContextSection[]>;
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
  // Per-kind admission state (lives on ManagedAgent so compaction resets apply).
  getAdmittedHashes: () => Map<string, string> | undefined;
  setAdmittedHashes: (hashes: Map<string, string> | undefined) => void;
  getAdmitMessageCount: () => number;
  setAdmitMessageCount: (count: number) => void;
  refreshMessageThreshold?: number;
}

/**
 * Injects dynamic context as synthetic `<ctx kind=...>` user messages, AFTER the
 * compaction middleware has produced the real wire payload — so admission is
 * judged against what the model actually receives.
 *
 * - Subagents: kinds are filtered to {@link SUBAGENT_ALLOWED_KINDS} and the
 *   parent's `<project_instructions>` is added (their frozen prompt lacks it).
 * - Main agents: full section set; each kind is hash-compared and only changed
 *   kinds are injected (prompt-cache friendly). Hashes are seeded from persisted
 *   messages on first call (restore support).
 */
export function createTurnContextMiddleware(deps: TurnContextMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  return defineMiddleware("context-transform", {
    name: "turn-context",
    onConfig: async (_ctx, config) => {
      const systemPrompts = buildSystemPromptWithTurnContext(deps.getFrozenSystemPrompt());
      const result: Partial<typeof config> = systemPrompts ? { systemPrompts } : {};

      const managed = deps.getManagedAgent();
      const isSubagent = Boolean(managed?.parentId);

      const sections = [...(await deps.getSections())];
      if (!isSubagent && deps.getBackgroundJobsSection) {
        const backgroundJobs = await deps.getBackgroundJobsSection(config.messages as ModelMessage[]);
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

      // Seed per-kind hashes from persisted messages on first admit (restore).
      let hashes = deps.getAdmittedHashes();
      if (!hashes) {
        hashes = findLatestTurnContextSectionHashesFromWire(config.messages as ModelMessage[]);
        deps.setAdmittedHashes(hashes);
      }

      const threshold = deps.refreshMessageThreshold ?? DEFAULT_REFRESH_MESSAGE_THRESHOLD;
      const aboveThreshold = uiMessages.length - deps.getAdmitMessageCount() >= threshold;

      const changed: { section: TurnContextSection; isUpdate: boolean }[] = [];
      for (const section of admitted) {
        const hash = hashTurnContextSection(section);
        const prior = hashes.get(section.key);
        if (prior === hash && (!aboveThreshold || REFRESH_EXEMPT_KINDS.has(section.key))) continue;
        changed.push({ section, isUpdate: prior !== undefined });
        hashes.set(section.key, hash);
      }
      if (changed.length === 0) return result;

      // Per-kind admission episode: count existing channel ids for the kind so
      // each admission gets a unique id even when content repeats (state cycles).
      const kindCounts = new Map<string, number>();
      for (const message of uiMessages) {
        const match = /^ctx-([^-]+)-/.exec(message.id);
        if (match) kindCounts.set(match[1], (kindCounts.get(match[1]) ?? 0) + 1);
      }

      const entries = changed.map(({ section, isUpdate }) => ({
        kind: section.key,
        content: formatContextSectionUserContent(section, { isUpdate }),
        nonce: (kindCounts.get(section.key) ?? 0) + 1,
      }));
      const { messages: wireMessages } = injectSyntheticMessages(
        config.messages as ModelMessage[],
        entries,
        {
          ui,
          persist: deps.persistMessages,
        }
        // Synthetic ctx always APPENDS (see injectSyntheticMessages): keeps injected
        // ctx in time order and never rewrites already-streamed content. Inserting
        // after the last real user message would put new ctx ahead of previously
        // injected ctx on mid-loop re-admission (mode changes), inverting per-turn
        // order AND invalidating the prompt-cache prefix for every message after the
        // user turn. At the start of a fresh user turn append is equivalent (the user
        // message is the last entry), so only the mid-loop case differs — where
        // append is the cache-safe choice.
      );
      // Refresh the admit baseline so the periodic refresh fires again ~threshold
      // messages later instead of staying permanently above threshold.
      deps.setAdmitMessageCount(ui.getMessages().length);

      return { ...result, messages: wireMessages };
    },
  });
}
