/**
 * Turn-context ownership: the frozen system-prompt prefix, per-turn dynamic sections, admission
 * state, instruction-context change detection, and the `<background_jobs>` pointer.
 *
 * These used to live as eleven fields on `ManagedAgent`. They have one invariant — the prompt
 * prefix and per-turn payloads must stay byte-stable until a hash/generation says they changed —
 * and one consumer shape: a section list for `AgentRunDeps` / the turn-context middleware. Keeping
 * them together makes `resetTurnState()` the single reset path (the old inline reset cleared only
 * some of the fields).
 *
 * The controller never reaches into `ManagedAgent`; everything it needs arrives as a getter so the
 * runner's cache (which reads turn context through `AgentRunDeps`) never captures a stale value.
 */

import { buildAutoModePrompt } from "../../agent/approval/auto-mode-prompt.js";
import { buildModeInactivePrompt, buildPlanModePrompt } from "../../agent/plan/plan-prompts.js";
import { getCurrentDate, getGitInfo } from "../../agent/turn-context/env-context.js";
import {
  formatInstructionContextSection,
  instructionStateChanged,
  loadLatestInstructionContent,
  readInstructionContextState,
  type InstructionContextState,
} from "../../agent/turn-context/instruction-context.js";
import { formatSessionRetrievalSection, hasSessionHistory } from "../../agent/turn-context/session-retrieval.js";
import { errorMessage } from "../../utils/errors.js";
import { buildFrozenSystemPrompt, buildTurnContextSections } from "../managed-agent-prompt.js";

import type { AgentLog } from "../../agent/agent-log";
import type { ExtensionRunner, ExtensionTurnContextSection } from "../../agent/extension";
import type { PlanModeState } from "../../agent/plan/plan-mode-controller.js";
import type { TodoManager } from "../../agent/todo";
import type { TurnContextSection } from "../../agent/turn-context/turn-context-message.js";
import type { ResolvedCoreEnv } from "../../env";
import type { AgentConfig } from "../agent-types.js";
import type { ModelMessage } from "@tanstack/ai";

export interface TurnContextControllerOptions {
  /** Agent id passed to extension `before_agent_start` hooks. */
  agentId: string;
  getConfig: () => AgentConfig;
  getCoreEnv: () => ResolvedCoreEnv;
  getSessionId: () => string | undefined;
  getTodoManager: () => TodoManager | null;
  getPlanState: () => PlanModeState;
  isAutoModeEnabled: () => boolean;
  getRelevantMemoryContent: () => string;
  getExtensionRunner: () => ExtensionRunner | null;
  getParentId: () => string | undefined;
  /** Current model-visible wire → `<background_jobs>` section (owned by BackgroundWorkService). */
  getBackgroundJobsSection?: (
    messages: readonly ModelMessage[],
    generation: number
  ) => Promise<TurnContextSection | undefined>;
  onPromptBefore: (input: { prompt: string; hasTurnContext: boolean }) => void;
  /** Prompt changed → the cached AgentRunner key is stale. */
  invalidateRunner: () => void;
  log?: AgentLog;
}

export class TurnContextController {
  private agentDocContent = "";
  private agentDocSource = "";
  private frozenSystemPrompt: string | undefined;
  private systemPromptFrozen = false;
  /** Pending per-extension turn-context sections collected in prepareForRun (before injection). */
  private pendingExtensionTurnContextSections: ExtensionTurnContextSection[] | undefined;
  /** Latest admitted hash per section kind (restore-seeded; only changed kinds re-admit). */
  private lastAdmittedTurnContextHashes: Map<string, string> | undefined;
  /** Message count at the last context admit (for periodic refresh; state owned by turn-context middleware). */
  private turnContextAdmitMessageCount = 0;
  /** Bumped by {@link resetAdmittedTurnContext}; forces the background-jobs section to re-admit. */
  private turnContextGeneration = 0;
  /** Last-seen instruction file digest snapshot (for instruction change detection). */
  private instructionContextState: InstructionContextState | undefined;
  /** Once an instruction change is detected, keep re-injecting (stable payload). */
  private instructionContextActive = false;
  /**
   * Whether the workspace had conversation history when this agent was created.
   * Evaluated once: the retrieval section must be byte-stable across turns, so it
   * cannot be re-probed per turn (a new session would flip it and re-inject).
   */
  private sessionHistoryPresent = false;

  constructor(private readonly options: TurnContextControllerOptions) {}

