import type { PlanModePhase } from "./plan-mode-controller.js";

/** Turn-context block stating that neither plan nor auto mode is active. */
export function buildModeInactivePrompt(): string {
  return [
    "<mode_state>",
    "Neither plan mode nor auto mode is active — the standard tool approval flow applies.",
    "</mode_state>",
  ].join("\n");
}

/** Dynamic turn-context block while exploring (read-only). */
export function buildPlanModePlanningPrompt(): string {
  return [
    '<plan_mode phase="planning">',
    "You are in **plan mode** — exploring (read-only). Same idea as Cursor Plan: research first, then produce a reviewable plan.",
    "",
    "Goals:",
    "- Understand the codebase and requirements before proposing changes.",
    "- Do not edit files, run mutating commands, or claim you mutated the workspace.",
    "",
    "Exploration:",
    "- Prefer the `task` tool for read-only research (prefer focused prompts; avoid burning the full iteration budget).",
    "- You may also use read tools (`read_file`, `grep`, `glob`, `list_file`, `tree`) and `run_command` for read-only commands (e.g. git status/log/diff, ls, cat) — read-only commands run automatically, while write or external-path commands will ask the user for approval.",
    "- After each `task`, read `[task status: …]` (`reachedLimit`, `incomplete`, `aborted`). Only treat findings as trustworthy/extendable when the run completed cleanly; otherwise re-run narrower research before `create_plan`.",
    "- A summary ending with `Full output saved to: <path>` is a head+tail PREVIEW — read that file before relying on details that would live in the middle.",
    "- If requirements are ambiguous, call `ask_user` with a short clarifying question (prefer numbered options) before finalizing the plan.",
    "- Skipping answers is fine if the user continues without answering — do not block forever.",
    "",
    "When ready, call the `create_plan` tool with:",
    "- goal, ordered steps, **key_files (required, aim for 3-5)**, risks, **verification** (required), optional mermaid.",
    "- **key_files** MUST be a non-empty list of the key files the plan will touch or rely on (aim for 3-5) so execution starts from concrete file anchors.",
    "- **verification** MUST be a concrete checklist that proves the plan outcome (observable behavior, acceptance checks, or focused project scripts).",
    "The plan is auto-saved under `.agents/plans/`. The user reviews it in the ready banner (markdown preview) — do not dump a long plan overview in chat.",
    "You may also output a `## Plan` markdown section as a fallback; prefer `create_plan`.",
    "Use `update_plan` to revise after feedback (verification still required).",
    "</plan_mode>",
  ].join("\n");
}

/** Dynamic turn-context block while executing an approved plan. */
export function buildPlanModeExecutingPrompt(planMarkdown: string | null, planFilePath?: string | null): string {
  const parts = [
    '<plan_mode phase="executing">',
    "You are **building** the approved plan (Cursor Build). Execute step-by-step. Update the todo list as you progress.",
    "First read the plan's **Key files** — they are your file anchors; start there before editing.",
    "Do not expand scope without asking the user.",
    "Mark completed steps via the `todo` tool (preferred) or `[DONE:n]` markers (1-based).",
    "The plan's **Verification** items are seeded as a single `[verify]` todo — run each check and mark it completed only when all pass, keeping evidence.",
    "Before treating the build as done, run the plan **Verification** checklist and keep evidence (commands, scripts, or observed behavior).",
    "When all plan todos (steps and the `[verify]` todo) are done, you will enter a forced retrospective — do not skip ahead to unrelated work.",
  ];
  if (planFilePath?.trim()) {
    parts.push(`Plan file: \`${planFilePath.trim()}\``);
  }
  if (planMarkdown?.trim()) {
    parts.push("", "Approved plan:", planMarkdown.trim());
  }
  parts.push("</plan_mode>");
  return parts.join("\n");
}

