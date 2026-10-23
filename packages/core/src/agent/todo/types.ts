import { z } from "zod";

// ============================================================================
// Todo Status
// ============================================================================

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

// ============================================================================
// Todo Priority
// ============================================================================

export const TODO_PRIORITIES = ["high", "medium", "low"] as const;

export type TodoPriority = (typeof TODO_PRIORITIES)[number];

// ============================================================================
// Todo Item
// ============================================================================

export interface TodoItem {
  /** Unique identifier for the todo */
  id: string;
  /** Description of the task */
  content: string;
  /** Current status */
  status: TodoStatus;
  /** Priority level */
  priority: TodoPriority;
  /** Timestamp when created */
  createdAt: number;
  /** Timestamp when last updated */
  updatedAt: number;
}

// ============================================================================
// Zod Schemas for Tool Input
// ============================================================================

export const todoItemInputSchema = z.object({
  /** Description of the task */
  content: z.string().min(1, { message: "content: must not be empty" }).describe("Brief description of the task"),
  /** Current status of the task */
  status: z
    .enum(TODO_STATUSES)
    .describe("Current status: pending (not started), in_progress (working on), completed (done)"),
  /** Priority level of the task */
  priority: z.enum(TODO_PRIORITIES).describe("Priority level: high, medium, low"),
});

export type TodoItemInput = z.infer<typeof todoItemInputSchema>;

export const todoToolInputSchema = z.object({
  /** Title for this todo set */
  title: z.string().min(1, { message: "title: must not be empty" }).describe("Short title for this todo set"),
  /** Array of todo items to set (replaces all existing todos) */
  todos: z
    .array(todoItemInputSchema)
    .min(1, { message: "todos: must contain at least 1 item" })
    .max(20, { message: "todos: must contain at most 20 items" })
    .describe("The complete list of todos. This replaces all existing todos."),
});

export type TodoToolInput = z.infer<typeof todoToolInputSchema>;

// ============================================================================
// Todo Manager Config
// ============================================================================

export interface TodoManagerConfig {
  /** Maximum number of todos allowed (default: 20) */
  maxTodos?: number;
  /** Number of rounds without todo update before nag reminder (default: 3) */
  nagReminderThreshold?: number;
  /** Initial rounds between nag reminders once the threshold is crossed (default: 5) */
  nagCooldownRounds?: number;
  /**
   * Extra rounds added to the cooldown after each nag (default: the value of
   * `nagCooldownRounds`). This makes the reminder back off: e.g. with the defaults
   * the first gap is 5 rounds, the next is 10, then 15.
   */
  nagCooldownGrowth?: number;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MAX_TODOS = 20;
export const DEFAULT_NAG_REMINDER_THRESHOLD = 3;
export const DEFAULT_NAG_COOLDOWN_ROUNDS = 5;

// ============================================================================
// Status Icons for Rendering
// ============================================================================

export const STATUS_ICONS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[✓]",
};
