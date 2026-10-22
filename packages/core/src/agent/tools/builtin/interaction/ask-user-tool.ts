import { z } from "zod";

import { defineClientTool } from "../../runtime/define-tool.js";
import { toolOutputBaseSchema } from "../../shared/schemas.js";

// ============================================================================
// Schemas
// ============================================================================

export const askUserOutputSchema = z.object({
  question: z.string().describe("The question that was asked."),
  answer: z.string().describe("The user's response."),
  hasOptions: z.boolean().describe("Whether predefined options were provided."),
  // Structured multi-select info: present when the user picked multiple options.
  // Lets the model-facing result clearly represent a multi-choice answer instead
  // of an ambiguous comma-joined string (option text may itself contain commas).
  multiSelect: z.boolean().optional().describe("Whether the user selected multiple options (true) or a single one."),
  selected: z.array(z.string()).optional().describe("The selected option labels, one per entry (multi-select)."),
  draft: z.string().optional().describe("Free-form custom answer typed by the user, if any."),
  durationMs: z.number().describe("Execution duration in milliseconds."),
  /**
   * The question was never answered (declined, cancelled, or the client could not ask). Part of the
   * contract rather than a host extra: a host that emitted it outside the schema had it stripped by
   * any parse, so "cancelled" and "answered with an empty string" looked identical downstream.
   */
  cancelled: z.boolean().optional().describe("The question was declined or cancelled without an answer."),
  ...toolOutputBaseSchema.shape,
});

export type AskUserOutput = z.infer<typeof askUserOutputSchema>;

// ============================================================================
// Tool Factory
// ============================================================================

/** Client-side tool — UI supplies output via addToolResult. */
export const createAskUserTool = () => {
  return defineClientTool({
    name: "ask_user",
    present: {
      category: "other",
      keepRow: true,
      detailed: true,
      clientSide: true,
    },
    description: `Ask the user a question and wait for their response. Use this tool when you need clarification or input from the user to proceed.

When to use:
- Requirements are ambiguous and you need the user to choose a direction
- You need confirmation on a significant decision before proceeding
- Multiple valid approaches exist and user preference matters
- You need specific information (e.g. a file path, config value, preference)
- In plan mode: ask 2–4 clarifying questions (prefer options) before calling create_plan if needed
- Outside plan mode: for large or unclear multi-file work, ask whether to enter plan mode (user enables via /mode or Shift+Tab)

Do NOT use this tool for:
- Rhetorical questions or status updates (just say them in your response)
- Questions you could answer by reading the codebase
- Trivial confirmations that don't affect the outcome`,

    inputSchema: z.object({
      question: z.string().describe("The question to ask the user. Be specific and concise."),
      options: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of predefined options for the user to choose from. The user can still provide a free-form answer."
        ),
      multiSelect: z
        .boolean()
        .optional()
        .describe("If true, the user can select multiple options. Defaults to false (single select)."),
    }),

    outputSchema: askUserOutputSchema,
  });
};