  setAgentDocContent(content: string, source?: string): void {
    this.agentDocContent = content;
    this.agentDocSource = source ?? "";
  }

  getAgentDocContent(): string {
    return this.agentDocContent;
  }

  getAgentDocSource(): string {
    return this.agentDocSource;
  }

  /**
   * Evaluate the session-history gate once, at agent creation.
   *
   * Deliberately not re-evaluated per turn: the retrieval section is injected by
   * hash, so a workspace gaining its first session mid-conversation would flip the
   * gate, change the hash, and re-inject the whole block. Called only for root
   * agents (see `agent-factory`), matching `setAgentDocContent`.
   */
  async primeSessionHistoryGate(): Promise<void> {
    this.sessionHistoryPresent = await hasSessionHistory(this.options.getCoreEnv());
  }

  getSystemPrompt(): string | undefined {
    if (this.systemPromptFrozen) return this.frozenSystemPrompt;
    this.frozenSystemPrompt = buildFrozenSystemPrompt({
      config: this.options.getConfig(),
      agentDocContent: this.agentDocContent,
    });
    this.systemPromptFrozen = true;
    return this.frozenSystemPrompt;
  }

  /** Alias for the cacheable system prompt prefix (before per-turn dynamic segment). */
  getFrozenSystemPrompt(): string | undefined {
    return this.getSystemPrompt();
  }

  getAdmittedContextHashes(): Map<string, string> | undefined {
    return this.lastAdmittedTurnContextHashes;
  }

  setAdmittedContextHashes(hashes: Map<string, string> | undefined): void {
    this.lastAdmittedTurnContextHashes = hashes;
  }

  getTurnContextAdmitMessageCount(): number {
    return this.turnContextAdmitMessageCount;
  }

  setTurnContextAdmitMessageCount(count: number): void {
    this.turnContextAdmitMessageCount = count;
  }

  /**
   * Collect `before_agent_start` interceptors + turn-context providers for this user turn.
   * Runs in prepareForRun; the turn-context middleware consumes the results at onConfig.
   */
  async collectExtensionPromptHooks(prompt: string): Promise<void> {
    this.pendingExtensionTurnContextSections = undefined;

    const runner = this.options.getExtensionRunner();
    if (!runner) return;

    const collected = await runner.collectBeforeAgentStart(prompt, this.options.agentId);
    this.pendingExtensionTurnContextSections = collected.turnContextSections;

    this.options.onPromptBefore({
      prompt,
      hasTurnContext: Boolean(collected.turnContextSections?.length),
    });
  }

  /**
   * After compaction / clear — force the next turn to re-admit full dynamic context.
   *
   * `preserveInstructionContext` is used by compaction: the instruction digest is the baseline
   * for detecting edits, so clearing it would make the next evaluation treat the current file as a
   * fresh baseline and silently drop an edit that had not been admitted before the cut. A full
   * clear/reset still re-baselines.
   */
  resetAdmittedTurnContext(preserveInstructionContext = false): void {
    this.lastAdmittedTurnContextHashes = undefined;
    this.turnContextGeneration += 1;
    this.turnContextAdmitMessageCount = 0;
    if (!preserveInstructionContext) {
      this.instructionContextState = undefined;
      this.instructionContextActive = false;
    }
  }

  clearTurnContext(): void {
    this.pendingExtensionTurnContextSections = undefined;
    // NOTE: instructionContextState / instructionContextActive intentionally NOT
    // reset here — like lastAdmittedTurnContextHashes they must survive across user
    // turns (clearTurnContext runs at every turn finalize). Otherwise every turn
    // re-baselines and cross-turn instruction changes are never detected. Reset
    // only on compact / full context reset (resetAdmittedTurnContext).
  }

  resetSystemPrompt(): void {
    this.systemPromptFrozen = false;
    this.frozenSystemPrompt = undefined;
    this.options.invalidateRunner();
  }

  /** Full context reset (`ManagedAgent.reset`): admission + prompt + pending per-turn state. */
  resetTurnState(): void {
    this.resetAdmittedTurnContext();
    this.clearTurnContext();
    this.resetSystemPrompt();
  }

