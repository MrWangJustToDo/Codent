import { z } from "zod";

import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";
import { defineServerTool, isProjectedModelContent } from "../tools/runtime/define-tool.js";
import { toolOutputBaseSchema } from "../tools/shared/schemas.js";
import { withDuration } from "../tools/shared/tool-result.js";

import { PLAN_STORE_DIR } from "./plan-store.js";
import { isUsableVerification, gateCompletePlanVerification } from "./plan-verification.js";

import type { PlanModeController } from "./plan-mode-controller.js";

const VERIFICATION_DESCRIBE =
  "Required checklist of how to prove the plan outcome succeeded after execution " +
  "(markdown list or newline items). Prefer observable behavior, acceptance checks, or focused project scripts.";

const structuredPlanInputSchema = z.object({
  goal: z.string().min(1).describe("One-sentence outcome of the plan"),
  steps: z
    .array(z.string().min(3))
    .min(1)
    .max(30)
    .describe(
      "Ordered implementation steps as plain text (do not prefix with 1. 2. — numbering is added automatically)"
    ),
  key_files: z.array(z.string()).min(1).describe("Required: file paths the plan will touch or rely on (at least one)"),
  risks: z.string().optional().describe("Brief risks or trade-offs"),
  verification: z.string().min(1).describe(VERIFICATION_DESCRIBE),
  mermaid: z.string().optional().describe("Optional mermaid diagram body (without fences)"),
});

const planToolOutputSchema = z.object({
  ok: z.boolean(),
  phase: z.string(),
  stepCount: z.number().int().nonnegative(),
  message: z.string(),
  planFilePath: z.string().nullable().optional(),
  error: z.string().optional(),
  durationMs: z.number().describe("Execution duration in milliseconds."),
  ...toolOutputBaseSchema.shape,
});

export type CreatePlanToolDeps = {
  getPlanMode: () => PlanModeController;
};

function createPlanAuthoringTool(name: "create_plan" | "update_plan", deps: CreatePlanToolDeps) {
  const isUpdate = name === BUILTIN_TOOL_NAMES.updatePlan;
  return defineServerTool({
    name,
    present: { category: "other" },
    description: isUpdate
      ? `Update the current plan while in plan mode (review/planning). Replaces the plan artifact and overwrites the plan file. Prefer this over rewriting ## Plan in chat. Requires a non-empty verification checklist.`
      : `Create a structured implementation plan while in plan mode. Auto-saves under ${PLAN_STORE_DIR}/ for user review in the ready banner. Prefer this over free-form ## Plan markdown when possible. Requires a non-empty verification checklist.`,
    inputSchema: structuredPlanInputSchema,
    outputSchema: planToolOutputSchema,
    execute: async (input) => {
      return withDuration(async () => {
        const planMode = deps.getPlanMode();

        if (!isUsableVerification(input.verification)) {
          return {
            ok: false,
            phase: planMode.getPhase(),
            stepCount: 0,
            message: "verification is required (non-empty checklist)",
            error: "verification is required (non-empty checklist)",
          };
        }

        const result = await planMode.applyStructuredPlan({
          goal: input.goal,
          steps: input.steps,
          keyFiles: input.key_files,
          risks: input.risks,
          verification: input.verification,
          mermaid: input.mermaid,
        });

        if (!result.ok) {
          return {
            ok: false,
            phase: planMode.getPhase(),
            stepCount: 0,
            message: result.error ?? "Failed to apply plan",
            error: result.error,
          };
        }

        const state = planMode.getState();
        return {
          ok: true,
          phase: state.phase,
          stepCount: result.stepCount ?? 0,
          planFilePath: state.planFilePath,
          message: isUpdate ? "Plan updated — ready for review." : "Plan saved — ready for review.",
        };
      });
    },
    toModelOutput({ output }) {
      if (isProjectedModelContent(output)) return output;
      if (!output.ok) {
        return [{ type: "text" as const, content: `Plan tool error: ${output.error ?? output.message}` }];
      }
      // Minimal: full plan is in <plan_mode> + disk; UI review uses ready-banner markdown preview.
      const hint = isUpdate ? "Plan updated — ready for review." : "Plan saved — ready for review.";
      const path = output.planFilePath ? ` (${output.planFilePath})` : "";
      return [{ type: "text" as const, content: `${hint}${path}` }];
    },
  });
}

export const createCreatePlanTool = (deps: CreatePlanToolDeps) => createPlanAuthoringTool("create_plan", deps);

export const createUpdatePlanTool = (deps: CreatePlanToolDeps) => createPlanAuthoringTool("update_plan", deps);

const verificationResultSchema = z.object({
  // `min(1)` alone accepts whitespace; a blank item normalizes to "" and `includes("")` is always
  // true, which used to satisfy the whole checklist (the retro gate). Require real text here so a
  // blank item is rejected at the schema boundary, not only by the gate.
  item: z
    .string()
    .min(1)
    .refine((value) => value.trim().length >= 3, {
      message: "item must be at least 3 non-space characters of checklist text",
    })
    .describe("Checklist item text (match the plan Verification line)"),
  passed: z.boolean().describe("Whether this item passed"),
  evidence: z.string().min(1).describe("Evidence: command name, validate script, file path, or observed behavior"),
});

const completePlanOutputSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  error: z.string().optional(),
  durationMs: z.number().describe("Execution duration in milliseconds."),
  ...toolOutputBaseSchema.shape,
});

/** End plan mode after forced retrospective. */
export const createCompletePlanTool = (deps: CreatePlanToolDeps) => {
  return defineServerTool({
    name: "complete_plan",
    present: {
      category: "other",
      keepRow: true,
      detailed: true,
    },
    description: `End the current plan lifecycle after the retrospective. Only use in retro phase when every Verification checklist item has a pass/fail result with evidence. Exits plan mode. (Users may still force-exit with /mode done.)`,
    inputSchema: z.object({
      note: z.string().optional().describe("Optional one-line note about the retrospective outcome"),
      verificationResults: z
        .array(verificationResultSchema)
        .min(1)
        .describe("Per-item results covering the plan Verification checklist"),
    }),
    outputSchema: completePlanOutputSchema,
    execute: async (input) => {
      return withDuration(async () => {
        const planMode = deps.getPlanMode();
        if (planMode.getPhase() !== "retro") {
          return {
            ok: false,
            message: `complete_plan only works in retro phase (current: ${planMode.getPhase()})`,
            error: `complete_plan only works in retro phase (current: ${planMode.getPhase()})`,
          };
        }

        const gate = gateCompletePlanVerification(planMode.getState().planMarkdown, input.verificationResults);
        if (!gate.ok) {
          return { ok: false, message: gate.error, error: gate.error };
        }

        const result = planMode.complete();
        if (!result.ok) {
          return { ok: false, message: result.error ?? "Failed to complete plan", error: result.error };
        }
        const note = input.note?.trim();
        return {
          ok: true,
          message: note ? `Plan complete — ${note}` : "Plan complete — plan mode off",
        };
      });
    },
    toModelOutput({ output }) {
      if (isProjectedModelContent(output)) return output;
      return [{ type: "text" as const, content: output.message }];
    },
  });
};
