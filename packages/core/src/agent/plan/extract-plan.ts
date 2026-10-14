/**
 * Extract structured plan markdown and numbered steps from assistant text.
 */

import { truncateText } from "../../utils/text-truncation.js";

export interface PlanStep {
  step: number;
  text: string;
}

export interface ExtractedPlan {
  /** Full plan section including heading and optional mermaid fences. */
  planMarkdown: string;
  steps: PlanStep[];
}

/** Strip markdown emphasis / code for compact todo labels. */
export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(
      /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  if (cleaned.length > 80) {
    cleaned = truncateText(cleaned, 80);
  }
  return cleaned;
}

/**
 * Locate `## Plan` / `Plan:` section and numbered steps (`1.` / `1)`).
 * Returns null when no heading or fewer than one usable step.
 *
 * Only numbered items under the **Steps:** sub-section are counted — other
 * numbered lists (Risks, Verification, etc.) are ignored.
 */
export function extractPlan(message: string): ExtractedPlan | null {
  const headerRe = /(?:^|\n)[ \t]*(#{1,3}[ \t]*Plan\b|\*{0,2}Plan:\*{0,2})[ \t]*\n/i;
  const headerMatch = headerRe.exec(message);
  if (!headerMatch || headerMatch.index == null) return null;

  const contentStart = headerMatch.index + headerMatch[0].length;
  const rest = message.slice(contentStart);
  const nextHeading = rest.search(/\n#{1,3}[ \t]+\S/);
  const body = (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).trimEnd();
  const headingLine = headerMatch[1].trim();
  const planMarkdown = `${headingLine.startsWith("#") ? headingLine : "## Plan"}\n${body}`.trim();

  // Locate the **Steps:** sub-section — only numbered items within it count as steps.
  const stepsSection = /\*\*Steps:?\*\*\s*\n([\s\S]*?)(?=\n\*\*|$)/i.exec(body);
  const stepsSource = stepsSection ? stepsSection[1] : body;

  const numberedPattern = /^\s*(\d+)[.)]\s+(.+)$/gm;
  const steps: PlanStep[] = [];

  for (const match of stepsSource.matchAll(numberedPattern)) {
    const raw = match[2]
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    if (raw.length < 3) continue;
    if (raw.startsWith("`") || raw.startsWith("/") || raw.startsWith("-")) continue;
    // Drop nested markers if the model already numbered the step text ("1. 1. Do X").
    const withoutNested = raw.replace(/^(?:\d+[.)]\s+)+/, "").trim() || raw;
    const cleaned = cleanStepText(withoutNested);
    if (cleaned.length < 3) continue;
    steps.push({ step: steps.length + 1, text: cleaned });
  }

  if (steps.length === 0) return null;
  return { planMarkdown, steps };
}

/** Parse `[DONE:n]` markers from assistant text (1-based step numbers). */
export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step) && step > 0) steps.push(step);
  }
  return steps;
}
