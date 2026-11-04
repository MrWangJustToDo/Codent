/**
 * The todo slice a compaction prompt needs — one definition for the auto and manual paths.
 * (Reactive compaction does not pass todos to its summarizer yet; adding it there is a separate
 * decision, not a second mapping.)
 *
 * Both producers mapped `getIncompleteTodos()` into `CompactionTodoItem` by hand, including the
 * status/priority casts. They were identical only by coincidence; a change to the todo shape (or
 * to what "incomplete" means) has to reach the prompt through this one function.
 */

import type { CompactionTodoItem } from "./compaction-prompt.js";
import type { TodoManager } from "../todo";

/** Map the live incomplete todos onto the compaction prompt's shape (empty when none/unavailable). */
export function collectIncompleteTodos(todos: TodoManager | null | undefined): CompactionTodoItem[] {
  return (
    todos?.getIncompleteTodos().map((item) => ({
      content: item.content,
      status: item.status,
      priority: item.priority,
    })) ?? []
  );
}
