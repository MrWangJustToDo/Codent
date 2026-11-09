/**
 * Turn-context ownership: the frozen system-prompt prefix, per-turn dynamic sections,
 * instruction-context change detection, and the `<background_jobs>` pointer.
 *
 * Admission itself is **not** owned here: the middleware compares each section against the
 * latest block of that kind in the post-compaction wire, so there is no remembered hash table,
 * counter or generation to reset when the window is rebuilt (compaction / restore / switch).
 * What remains stateful is only what genuinely cannot be derived from the window — the frozen
 * prompt, the instruction digest baseline, and the one-shot session-history gate.
 *
 * The controller never reaches into `ManagedAgent`; everything it needs arrives as a getter so the
 * runner's cache (which reads turn context through `AgentRunDeps`) never captures a stale value.
 */

import { errorMessage } from "../../utils/errors.js";
import { buildAutoModePrompt } from "../approval/auto-mode-prompt.js";
import { buildModeInactivePrompt, buildPlanModePrompt } from "../plan/plan-prompts.js";
import { buildFrozenSystemPrompt } from "../prompt/frozen-system-prompt.js";

import { getCurrentDate, getGitInfo } from "./env-context.js";
import {
  formatInstructionContextSection,
  instructionStateChanged,
  loadLatestInstructionContent,
  readInstructionContextState,
  type InstructionContextState,
} from "./instruction-context.js";
import { buildTurnContextSections } from "./prompt-builder.js";
import { formatSessionRetrievalSection, hasSessionHistory } from "./session-retrieval.js";

import type { ExtensionRunner, ExtensionTurnContextSection } from "../extension";
import type { TurnContextSection } from "./turn-context-message.js";
import type { ResolvedCoreEnv } from "../../env";
import type { ModeState } from "../mode/mode-state.js";

export interface TurnContextControllerOptions {
  /** Agent id passed to extension `before_agent_start` hooks. */
  agentId: string;
  getConfig: () => { systemPrompt?: string };
  getCoreEnv: () => ResolvedCoreEnv;
  getSessionId: () => string | undefined;
  /** Single mode read surface; the plan artifact and auto flag both come from it. */
  getModeState: () => ModeState;
  getExtensionRunner: () => ExtensionRunner | null;
  getParentId: () => string | undefined;
  onPromptBefore: (input: { prompt: string; hasTurnContext: boolean }) => void;
  /** Prompt changed → the cached AgentRunner key is stale. */
  invalidateRunner: () => void;
  /** Publishes subsystem notes (`session:diagnostic`); the policy owns level/category. */
  emitDiagnostic?: (
    area: "context",
    message: string,
    options?: { level?: "debug" | "info" | "warn" | "error"; error?: string }
  ) => void;
}

export class TurnContextController {
  private agentDocContent = "";
  private agentDocSource = "";
  private frozenSystemPrompt: string | undefined;
  private systemPromptFrozen = false;
  /** Pending per-extension turn-context sections collected in prepareForRun (before injection). */
  private pendingExtensionTurnContextSections: ExtensionTurnContextSection[] | undefined;
  /**
   * Extensions disabled WHILE {@link collectExtensionPromptHooks} is awaiting its interceptors.
   *
   * The collection is async (every `before_agent_start` handler is awaited) and it writes the
   * snapshot in one assignment at the end. A disable that lands mid-flight called
   * `clearExtensionSections` on an `undefined` snapshot and returned, so the assignment then
   * re-admitted the just-disabled extension's section for the whole turn — the exact "section says
   * the tool exists" bug the clear path exists to prevent, plus a lost disabled notice.
   */
  private collectingExtensionSections = false;
  private disabledDuringCollection = new Map<string, string | undefined>();
  /**
   * Which collection owns the two fields above.
   *
   * A pump can be interrupted between "prepare started" and "hooks returned" (Esc resets
   * `pumpDepth` immediately), so a second `prepareForRun` can start while the first is still
   * awaiting its hooks. Without an owner, the first one's `finally` clears the second's flags and
   * its late assignment overwrites the newer snapshot. Bumped by every collection and by
   * `clearTurnContext`, so only the newest generation may write.
   */
  private collectionEpoch = 0;
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

