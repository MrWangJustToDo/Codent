import { TURN_CONTEXT_KINDS } from "../agent/turn-context/turn-context-message.js";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../models/cache/prompt-cache.js";

import type { AgentConfig } from "./agent-types.js";
import type { ExtensionTurnContextSection } from "../agent/extension/types.js";
import type { TurnContextSection } from "../agent/turn-context/turn-context-message.js";

export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../models/cache/prompt-cache.js";

export interface SystemPromptInput {
  config: AgentConfig;
  agentDocContent: string;
}

export function buildFrozenSystemPrompt(input: SystemPromptInput): string | undefined {
  const parts: string[] = [];

  if (input.config.systemPrompt) {
    parts.push(input.config.systemPrompt);
  }

  if (input.agentDocContent) {
    parts.push(
      [
        "<project_instructions>",
        "Below are the project-specific instructions loaded from the repository.",
        "Follow these conventions, rules, and guidelines when working in this codebase.",
        "",
        input.agentDocContent,
        "</project_instructions>",
      ].join("\n")
    );
  }

  // NOTE: the memory index (<memory_index>) is no longer frozen here — it is
  // injected per-turn by the built-in Memory extension via `registerContextProvider`
  // so freshly extracted memories surface without waiting for compaction.

  const joined = parts.length > 0 ? parts.join("\n\n") : undefined;
  if (joined) {
    return joined + SYSTEM_PROMPT_DYNAMIC_BOUNDARY;
  }
  return undefined;
}

export interface DynamicTurnContextInput {
  relevantMemoryContent: string;
  todoNagReminder?: string;
  currentDate?: string;
  gitBranch?: string;
  gitStatus?: string;
  /** Mode section content — plan/auto instructions, or an explicit inactive
   *  declaration so mode exits are communicated and re-entries re-inject. */
  modeContent?: string;
  /** Extension-contributed situational context. Each entry is emitted as its
   *  own `<ctx kind=<extension id>>` section (enable/disable share the same tag). */
  extensionTurnContextSections?: ExtensionTurnContextSection[];
  /** Instruction-context re-injection (nested under `<instruction_context>`). */
  instructionContext?: string;
  /**
   * Current session id, so the model can address its own history with
   * `session_search` / `session_read`. Changes on resume/clear → re-admitted.
   */
  sessionId?: string;
  /** Session-retrieval guidance — where past conversations live and how to read
   *  each shape. Absent when the workspace has no history to search. */
  sessionRetrieval?: string;
}

/**
 * Build the dynamic turn-context as an ordered list of independent sections.
 *
 * Each section carries its own semantic tag (e.g. `<current_date>`, `<git_status>`)
 * and is injected as its own `<ctx kind=...>` synthetic user message. Plan/auto mode
 * are merged into a single mutually-exclusive `mode` category (plan wins).
 */
export function buildTurnContextSections(input: DynamicTurnContextInput): TurnContextSection[] {
  const sections: TurnContextSection[] = [];

  if (input.currentDate) {
    sections.push({
      key: TURN_CONTEXT_KINDS.currentDate,
      content: ["<current_date>", input.currentDate, "</current_date>"].join("\n"),
    });
  }

  if (input.gitBranch || input.gitStatus) {
    const gitParts: string[] = [];
    if (input.gitBranch) {
      gitParts.push(`Branch: ${input.gitBranch}`);
    }
    if (input.gitStatus) {
      gitParts.push(`Status:\n${input.gitStatus}`);
    }
    sections.push({
      key: TURN_CONTEXT_KINDS.gitStatus,
      content: ["<git_status>", ...gitParts, "</git_status>"].join("\n"),
    });
  }

  if (input.relevantMemoryContent)
    sections.push({ key: TURN_CONTEXT_KINDS.relevantMemories, content: input.relevantMemoryContent.trim() });
  if (input.todoNagReminder) sections.push({ key: TURN_CONTEXT_KINDS.reminder, content: input.todoNagReminder.trim() });

  if (input.modeContent) sections.push({ key: TURN_CONTEXT_KINDS.mode, content: input.modeContent.trim() });

  if (input.instructionContext?.trim()) {
    sections.push({ key: TURN_CONTEXT_KINDS.instructionContext, content: input.instructionContext.trim() });
  }

  if (input.sessionId) {
    sections.push({
      key: TURN_CONTEXT_KINDS.sessionId,
      content: ["<session_id>", input.sessionId, "</session_id>"].join("\n"),
    });
  }

  if (input.sessionRetrieval?.trim()) {
    sections.push({ key: TURN_CONTEXT_KINDS.sessionRetrieval, content: input.sessionRetrieval.trim() });
  }

  if (input.extensionTurnContextSections) {
    for (const ext of input.extensionTurnContextSections) {
      const content = ext.content.trim();
      if (!content) continue;
      sections.push({ key: ext.id, content });
    }
  }

  return sections;
}

/**
 * `<project_instructions>` section (agent-doc content) — only injected for
 * subagents, whose frozen system prompt does not carry the agent doc.
 */
export function buildProjectInstructionsSection(content: string): TurnContextSection {
  return {
    key: TURN_CONTEXT_KINDS.projectInstructions,
    content: [
      "<project_instructions>",
      "Below are the project-specific instructions loaded from the repository.",
      "Follow these conventions, rules, and guidelines when working in this codebase.",
      "",
      content,
      "</project_instructions>",
    ].join("\n"),
  };
}

/**
 * Frozen system prompt only (dynamic context is injected as synthetic user messages
 * by the turn-context middleware).
 */
export function buildSystemPromptWithTurnContext(frozen: string | undefined): string[] | undefined {
  return frozen ? [frozen] : undefined;
}
