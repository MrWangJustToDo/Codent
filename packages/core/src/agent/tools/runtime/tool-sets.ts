import { SUBAGENT_READ_ONLY_TOOL_NAMES } from "../../subagent/subagent-tools.js";
import { BUILTIN_TOOL_NAMES } from "../catalog/tool-names.js";

/** Tools excluded from exploration subagents (read-only subset). */
const SUBAGENT_EXCLUDED: ReadonlyArray<string> = [
  BUILTIN_TOOL_NAMES.writeFile,
  BUILTIN_TOOL_NAMES.editFile,
  BUILTIN_TOOL_NAMES.deleteFile,
  BUILTIN_TOOL_NAMES.task,
  BUILTIN_TOOL_NAMES.todo,
  BUILTIN_TOOL_NAMES.askUser,
  BUILTIN_TOOL_NAMES.createPlan,
  BUILTIN_TOOL_NAMES.updatePlan,
  BUILTIN_TOOL_NAMES.completePlan,
  BUILTIN_TOOL_NAMES.listSkills,
  BUILTIN_TOOL_NAMES.loadSkill,
];

/** Tools excluded from exploration subagents (read-only subset). */
export const SUBAGENT_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set(SUBAGENT_EXCLUDED);

/** Names of workspace-reading tools included in the default exploration subagent set. */
export function getReadOnlyTanStackToolNames(): readonly string[] {
  return SUBAGENT_READ_ONLY_TOOL_NAMES;
}
