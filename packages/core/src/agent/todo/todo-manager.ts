import { generateId, generateShortId } from "../../utils/generate-id.js";

import {
  DEFAULT_MAX_TODOS,
  DEFAULT_NAG_COOLDOWN_ROUNDS,
  DEFAULT_NAG_REMINDER_THRESHOLD,
  STATUS_ICONS,
  type TodoItem,
  type TodoItemInput,
  type TodoManagerConfig,
  type TodoStatus,
} from "./types.js";

import type { AgentEventBus } from "../agent-event-bus";

// ============================================================================
// TodoManager ID Generator
// ============================================================================

export const generateTodoManagerId = (): string => generateId("todo");

// ============================================================================
// TodoManager Class
// ============================================================================

/**
 * TodoManager manages a list of todo items for an agent session.
 *
 * Key features:
 * - Maximum 20 todos allowed (configurable)
 * - Only ONE task can be in_progress at a time (enforces sequential focus)
 * - Tracks rounds since last todo update for nag reminder
 * - Event subscription for UI updates
 *
 * @example
 * ```typescript
 * const todoManager = new TodoManager();
 *
 * // Update todos (from tool call)
 * todoManager.update(
 *   [
 *   { content: "Read the file", status: "completed", priority: "high" },
 *   { content: "Edit the function", status: "in_progress", priority: "high" },
 *   { content: "Run tests", status: "pending", priority: "medium" },
 *   ],
 *   "Refactor auth module"
 * );
 *
 * // Render for display
 * console.log(todoManager.render());
 * // [✓] Read the file
 * // [>] Edit the function
 * // [ ] Run tests
 * // (1/3 completed)
 *
 * // Check if nag reminder needed
 * if (todoManager.shouldNag()) {
 *   // Inject reminder into messages
 * }
 * ```
 */
export class TodoManager {
  readonly id: string;
  readonly symbol = Symbol.for("todo-manager");

  /** Todo items */
  private items: TodoItem[] = [];

  /** Current todo set title */
  private title: string | null = null;

  /** Configuration */
  private maxTodos: number;
  private nagReminderThreshold: number;
  private nagCooldownRounds: number;
  private nagCooldownGrowth: number;

  /** Rounds since last todo update */
  private roundsSinceUpdate = 0;

  /** `roundsSinceUpdate` value at the last nag; -Infinity when not yet nagged in
   *  the current cycle. Reset on update. */
  private lastNagRound = -Infinity;

  /** Nags in the current cycle, used to grow the next cooldown. Reset on update. */
  private nagCountInCycle = 0;

  /** Monotonic nag counter — makes every nag content unique so re-injection is
   *  never swallowed by content-hash / stable-id dedupe after a reset (rounds
   *  alone can replay a historical value byte-identically). */
  private nagEpisode = 0;

  /** Unified event bus for the owning agent (session `todos` projection). */
  private eventBus?: AgentEventBus;

  /** @internal Attach the agent's scoped unified event bus. */
  setEventBus(bus: AgentEventBus): void {
    this.eventBus = bus;
    bus.retain("session:todos", () => ({ items: this.getItems(), title: this.title }));
  }

  /** Auto-clear timer (when all todos completed) */
  private autoClearTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** When false, completed todos stay visible (plan execution keeps Footer progress). */
  private autoClearEnabled = true;

  /** True while this list is bound to an active plan lifecycle (seeded by plan mode). */
  private planBound = false;

  /** Timestamps */
  createdAt: number;
  updatedAt: number;

