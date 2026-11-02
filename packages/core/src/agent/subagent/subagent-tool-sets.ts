/**
 * Tool-set policy for exploration subagents: which tools are withheld, and which the default set
 * contains.
 *
 * Lives under `agent/subagent/` because it is subagent policy, not tool-runtime policy. It used to
 * sit at `agent/tools/runtime/tool-sets.ts`, which made the generic tool runtime import the
 * subagent tool set (a same-layer reverse edge the layer guard cannot see — it only checks
 * cross-layer edges), and a `getReadOnlyTanStackToolNames()` alias hid the `subagent` word from
 * that import line.
 */

import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";

import { SUBAGENT_READ_ONLY_TOOL_NAMES } from "./subagent-tools.js";

/** Tools withheld from exploration subagents (the read-only set is `SUBAGENT_READ_ONLY_TOOL_NAMES`). */
export const SUBAGENT_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set([
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
]);

// Re-exported for the dev surface, which published the read-only set under a second name.
export { SUBAGENT_READ_ONLY_TOOL_NAMES };
