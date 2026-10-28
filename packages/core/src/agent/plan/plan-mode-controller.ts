import { extractDoneSteps, extractPlan, type PlanStep } from "./extract-plan.js";
import { formatStructuredPlanMarkdown, stepsFromTexts, type StructuredPlanInput } from "./plan-format.js";
import { buildPlanExecuteSteerMessage } from "./plan-prompts.js";
import { savePlanFile } from "./plan-store.js";
import { extractGoalFromPlanMarkdown } from "./plan-summary.js";
import { parseVerificationItemsFromPlanMarkdown } from "./plan-verification.js";

import type { ResolvedCoreEnv } from "../../env";
import type { AgentEventBus } from "../agent-event-bus";
import type { TodoManager } from "../todo/todo-manager.js";

export type PlanModePhase = "off" | "planning" | "ready" | "executing" | "retro";

/** Todo set title used when plan steps are seeded into {@link TodoManager}. */
export const PLAN_TODO_TITLE = "Plan";

export interface PlanModeState {
  phase: PlanModePhase;
  planMarkdown: string | null;
  steps: PlanStep[];
  enabledAt: number | null;
  /** Plan steps were written to TodoManager (title {@link PLAN_TODO_TITLE}). */
  todosSeeded: boolean;
  /** Ready phase skipped seeding because unrelated todos already exist. */
  preservedExistingTodos: boolean;
  /** Relative path under `.agents/plans/` when auto-persisted or loaded. */
  planFilePath: string | null;
}

export interface PlanModeControllerDeps {
  getTodoManager: () => TodoManager | null;
  /** Owning runtime's env, so plan files land under the runtime root. Ambient when omitted. */
  getCoreEnv?: () => ResolvedCoreEnv;
  /** Invalidate runner / notify UI when phase changes. */
  onPhaseChange?: () => void;
  /**
   * Persist the session after a phase transition. Every transition goes through
   * {@link notifyChange}: `/mode execute`, `/mode done` and `/mode cancel` used to reach disk only
   * if an unrelated save followed, so quitting right after `/mode done` restored `retro` +
   * `todosSeeded` and kept auto-approving tools the user thought they had left.
   */
  persist?: () => void;
}

export interface BeginPlanExecutionResult {
  ok: boolean;
  error?: string;
  /** User message to send when starting execution. */
  steerMessage?: string;
  /** Steer was queued because the agent is still running. */
  queued?: boolean;
  /** Execute replaced an unrelated todo list with plan steps. */
  replacedExistingTodos?: boolean;
}

export interface ApplyPlanResult {
  ok: boolean;
  error?: string;
  stepCount?: number;
  planFilePath?: string | null;
  summary?: string;
}

/**
 * Owns plan-mode phase, last plan artifact, persistence path, and TodoManager seeding / DONE sync.
 */
export class PlanModeController {
  private phase: PlanModePhase = "off";
  private planMarkdown: string | null = null;
  private steps: PlanStep[] = [];
  private enabledAt: number | null = null;
  private todosSeeded = false;
  private preservedExistingTodos = false;
  private planFilePath: string | null = null;
  private todoUnsub: (() => void) | null = null;
  /** True while hydrating from disk: a restore must not write its own partial state back. */
  private restoring = false;

  /** Unified event bus for the owning agent (session `plan` projection + telemetry). */
  private eventBus?: AgentEventBus;

  constructor(private readonly deps: PlanModeControllerDeps) {}

  /** @internal Attach the agent's scoped unified event bus. */
  setEventBus(bus: AgentEventBus): void {
    this.eventBus = bus;
    bus.retain("session:plan", () => this.getState());
  }

  private notifyChange(): void {
    // Session `plan` projection — the bus is the single change mechanism.
    this.eventBus?.emit("session:plan", this.getState());
    this.deps.onPhaseChange?.();
    // A phase reached while restoring came FROM disk; writing it back can only capture a
    // half-hydrated session (todos/UI messages are restored after this point).
    if (!this.restoring) this.deps.persist?.();
  }

