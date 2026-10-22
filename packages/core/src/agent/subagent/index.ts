// Types and constants
export {
  SUBAGENT_DEFAULT_MAX_ITERATIONS,
  SUBAGENT_DEFAULT_MAX_OUTPUT_LENGTH,
  SUBAGENT_NO_TRUNCATE,
  type SubagentConfig,
  type SubagentProfile,
  type SubagentResult,
  type SubagentRunDeps,
} from "./types.js";

// System prompt
export { buildExploreSystemPrompt, SUBAGENT_EXPLORE_SYSTEM_PROMPT } from "./explore-prompt.js";

export { BEGIN_SUMMARY_TOOL_NAME, createBeginSummaryTool } from "./begin-summary-tool.js";

export { createTaskTool, taskOutputSchema, type TaskOutput, type TaskToolConfig } from "./task-tool.js";

// Tool creation
export { createSubagentTools } from "./subagent-tools.js";

// Output utilities
export { truncateSummary } from "./subagent-output.js";

// Runner
export { runSubagent, getSubagent, destroySubagent } from "./run-subagent.js";

export { countSubagentIterations, deriveSubagentRunStats, hasBeginSummaryCall } from "./run-stats.js";