  /** Build the ordered dynamic turn-context sections for the current user turn. */
  async getDynamicTurnContextSections(): Promise<TurnContextSection[]> {
    const todoManager = this.options.getTodoManager();
    let todoNagReminder: string | undefined;
    if (todoManager?.shouldNag()) {
      const rounds = todoManager.getRoundsSinceUpdate();
      todoNagReminder = todoManager.getNagReminder(rounds);
      this.options.log?.debug("todo", "Capturing nag reminder in turn context snapshot", {
        roundsSinceUpdate: rounds,
      });
    }

    const currentDate = getCurrentDate();
    const { branch: gitBranch, status: gitStatus } = await getGitInfo(this.options.getCoreEnv());

    const planState = this.options.getPlanState();
    const planModeContent = buildPlanModePrompt(planState.phase, planState.planMarkdown, planState.planFilePath);
    // Plan turn-context wins when plan is active; auto prompt only in pure auto mode.
    // The mode section is always present (inactive declaration when neither is
    // active) so mode exits are explicitly communicated and re-entries with
    // identical instructions still re-inject (content reflects state).
    const autoModeContent = !planModeContent && this.options.isAutoModeEnabled() ? buildAutoModePrompt() : undefined;
    const modeContent = planModeContent ?? autoModeContent ?? buildModeInactivePrompt();

    // Instruction files are frozen into the system prompt at startup; if the model
    // edited AGENTS.md / CLAUDE.md since we last evaluated, re-inject the latest
    // content. Only injected on change — unchanged keeps the payload byte-stable
    // (prompt-cache friendly). First evaluation establishes the baseline (frozen
    // system prompt already carries the initial content).
    const instructionContext = await this.readChangedInstructionContext();

    // Retrieval guidance is static and gated on history existing. The gate is
    // evaluated once (see `primeSessionHistoryGate`) rather than per turn: a
    // workspace gaining its first session must not change this section's hash.
    const sessionRetrieval = formatSessionRetrievalSection({ hasHistory: this.sessionHistoryPresent });

    // The live session id, so the model can address its own compacted-away history.
    // Read per turn (not cached): a resume/clear changes it and the section re-admits.
    const sessionId = this.options.getSessionId();

    return buildTurnContextSections({
      relevantMemoryContent: this.options.getRelevantMemoryContent(),
      todoNagReminder,
      currentDate,
      gitBranch,
      gitStatus,
      modeContent,
      sessionId,
      sessionRetrieval,
      extensionTurnContextSections: this.pendingExtensionTurnContextSections,
      instructionContext,
    });
  }

  /**
   * `<background_jobs>` section for the CURRENT model-visible wire.
   *
   * Only jobs whose `run_command` tool call is still in `messages` are listed: after compaction has
   * dropped the call, re-listing the job is noise (the completion notification is a separate,
   * self-contained surface and stays searchable). Built by the turn-context middleware, which has
   * the post-compaction wire; the generation changes on every compaction reset so a reset
   * re-admits the section even when the restore seeding finds the old row in the channel.
   */
  async getBackgroundJobsSection(messages: readonly ModelMessage[]): Promise<TurnContextSection | undefined> {
    if (this.options.getParentId()) return undefined;
    if (!this.options.getBackgroundJobsSection) return undefined;
    try {
      return await this.options.getBackgroundJobsSection(messages, this.turnContextGeneration);
    } catch {
      // A host without a CoreEnv (tests/standalone) has no job store; the section is optional.
      return undefined;
    }
  }

  /**
   * Detect whether instruction files changed since the last evaluation and, when
   * so, return the rendered `<instruction_context>` section with the latest content.
   * Always refreshes the stored digest snapshot (baseline = first evaluation).
   */
  private async readChangedInstructionContext(): Promise<string | undefined> {
    try {
      const current = await readInstructionContextState(this.options.getCoreEnv());
      // Baseline: the first evaluation only stores the snapshot without injecting —
      // the frozen system prompt already carries the initial instructions. This also
      // covers the restore-from-session case (fresh instance, no prior snapshot).
      if (this.instructionContextState === undefined) {
        this.instructionContextState = current;
        return undefined;
      }

      const changed = instructionStateChanged(this.instructionContextState, current);
      this.instructionContextState = current;
      if (!this.instructionContextActive && !changed) return undefined;

      // Sticky: once a change is detected we keep re-injecting the latest content so
      // the payload stays stable across turns (prompt-cache friendly). A fresh
      // change re-reads the newest file content into the section.
      this.instructionContextActive = true;
      const loaded = await loadLatestInstructionContent(this.options.getCoreEnv());
      return formatInstructionContextSection(loaded);
    } catch (err) {
      const message = errorMessage(err);
      this.options.log?.warn("agent", "Instruction-context detection failed", { error: message });
      return undefined;
    }
  }
}