  getState(): PlanModeState {
    return {
      phase: this.phase,
      planMarkdown: this.planMarkdown,
      steps: [...this.steps],
      enabledAt: this.enabledAt,
      todosSeeded: this.todosSeeded,
      preservedExistingTodos: this.preservedExistingTodos,
      planFilePath: this.planFilePath,
    };
  }

  getPhase(): PlanModePhase {
    return this.phase;
  }

  /** True while mutate tools / MCP must be hidden or blocked. */
  isRestrictingTools(): boolean {
    return this.phase === "planning" || this.phase === "ready";
  }

  /**
   * Auto-approve pending `needsApproval` tools while the approved plan is being built,
   * and during the forced retrospective that closes it.
   *
   * Both phases are the same run of the same approved plan, and retro is where the plan's
   * Verification checklist has to be executed (`buildPlanModeRetroPrompt` asks for a command,
   * validate script, or observed behaviour as evidence per item) — leaving it un-approved
   * prompted on exactly the commands the lifecycle requires, while the identical commands ran
   * unprompted one phase earlier.
   *
   * `todosSeeded` stays required in both: a phase stuck without the seeded list must not bypass
   * approval (see `validate:plan-session`).
   */
  shouldAutoApproveTools(): boolean {
    return (this.phase === "executing" || this.phase === "retro") && this.todosSeeded;
  }

  /**
   * Hydrate controller from session persistence without clearing TodoManager.
   * Call after todos have been restored. Does not emit plan lifecycle enter/exit events.
   */
  restoreState(snapshot: PlanModeState | null | undefined): void {
    this.restoring = true;
    try {
      this.applyRestoredState(snapshot);
    } finally {
      this.restoring = false;
    }
  }

  private applyRestoredState(snapshot: PlanModeState | null | undefined): void {
    this.detachTodoListener();

    if (!snapshot || snapshot.phase === "off") {
      this.resetPlanState("off", null);
      // A resumed file can carry `todoPlanBound: true` with no plan phase (the flag is
      // persisted independently of `planMode`). Clearing it here is what stops that stale
      // binding from tagging every later list as plan-owned.
      this.deps.getTodoManager()?.setPlanBound(false);
      this.notifyChange();
      return;
    }

    this.phase = snapshot.phase;
    this.planMarkdown = snapshot.planMarkdown;
    this.steps = [...snapshot.steps];
    this.enabledAt = snapshot.enabledAt;
    this.todosSeeded = snapshot.todosSeeded;
    this.preservedExistingTodos = snapshot.preservedExistingTodos;
    this.planFilePath = snapshot.planFilePath;

    if (this.phase === "executing" || this.phase === "retro") {
      this.setPlanTodoAutoClear(false);
      const todoManager = this.deps.getTodoManager();
      if (this.todosSeeded) {
        todoManager?.setPlanBound(true);
      }
      if (this.phase === "executing") {
        this.attachTodoListener();
        this.maybeEnterRetro();
      }
    } else if (this.phase === "ready" || this.phase === "planning") {
      // Keep plan-bound todos from auto-clearing while reviewing / planning.
      if (this.todosSeeded) {
        this.setPlanTodoAutoClear(false);
        this.deps.getTodoManager()?.setPlanBound(true);
      }
    }

    this.notifyChange();
  }

  enable(): void {
    if (this.phase !== "off") return;
    this.resetPlanState("planning", Date.now());
    this.eventBus?.emit("plan:enter", { phase: this.phase });
    this.notifyChange();
  }

  disable(): void {
    if (this.phase === "off") return;
    this.detachTodoListener();
    this.clearPlanTodos();
    this.resetPlanState("off", null);
    this.eventBus?.emit("plan:exit", { phase: this.phase });
    this.notifyChange();
  }

  /**
   * Reset every plan artifact field, with the caller supplying the two values that differ per
   * transition (`phase`, `enabledAt`). One list is what keeps a newly added field from surviving
   * `disable()` and leaking into the next session.
   */
  private resetPlanState(phase: PlanModePhase, enabledAt: number | null): void {
    this.phase = phase;
    this.enabledAt = enabledAt;
    this.planMarkdown = null;
    this.steps = [];
    this.todosSeeded = false;
    this.preservedExistingTodos = false;
    this.planFilePath = null;
  }

