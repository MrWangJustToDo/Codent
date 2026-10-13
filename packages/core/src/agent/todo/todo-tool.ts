import { defineServerTool, isProjectedModelContent } from "../tools/runtime/define-tool.js";
import { withDuration } from "../tools/util/tool-result.js";
import { todoOutputSchema } from "../tools/util/types.js";

import { todoToolInputSchema } from "./types.js";

import type { TodoManager } from "./todo-manager.js";
import type { TodoOutput } from "../tools/util/types.js";

/**
 * The `todo` tool manages ONE list, whose plan ownership is not its business.
 *
 * There is deliberately no title argument anywhere in this file: the title is text the model
 * writes, so it cannot be an input to plan ownership. The binding is minted by the plan seed
 * path (`PlanModeController.seedTodosFromSteps` → `TodoManager.setPlanBound`) and released by
 * `PlanModeController.clearPlanTodos`; `TodoManager.update` only replaces items + title. A
 * tool that re-asserted the binding from its own title would be a second, weaker authority for
 * a decision that already has one — and the weaker one is what made an agent list named "Plan"
 * render as plan steps for the rest of the session.
 */
export const createTodoTool = ({ todoManager }: { todoManager: TodoManager }) => {
  return defineServerTool({
    name: "todo",
    present: {
      category: "other",
      keepRow: true,
      detailed: true,
    },
    description: `Create and manage a task list to track progress on multi-step work. Use this tool to:
 - Plan complex tasks by breaking them into steps
 - Track what you're currently working on (mark as in_progress)
 - Mark tasks as completed when done
 - Keep the user informed of your progress

IMPORTANT RULES:
 - Always include a short title for the current todo set: it labels the list for the user
 - Only ONE task can be in_progress at a time
 - Update todos frequently - mark tasks complete immediately when done
 - Each call REPLACES all todos, so include the full updated list
 - Maximum 20 todos allowed`,
    inputSchema: todoToolInputSchema,
    outputSchema: todoOutputSchema,
    execute: async ({ todos, title }) => {
      return withDuration(async () => {
        todoManager.update(todos, title);
        const stats = todoManager.getStats();
        const items = todoManager.getItems();
        const source = todoManager.getSource();

        return {
          title,
          source,
          items,
          stats,
        };
      });
    },
    // Send title + source + items so the model can see the current list and its ownership.
    toModelOutput({ output }: { toolCallId: string; input: unknown; output: TodoOutput }) {
      if (isProjectedModelContent(output)) return output;
      const lines = output.items?.map?.((item) => {
        const icon = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]";
        return `${icon} ${item.content}`;
      });
      const sourceTag = output.source === "plan" ? " [source=plan]" : "";
      return [{ type: "text" as const, content: `${output.title}${sourceTag}\n${lines?.join("\n")}` }];
    },
  });
};