  /**
   * Collect `before_agent_start` interceptors + turn-context providers for this user turn.
   * Runs in prepareForRun; the turn-context middleware consumes the results at onConfig.
   */
  async collectExtensionPromptHooks(prompt: string): Promise<void> {
    this.pendingExtensionTurnContextSections = undefined;

    const runner = this.options.getExtensionRunner();
    if (!runner) return;

    const epoch = ++this.collectionEpoch;
    this.collectingExtensionSections = true;
    this.disabledDuringCollection.clear();
    let sections: ExtensionTurnContextSection[] | undefined;
    try {
      const collected = await runner.collectBeforeAgentStart(prompt, this.options.agentId);
      let next = collected.turnContextSections ?? [];
      // Re-apply the disables that raced the await, in the same shape `clearExtensionSections`
      // would have produced had the snapshot existed when they arrived.
      for (const [extensionId, notice] of this.disabledDuringCollection) {
        next = stripExtensionSections(next, extensionId, notice);
      }
      sections = next.length > 0 ? next : undefined;
    } finally {
      // A superseded collection owns neither the flags nor the snapshot: clearing them here would
      // disarm the NEWER collection (see `collectionEpoch`).
      if (epoch === this.collectionEpoch) {
        this.collectingExtensionSections = false;
        this.disabledDuringCollection.clear();
        // Assigned even on a throw so a failed collection cannot leave the PREVIOUS turn's
        // sections attached to this one.
        this.pendingExtensionTurnContextSections = sections;
      }
    }

    if (epoch === this.collectionEpoch) {
      this.options.onPromptBefore({
        prompt,
        hasTurnContext: Boolean(sections?.length),
      });
    }
  }

  /**
   * Drop one extension's sections from the CURRENT turn's snapshot.
   *
   * Sections are collected once per user turn and reused by every model call in it. Disabling an
   * extension mid-turn removed its tools immediately but left its section saying they exist, so
   * the model called a tool that had just vanished. The disabled notice is written separately and
   * reaches the next call through the same snapshot.
   */
  clearExtensionSections(extensionId: string, notice?: string): void {
    // A disable during the async collection has no snapshot to edit yet: remember it and let the
    // collection apply it after the await (otherwise the assignment would re-admit the section).
    if (this.collectingExtensionSections) {
      this.disabledDuringCollection.set(extensionId, notice);
      return;
    }
    const sections = this.pendingExtensionTurnContextSections;
    if (!sections) return;
    this.pendingExtensionTurnContextSections = stripExtensionSections(sections, extensionId, notice);
  }

  clearTurnContext(): void {
    // Invalidate an in-flight collection too: its result belongs to the turn that just ended, and
    // assigning it afterwards would re-attach that turn's sections to the next one.
    this.collectionEpoch += 1;
    this.collectingExtensionSections = false;
    this.disabledDuringCollection.clear();
    this.pendingExtensionTurnContextSections = undefined;
    // NOTE: instructionContextState / instructionContextActive intentionally NOT
    // reset here — they must survive across user turns (clearTurnContext runs at every
    // turn finalize). Otherwise every turn re-baselines and cross-turn instruction
    // changes are never detected. Reset only on an explicit full reset.
  }

  resetSystemPrompt(): void {
    this.systemPromptFrozen = false;
    this.frozenSystemPrompt = undefined;
    this.options.invalidateRunner();
  }

  /** Full context reset (`ManagedAgent.reset`): prompt + pending per-turn state + instruction baseline. */
  resetTurnState(): void {
    this.clearTurnContext();
    this.instructionContextState = undefined;
    this.instructionContextActive = false;
    this.resetSystemPrompt();
  }

  /**
   * Build the ordered dynamic turn-context sections for the current user turn.
   *
   * Hash-admitted sections only: condition + counter reminders (todo nag, repeat nudge) and
   * background pushes are their own middlewares, so nothing here depends on the window.
   */
  async getDynamicTurnContextSections(): Promise<TurnContextSection[]> {
    const currentDate = getCurrentDate();
    const { branch: gitBranch, status: gitStatus } = await getGitInfo(this.options.getCoreEnv());

    const modeState = this.options.getModeState().snapshot();
    const planState = modeState.plan;
    const planModeContent = buildPlanModePrompt(planState.phase, planState.planMarkdown, planState.planFilePath);
    // Plan turn-context wins when plan is active; auto prompt only in pure auto mode.
    // The mode section is always present (inactive declaration when neither is
    // active) so mode exits are explicitly communicated and re-entries with
    // identical instructions still re-inject (content reflects state).
    const autoModeContent = !planModeContent && modeState.auto ? buildAutoModePrompt() : undefined;
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
    // Read per turn (not cached): a resume/new changes it and the section re-admits.
    const sessionId = this.options.getSessionId();

    return buildTurnContextSections({
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
      this.options.emitDiagnostic?.("context", "Instruction-context detection failed", {
        level: "warn",
        error: message,
      });
      return undefined;
    }
  }
}

/**
 * Remove one extension's section(s) — the base `ext:<id>` and its named `ext:<id>:<name>`
 * variants — from a collected snapshot, replacing them with the disabled notice when one was
 * produced. Shared by the immediate clear and the during-collection path so both yield the same
 * snapshot.
 */
function stripExtensionSections(
  sections: ExtensionTurnContextSection[],
  extensionId: string,
  notice?: string
): ExtensionTurnContextSection[] {
  const prefix = `ext:${extensionId}`;
  const remaining = sections.filter((section) => section.id !== prefix && !section.id.startsWith(`${prefix}:`));
  const body = notice?.trim();
  return body ? [...remaining, { id: prefix, content: body }] : remaining;
}