  /**
   * Finish retro (or abort lifecycle) and exit plan mode.
   * Emits `plan:complete` then clears via {@link disable}.
   */
  complete(): { ok: boolean; error?: string } {
    if (this.phase === "off") {
      return { ok: false, error: "Plan mode is already off" };
    }
    const fromPhase = this.phase;
    this.eventBus?.emit("plan:complete", {
      phase: fromPhase,
      planFilePath: this.planFilePath,
      stepCount: this.steps.length,
    });
    this.disable();
    return { ok: true };
  }

  toggle(): PlanModePhase {
    if (this.phase === "off") {
      this.enable();
    } else {
      this.disable();
    }
    return this.phase;
  }

  /** Stop execution but keep the approved plan in `ready` (read-only). */
  cancelExecution(): boolean {
    if (this.phase !== "executing" && this.phase !== "retro") return false;
    this.detachTodoListener();
    this.setPlanTodoAutoClear(false);
    this.phase = "ready";
    this.eventBus?.emit("plan:cancel-execution", {
      phase: this.phase,
      stepCount: this.steps.length,
    });
    this.notifyChange();
    return true;
  }

  beginExecution(): BeginPlanExecutionResult {
    if (this.phase !== "ready") {
      return {
        ok: false,
        error:
          this.phase === "planning"
            ? "No plan ready yet — wait for create_plan (or a ## Plan section)"
            : `Cannot execute from phase "${this.phase}"`,
      };
    }

    const { replacedExisting } = this.seedTodosFromSteps({ force: true });
    this.preservedExistingTodos = false;
    this.phase = "executing";
    this.setPlanTodoAutoClear(false);
    this.attachTodoListener();
    this.eventBus?.emit("plan:execute", {
      phase: this.phase,
      stepCount: this.steps.length,
      replacedExistingTodos: replacedExisting,
      planFilePath: this.planFilePath,
    });
    this.notifyChange();
    this.maybeEnterRetro();

    return {
      ok: true,
      steerMessage: buildPlanExecuteSteerMessage(this.planMarkdown, this.planFilePath),
      replacedExistingTodos: replacedExisting,
    };
  }

  /**
   * Apply a structured plan from `create_plan` / `update_plan`.
   * Transitions `planning` → `ready` when steps are present; auto-persists to `.agents/plans/`.
   */
  async applyStructuredPlan(input: StructuredPlanInput): Promise<ApplyPlanResult> {
    if (this.phase !== "planning" && this.phase !== "ready") {
      return {
        ok: false,
        error: `Plan tools only work in planning/ready (current: ${this.phase})`,
      };
    }

    const steps = stepsFromTexts(input.steps);
    if (steps.length === 0) {
      return { ok: false, error: "Plan must include at least one step" };
    }
    if (!input.goal.trim()) {
      return { ok: false, error: "Plan goal is required" };
    }
    if (!input.keyFiles || input.keyFiles.length === 0) {
      return { ok: false, error: "Plan must include at least one key file" };
    }

    const planMarkdown = formatStructuredPlanMarkdown({ ...input, steps: steps.map((s) => s.text) });
    return this.applyPlanArtifact(planMarkdown, steps, { nameHint: input.goal });
  }

  /**
   * After an assistant turn: extract plan in planning, or apply [DONE:n] while executing.
   */
  onAssistantText(text: string): void {
    if (!text.trim()) return;

    if (this.phase === "planning" || this.phase === "ready") {
      const extracted = extractPlan(text);
      if (!extracted) return;
      void this.applyPlanArtifact(extracted.planMarkdown, extracted.steps);
      return;
    }

    if (this.phase === "executing") {
      this.applyDoneMarkers(text);
      this.maybeEnterRetro();
    }
  }

