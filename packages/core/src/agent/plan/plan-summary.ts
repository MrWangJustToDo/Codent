/**
 * Bounded static plan summary for transcript / model output (no scroll panel).
 */

import { truncateText } from "../../utils/text-truncation.js";

import type { PlanStep } from "./extract-plan.js";

const DEFAULT_MAX_STEPS = 12;
const MAX_STEP_CHARS = 120;

export interface FormatPlanSummaryInput {
  /** Relative path under workspace, e.g. `.agents/plans/foo.md`. */
  path?: string | null;
  goal: string;
  steps: PlanStep[];
  /** Max numbered steps to list before "+N more". */
  maxSteps?: number;
}

/** Pull `**Goal:** …` from structured plan markdown when available. */
export function extractGoalFromPlanMarkdown(markdown: string): string {
  const match = markdown.match(/\*\*Goal:\*\*\s*(.+)/i);
  if (match?.[1]?.trim()) return match[1].trim();
  const firstStep = markdown.match(/^\s*1\.\s+(.+)$/m);
  return firstStep?.[1]?.trim() || "Plan";
}

function truncateStep(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return truncateText(oneLine, MAX_STEP_CHARS);
}

/**
 * Format a static, non-scrolling plan summary for UI + model.
 */
export function formatPlanSummary(input: FormatPlanSummaryInput): string {
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  const goal = input.goal.trim() || "Plan";
  const lines: string[] = [];

  if (input.path?.trim()) {
    lines.push(`Plan file: \`${input.path.trim()}\``);
  }
  lines.push(`Goal: ${goal}`, "", "Steps:");

  const steps = input.steps;
  const shown = steps.slice(0, maxSteps);
  for (const step of shown) {
    lines.push(`${step.step}. ${truncateStep(step.text)}`);
  }
  const remaining = steps.length - shown.length;
  if (remaining > 0) {
    lines.push(`… +${remaining} more (see plan file)`);
  }

  return lines.join("\n");
}
