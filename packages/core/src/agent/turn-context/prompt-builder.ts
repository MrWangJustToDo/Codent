import { TURN_CONTEXT_KINDS, formatSectionTag } from "./turn-context-message.js";

import type { TurnContextSection } from "./turn-context-message.js";
import type { ExtensionTurnContextSection } from "../extension/types.js";

export interface DynamicTurnContextInput {
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
   * `session_search` / `session_read`. Changes on resume/new → re-admitted.
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
      content: formatSectionTag(TURN_CONTEXT_KINDS.currentDate, input.currentDate),
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
      content: formatSectionTag(TURN_CONTEXT_KINDS.gitStatus, gitParts),
    });
  }

  if (input.modeContent) sections.push({ key: TURN_CONTEXT_KINDS.mode, content: input.modeContent.trim() });

  if (input.instructionContext?.trim()) {
    sections.push({ key: TURN_CONTEXT_KINDS.instructionContext, content: input.instructionContext.trim() });
  }

  if (input.sessionId) {
    sections.push({
      key: TURN_CONTEXT_KINDS.sessionId,
      content: formatSectionTag(TURN_CONTEXT_KINDS.sessionId, input.sessionId),
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
    content: formatSectionTag(TURN_CONTEXT_KINDS.projectInstructions, [
      "Below are the project-specific instructions loaded from the repository.",
      "Follow these conventions, rules, and guidelines when working in this codebase.",
      "",
      content,
    ]),
  };
}