  /**
   * Shared path for tool + markdown plan artifacts.
   * Auto-persists under `.agents/plans/` (overwrites active path when set).
   */
  async applyPlanArtifact(
    planMarkdown: string,
    steps: PlanStep[],
    options?: { nameHint?: string; existingRelativePath?: string }
  ): Promise<ApplyPlanResult> {
    if (steps.length === 0) {
      return { ok: false, error: "Plan must include at least one step" };
    }
    if (this.phase !== "planning" && this.phase !== "ready") {
      return { ok: false, error: `Cannot apply plan while phase is "${this.phase}"` };
    }

    this.planMarkdown = planMarkdown;
    this.steps = steps;
    const { seeded, skippedDueToExisting } = this.seedTodosFromSteps({ force: false });
    this.preservedExistingTodos = skippedDueToExisting;

    const persistPath = options?.existingRelativePath ?? this.planFilePath ?? undefined;
    const nameHint = options?.nameHint ?? extractGoalFromPlanMarkdown(planMarkdown);
    try {
      const { path } = await savePlanFile(
        planMarkdown,
        nameHint,
        { existingRelativePath: persistPath },
        this.deps.getCoreEnv?.()
      );
      this.planFilePath = path;
    } catch {
      // Non-fatal: keep in-memory plan even if disk write fails
    }

    if (this.phase === "planning") {
      this.phase = "ready";
      this.eventBus?.emit("plan:ready", {
        phase: this.phase,
        stepCount: this.steps.length,
        preservedExistingTodos: skippedDueToExisting,
        todosSeeded: seeded,
        planFilePath: this.planFilePath,
      });
      this.notifyChange();
    } else {
      this.notifyChange();
    }

    return {
      ok: true,
      stepCount: this.steps.length,
      planFilePath: this.planFilePath,
    };
  }

  /**
   * Load markdown into the plan state.
   *
   * Entering plan mode is **not** done here: `ModeCoordinator.enablePlan()` is the only writer
   * that also turns auto mode off (the two are mutually exclusive), and a phase started here
   * bypassed that — leaving `auto` on while a plan phase was active, which re-enabled approval
   * bypass during `planning` / `ready`. Callers that may start from `off` go through
   * `ModeCoordinator` first (see `loadPlanFromWorkspace`).
   *
   * Used by `/mode load`. Sets {@link planFilePath} when `relativePath` is provided.
   */
  async loadPlanMarkdown(markdown: string, options?: { relativePath?: string }): Promise<ApplyPlanResult> {
    if (this.phase !== "planning" && this.phase !== "ready") {
      return { ok: false, error: `Cannot load plan while phase is "${this.phase}"` };
    }

    const extracted = extractPlan(markdown);
    if (!extracted) {
      return { ok: false, error: "File does not contain a ## Plan section with numbered steps" };
    }

    return this.applyPlanArtifact(extracted.planMarkdown, extracted.steps, {
      existingRelativePath: options?.relativePath,
      nameHint: extractGoalFromPlanMarkdown(markdown),
    });
  }

  /** Record path after explicit `/mode save` (may rename). */
  setPlanFilePath(path: string): void {
    this.planFilePath = path;
  }

  /** @returns seed outcome for ready vs execute flows */
  private seedTodosFromSteps(options: { force: boolean }): {
    seeded: boolean;
    skippedDueToExisting: boolean;
    replacedExisting: boolean;
  } {
    const none = { seeded: false, skippedDueToExisting: false, replacedExisting: false };
    const todoManager = this.deps.getTodoManager();
    if (!todoManager || this.steps.length === 0) return none;

    // Existing todos are "unrelated" when they're not plan-owned (not plan-bound
    // and not a restored "Plan" seed). Skip seeding / treat as replaced based on
    // that identity, not on the title string.
    if (!options.force && todoManager.hasTodos() && todoManager.getSource() !== "plan") {
      return { seeded: false, skippedDueToExisting: true, replacedExisting: false };
    }

    const replacedExisting = options.force && todoManager.hasTodos() && todoManager.getSource() !== "plan";

    const verificationItems = parseVerificationItemsFromPlanMarkdown(this.planMarkdown);

    // Steps seed one todo each. Verification items are merged into a single
    // `[verify]` todo (not one per item) so long plans don't blow the todo cap;
    // complete_plan still gates per-item via plan markdown parsing.
    const verifyTodo =
      verificationItems.length > 0
        ? {
            content: `[verify] ${verificationItems.join(" | ")}`,
            status: "pending" as const,
            priority: "medium" as const,
          }
        : null;

    todoManager.update(
      [
        ...this.steps.map((s) => ({
          content: s.text,
          status: "pending" as const,
          priority: "medium" as const,
        })),
        ...(verifyTodo ? [verifyTodo] : []),
      ],
      PLAN_TODO_TITLE,
      // Plan steps are authoritative; don't cap seeding at maxTodos.
      { allowMaxExceed: true }
    );
    todoManager.setPlanBound(true);
    this.todosSeeded = true;
    if (replacedExisting) {
      this.eventBus?.emit("plan:todo-replaced", { stepCount: this.steps.length });
    }
    return { seeded: true, skippedDueToExisting: false, replacedExisting };
  }