/** Short user steer when `/mode execute` starts a run. */
export function buildPlanExecuteSteerMessage(planMarkdown: string | null, planFilePath?: string | null): string {
  const header = [
    "Build the approved plan step-by-step (you are now in building phase). Start by reading the plan's Key files. Update todos as you go — Verification is seeded as a single `[verify]` todo; run all its checks and mark it when they pass. Do not expand scope without asking. In retro, report Verification pass/fail with evidence before finishing.",
  ];
  if (planFilePath?.trim()) {
    header.push(`Plan file: \`${planFilePath.trim()}\``);
  }
  if (planMarkdown?.trim()) {
    return [...header, "", planMarkdown.trim()].join("\n");
  }
  return header.join("\n");
}

/** Optional prompt fragment for `ready` (still read-only until execute). */
export function buildPlanModeReadyPrompt(planMarkdown: string | null, planFilePath?: string | null): string {
  const parts = [
    '<plan_mode phase="ready">',
    "A plan is ready for **review** (still read-only). Stay read-only until the user runs `/mode execute` (Build).",
    "Revise with `update_plan` (preferred) or a new `## Plan` section if the user asks — updates overwrite the plan file.",
    "Prefer `task` for any further read-only research before revising.",
    "Do not replace the plan with a vague chat overview — the plan file and ready-banner preview are the source of truth.",
  ];
  if (planFilePath?.trim()) {
    parts.push(`Plan file: \`${planFilePath.trim()}\``);
  }
  if (planMarkdown?.trim()) {
    parts.push("", "Current plan:", planMarkdown.trim());
  }
  parts.push("</plan_mode>");
  return parts.join("\n");
}

/** Forced retrospective after all plan todos complete. */
export function buildPlanModeRetroPrompt(planMarkdown: string | null, planFilePath?: string | null): string {
  const parts = [
    '<plan_mode phase="retro">',
    "All plan todos are complete. You are in a **forced retrospective** — do not start new feature work.",
    "Review outcomes against the approved plan: what was done, any deviations, and **Verification**.",
    "For each Verification checklist item, record pass/fail with concrete evidence (command, validate script, or observed behavior).",
    "",
    "Verification passing is not the same as the work being right. It proves the checks you wrote; it cannot see what you did not think to check. Where the change is non-trivial, audit the *result* before you call it done:",
    "- Spawn `task` subagents, one per angle, sized to the change: one or two is usually enough, more only when it spans genuinely independent areas. For a small, obvious change, skip the audit and say so.",
    "- Different angles find different things — whether the change is actually correct (edge cases, error paths, the assumptions it leans on), whether it is sound *as code* (duplication, dead paths, what it left behind), and whether it departs from how this codebase already does things. Ask for findings, not agreement: an audit that comes back clean is worth less than one that comes back with three specific doubts.",
    "- Findings do not become a second report. Either fix what the audit turned up before completing, or fold a follow-up into the plan and name it here. An audit that changes nothing is a fine outcome — say that, do not pad it.",
    "- **Ask before you spawn.** Present the intended audit (how many subagents, what each covers) via `ask_user`, with a skip option, and wait for the answer. If the user skips, complete as usual and do not ask again. If the user does not answer, use your judgement — do not block. Do not spawn audit subagents you did not ask about.",
    "Call `complete_plan` with `verificationResults` covering every checklist item (all passed). Do not call it if any item failed — fix or update the plan first.",
    "The user may force-exit with `/mode done` without the agent gate.",
  ];
  if (planFilePath?.trim()) {
    parts.push(`Plan file: \`${planFilePath.trim()}\` — prefer reading it if you need the full text.`);
  }
  if (planMarkdown?.trim()) {
    parts.push("", "Approved plan:", planMarkdown.trim());
  }
  parts.push("</plan_mode>");
  return parts.join("\n");
}

export function buildPlanModePrompt(
  phase: PlanModePhase,
  planMarkdown: string | null,
  planFilePath?: string | null
): string | undefined {
  switch (phase) {
    case "planning":
      return buildPlanModePlanningPrompt();
    case "ready":
      return buildPlanModeReadyPrompt(planMarkdown, planFilePath);
    case "executing":
      return buildPlanModeExecutingPrompt(planMarkdown, planFilePath);
    case "retro":
      return buildPlanModeRetroPrompt(planMarkdown, planFilePath);
    default:
      return undefined;
  }
}