  constructor(config: TodoManagerConfig = {}) {
    this.id = generateTodoManagerId();
    this.maxTodos = config.maxTodos ?? DEFAULT_MAX_TODOS;
    this.nagReminderThreshold = config.nagReminderThreshold ?? DEFAULT_NAG_REMINDER_THRESHOLD;
    this.nagCooldownRounds = config.nagCooldownRounds ?? DEFAULT_NAG_COOLDOWN_ROUNDS;
    this.nagCooldownGrowth = config.nagCooldownGrowth ?? this.nagCooldownRounds;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  // ============================================================================
  // Core Operations
  // ============================================================================

  /**
   * Update the todo list (replaces all items).
   * This is the main method called by the todo tool.
   *
   * @param opts.allowMaxExceed When true, skip the `maxTodos` cap. Used only by
   *   plan-mode seeding where plan steps are authoritative content that must
   *   not be silently truncated; the todo tool keeps the cap.
   * @throws Error if validation fails (max todos, multiple in_progress)
   */
  update(inputs: TodoItemInput[], title: string, opts?: { allowMaxExceed?: boolean }): string {
    // Validate max todos (plan-mode seeding may exceed via allowMaxExceed)
    if (!opts?.allowMaxExceed && inputs.length > this.maxTodos) {
      throw new Error(`Maximum ${this.maxTodos} todos allowed, got ${inputs.length}`);
    }

    // Validate only one in_progress
    const inProgressCount = inputs.filter((item) => item.status === "in_progress").length;
    if (inProgressCount > 1) {
      throw new Error(`Only one task can be in_progress at a time, got ${inProgressCount}`);
    }

    // Validate no empty content
    for (let i = 0; i < inputs.length; i++) {
      if (!inputs[i].content.trim()) {
        throw new Error(`Todo item ${i + 1}: content cannot be empty`);
      }
    }

    const now = Date.now();
    this.title = title.trim();

    // Convert inputs to TodoItems
    this.items = inputs.map((input) => {
      // Try to find existing item with same content to preserve id
      const existing = this.items.find((item) => item.content === input.content);

      return {
        id: existing?.id ?? generateShortId(),
        content: input.content.trim(),
        status: input.status,
        priority: input.priority,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
    });

    // Reset rounds counter + nag throttle (fresh cycle after an update)
    this.roundsSinceUpdate = 0;
    this.lastNagRound = -Infinity;
    this.nagCountInCycle = 0;

    this.touch();
    this.notifyListeners();
    this.scheduleAutoClearIfNeeded();

    return this.render();
  }

  /**
   * Render the todo list as a formatted string.
   */
  render(): string {
    if (this.items.length === 0) {
      return "No todos.";
    }

    const lines: string[] = [];

    if (this.title) {
      lines.push(`Title: ${this.title}`);
      lines.push("");
    }

    for (const item of this.items) {
      const icon = STATUS_ICONS[item.status];
      const priorityTag = item.priority === "high" ? " [HIGH]" : item.priority === "low" ? " [low]" : "";
      lines.push(`${icon} ${item.content}${priorityTag}`);
    }

    const completed = this.items.filter((item) => item.status === "completed").length;
    lines.push("");
    lines.push(`(${completed}/${this.items.length} completed)`);

    return lines.join("\n");
  }

  // ============================================================================
  // Round Tracking & Nag Reminder
  // ============================================================================

  /**
   * Increment the round counter. Call this after each agent step.
   */
  incrementRound(): void {
    this.roundsSinceUpdate++;
  }

  /**
   * Check if a nag reminder should be injected.
   * Returns true if:
   * - There are todos
   * - Rounds since update >= threshold
   * - There are incomplete todos
   */
  shouldNag(): boolean {
    if (this.items.length === 0) return false;
    if (this.roundsSinceUpdate < this.nagReminderThreshold) return false;
    // Back off after every nag: the first cooldown is `nagCooldownRounds`, then it
    // grows by `nagCooldownGrowth` for each reminder in this stale cycle. This keeps
    // a long-running task from receiving the same nag every few rounds.
    const cooldown = this.nagCooldownRounds + this.nagCountInCycle * this.nagCooldownGrowth;
    if (this.roundsSinceUpdate - this.lastNagRound < cooldown) return false;

    // Only nag if there are incomplete todos
    const hasIncomplete = this.items.some((item) => item.status !== "completed");
    return hasIncomplete;
  }

  /**
   * Get the nag reminder message to inject. Embeds the stale-round count so the
   * content (and therefore the per-kind hash / stable id) changes every nag —
   * a constant reminder would be deduped away and never re-fire.
   */
  getNagReminder(roundsSinceUpdate: number): string {
    this.nagEpisode += 1;
    this.nagCountInCycle += 1;
    // Record when we nagged so shouldNag() can grow the next cooldown.
    this.lastNagRound = roundsSinceUpdate;
    return [
      "<reminder>",
      `Update your todos - mark completed tasks and update progress.`,
      `(nag #${this.nagEpisode}, unchanged for ${roundsSinceUpdate} rounds)`,
      "</reminder>",
    ].join("\n");
  }

  /**
   * Reset the round counter (called when todo tool is used).
   */
  resetRoundCounter(): void {
    this.roundsSinceUpdate = 0;
    this.lastNagRound = -Infinity;
    this.nagCountInCycle = 0;
  }

  /**
   * Get current rounds since last update.
   */
  getRoundsSinceUpdate(): number {
    return this.roundsSinceUpdate;
  }

  // ============================================================================
  // Getters
  // ============================================================================

  /**
   * Get all todo items.
   */
  getItems(): TodoItem[] {
    return [...this.items];
  }

  /**
   * Get the current todo set title.
   */
  getTitle(): string | null {
    return this.title;
  }

  /**
   * Get items by status.
   */
  getItemsByStatus(status: TodoStatus): TodoItem[] {
    return this.items.filter((item) => item.status === status);
  }

  /**
   * Get the current in_progress item (if any).
   */
  getCurrentTask(): TodoItem | null {
    return this.items.find((item) => item.status === "in_progress") ?? null;
  }

  /**
   * Get completion stats.
   */
  getStats(): { total: number; completed: number; inProgress: number; pending: number } {
    return {
      total: this.items.length,
      completed: this.items.filter((item) => item.status === "completed").length,
      inProgress: this.items.filter((item) => item.status === "in_progress").length,
      pending: this.items.filter((item) => item.status === "pending").length,
    };
  }

  /**
   * Check if all todos are completed.
   */
  isAllCompleted(): boolean {
    return this.items.length > 0 && this.items.every((item) => item.status === "completed");
  }

  /**
   * Check if there are any todos.
   */
  hasTodos(): boolean {
    return this.items.length > 0;
  }

  /**
   * Check if there are incomplete todos (pending or in_progress).
   * Useful for determining if context compaction should be blocked.
   */
  hasIncompleteTodos(): boolean {
    return this.items.some((item) => item.status === "pending" || item.status === "in_progress");
  }

  /**
   * Get incomplete todos for inclusion in compaction summary.
   * Returns pending and in_progress items.
   */
  getIncompleteTodos(): TodoItem[] {
    return this.items.filter((item) => item.status === "pending" || item.status === "in_progress");
  }

  private notifyListeners(): void {
    // Session `todos` projection — the bus is the single change mechanism.
    this.eventBus?.emit("session:todos", { items: this.getItems(), title: this.title });
  }

  // ============================================================================
  // Reset
  // ============================================================================

  /**
   * Restore todo items from a saved session (bypasses validation).
   */
  restoreTodos(items: TodoItem[], options?: { title?: string | null; planBound?: boolean }): void {
    this.items = [...items];
    this.title = options?.title?.trim() || null;
    this.planBound = options?.planBound === true;
    this.roundsSinceUpdate = 0;
    this.lastNagRound = -Infinity;
    this.nagCountInCycle = 0;
    this.touch();
    this.notifyListeners();
  }

  /** Mark whether this todo set belongs to plan building (survives title edits while bound). */
  setPlanBound(bound: boolean): void {
    this.planBound = bound;
  }

  isPlanBound(): boolean {
    return this.planBound;
  }

  /**
   * Resolve the UI/tool source marker for the current list.
   *
   * Plan ownership is `planBound` ALONE — the binding plan mode sets when it seeds a
   * list and clears when it exits. The title is deliberately NOT consulted: it is
   * authorable (the model passes it on every `todo` call), so a title match made
   * any agent list named "Plan" render as plan steps, and — because
   * `todoPlanBound` is persisted independently — a resume of a file that still
   * carried `todoPlanBound: true` latched every later list to `plan` forever.
   * `clear()` and {@link setPlanBound} are what own the flag.
   */
  getSource(): "plan" | "agent" {
    return this.planBound ? "plan" : "agent";
  }

  /**
   * Enable or disable auto-clear after all todos complete (default: enabled).
   */
  setAutoClearEnabled(enabled: boolean): void {
    this.autoClearEnabled = enabled;
    if (!enabled) {
      this.clearAutoClearTimer();
    }
  }

  isAutoClearEnabled(): boolean {
    return this.autoClearEnabled;
  }

  /**
   * Clear all todos.
   */
  clear(): void {
    this.items = [];
    this.roundsSinceUpdate = 0;
    this.lastNagRound = -Infinity;
    this.nagCountInCycle = 0;
    this.title = null;
    this.planBound = false;
    this.clearAutoClearTimer();
    this.touch();
    this.notifyListeners();
  }

  /**
   * Reset everything.
   */
  reset(): void {
    this.clear();
  }

  // ============================================================================
  // Private
  // ============================================================================

  private touch(): void {
    this.updatedAt = Date.now();
  }

  private scheduleAutoClearIfNeeded(): void {
    this.clearAutoClearTimer();

    if (!this.autoClearEnabled || !this.isAllCompleted()) {
      return;
    }

    this.autoClearTimeoutId = setTimeout(() => {
      if (this.isAllCompleted()) {
        this.clear();
      }
    }, 3_000);
  }

  private clearAutoClearTimer(): void {
    if (this.autoClearTimeoutId) {
      clearTimeout(this.autoClearTimeoutId);
      this.autoClearTimeoutId = null;
    }
  }
}