  private applyDoneMarkers(text: string): void {
    const done = extractDoneSteps(text);
    if (done.length === 0) return;

    const todoManager = this.deps.getTodoManager();
    if (!todoManager) return;

    const items = todoManager.getItems();
    if (items.length === 0) return;

    const title = todoManager.getTitle() ?? PLAN_TODO_TITLE;
    const doneSet = new Set(done);
    const stepCount = this.steps.length;
    todoManager.update(
      items.map((item, index) => {
        const stepNum = index + 1;
        // [DONE:n] maps to steps only; verification todos are tracked via the todo tool.
        const completed = item.status === "completed" || (stepNum <= stepCount && doneSet.has(stepNum));
        return {
          content: item.content,
          status: completed ? ("completed" as const) : item.status,
          priority: item.priority,
        };
      }),
      title,
      // Preserve seeded list size even if it exceeds maxTodos.
      { allowMaxExceed: true }
    );
  }

  private maybeEnterRetro(): void {
    if (this.phase !== "executing") return;
    if (!this.todosSeeded) return;
    const todoManager = this.deps.getTodoManager();
    // Plan identity is tracked via plan-bound/source, not the (authorable) title
    // string: the agent may update the list under a descriptive title while phase
    // is still `executing`, so gating on the exact "Plan" title would leave the
    // life/cycle stuck on `building n/m` forever. Gate on the source marker that
    // `todo` uses (isPlanBound(), or a restored "Plan"-titled seed).
    if (!todoManager || todoManager.getSource() !== "plan") return;
    if (!todoManager.isAllCompleted()) return;

    this.phase = "retro";
    this.eventBus?.emit("plan:retro", {
      phase: this.phase,
      stepCount: this.steps.length,
      planFilePath: this.planFilePath,
    });
    this.notifyChange();
  }

  private attachTodoListener(): void {
    this.detachTodoListener();
    if (!this.deps.getTodoManager()) return;
    // Todo changes surface as `session:todos` on the agent's scoped bus.
    this.todoUnsub =
      this.eventBus?.on(
        "session:todos",
        () => {
          this.maybeEnterRetro();
        },
        { replay: false }
      ) ?? null;
  }

  private detachTodoListener(): void {
    this.todoUnsub?.();
    this.todoUnsub = null;
  }

  private clearPlanTodos(): void {
    const todoManager = this.deps.getTodoManager();
    if (!todoManager) return;
    this.setPlanTodoAutoClear(true);
    // Plan-owned list (plan-bound, or a restored "Plan" seed) is cleared on
    // disable/complete; an agent-owned list is only unbound.
    if (this.todosSeeded && todoManager.getSource() === "plan") {
      todoManager.clear();
    } else if (this.todosSeeded) {
      todoManager.setPlanBound(false);
    } else {
      // Nothing was seeded by this controller, but a resumed session can still carry a
      // stale `todoPlanBound` (it is persisted per todo-manager, not per plan phase).
      // Releasing it unconditionally is what makes the binding owner-consistent: a
      // binding only means anything while plan mode is live, and it is no longer live.
      todoManager.setPlanBound(false);
    }
    this.todosSeeded = false;
  }

  private setPlanTodoAutoClear(enabled: boolean): void {
    this.deps.getTodoManager()?.setAutoClearEnabled(enabled);
  }
}
