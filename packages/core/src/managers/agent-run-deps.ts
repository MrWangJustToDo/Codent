import { getEnv, type ResolvedCoreEnv } from "../env";

import type { AgentManager } from "./agent-manager.js";
import type { ManagedAgent, ManagedAgentConfig } from "./managed-agent.js";
import type { AgentCommandService } from "./services/agent-command-service.js";
import type { BackgroundWorkService } from "./services/background-work-service.js";
import type { SessionService } from "./services/session-service.js";
import type { UsageTracker } from "./telemetry/usage-tracker.js";
import type { ToolApprovalTable } from "../agent/approval/tool-approval-table.js";
import type { CompactionController } from "../agent/compaction/compaction-controller.js";
import type { ToolCompactCache } from "../agent/compaction/tool-compact/tool-compact-cache.js";
import type { CompactionConfig } from "../agent/compaction/types.js";
import type { WireProjectionCache } from "../agent/compaction/wire-projection-cache.js";
import type { ExtensionRunner } from "../agent/extension/runner.js";
import type { ToolBeforeHookLedger } from "../agent/extension/tool-before-hook.js";
import type { ModeState } from "../agent/mode/mode-state.js";
import type { AgentPolicyFacts } from "../agent/mode/policy-facts.js";
import type { RunCoordinator } from "../agent/run/run-coordinator.js";
import type { AgentStatusController } from "../agent/state/agent-status-controller.js";
import type { AgentStreamHub } from "../agent/stream-hub";
import type { TodoManager } from "../agent/todo";
import type { ToolPresentation } from "../agent/tools/presentation/types.js";
import type { TurnContextSection } from "../agent/turn-context/turn-context-message.js";
import type { AgentUIChannel } from "../agent/ui/ui-channel.js";
import type { UsageHistoryService } from "../agent/usage/usage-history-service.js";
import type { ModelInfo } from "../models/types.js";
import type { AgentIterationState } from "../runtime-types/session-payloads.js";
import type { ModelMessage, UIMessage as TanStackUIMessage } from "@tanstack/ai";

/**
 * The complete collaborator surface {@link buildAgentRunner} needs from a
 * `ManagedAgent`, so the assembly reads one object instead of reaching into the
 * agent from every factory argument.
 *
 * **Liveness contract.** The bag is built at runner-build time, but the runner it
 * feeds is *cached* (`ensureAgentRunner`): `runnerConfigKey` only watches the tool
 * set, model, sampling and plan phase, so a rebuilt-on-change field would hand
 * middleware a stale reference for the life of the cache. Two groups, and the split
 * is the point of this note:
 *
 * - **Plain fields** are safe to capture because they are assigned exactly once
 *   during construction and never replaced — the `ManagedAgent` collaborators
 *   (`usage`, `memory`, `session`, …), plus `config` and the immutable `parentId`.
 * - **`getX()` accessors** are required for anything that can outlive the build:
 *   the log sink, the models.dev lookup that lands after the first turn, and all
 *   conversation state. Reading these as fields is the bug this shape prevents.
 *
 * Mutation is deliberately out of scope: `setLog` / `setModelInfo` stay on the agent,
 * which is what keeps the dependency one-way.
 *
 * Scope is the runner's needs, not "everything on `ManagedAgent`": `managed.tools`
 * stays out because it is read once inside {@link runnerConfigKey} — the cache key
 * itself — where a live accessor would be meaningless.
 */
export interface AgentRunDeps {
  agentId: string;
  manager: AgentManager;
  usage: UsageTracker;
  session: SessionService;
  usageHistory: UsageHistoryService;
  statusController: AgentStatusController;
  /** Compaction ownership (leases, status, start/complete/error events). */
  compactions: CompactionController;
  approvals: ToolApprovalTable;
  run: RunCoordinator;
  /** Shared `tool:before:*` ledger: pipeline and middleware must emit once per call. */
  getToolBeforeHooks: () => ToolBeforeHookLedger;
  /** The mode read surface; read live because a phase flip must reach a cached runner. */
  getModeState: () => ModeState;
  /** The same facts authorization sees; the offered tool list is a projection of them. */
  getPolicyFacts: () => AgentPolicyFacts;
  /** Agent-local tool presentation, for plan-mode policy decisions. */
  resolveToolPresentation: (name: string) => ToolPresentation | undefined;
  /**
   * Whether a tool's calls are approval-gated (read live: an extension can add or shadow the tool
   * while the cached runner stays alive). Used by the extensions middleware to refuse an argument
   * rewrite after the approval was decided on the original input.
   */
  isToolNeedsApproval: (toolName: string) => boolean;
  /**
   * Whether the LIVE implementation under this name is the seeded built-in (read live, same reason:
   * an extension may shadow a built-in while the cached runner stays alive). Read by the task
   * prefork, extension and plan-mode middlewares — name equality alone would treat a shadowing
   * extension tool as the built-in.
   */
  isBuiltinTool: (toolName: string) => boolean;
  getTodoManager: () => TodoManager | null;
  getExtensionRunner: () => ExtensionRunner | null;
  /** The agent's background-job registry (drained by the notification middleware). */
  getCommandService: () => AgentCommandService;
  /**
   * The agent's background-work facade — the one trunk behind both kinds. Read live, not captured: a
   * session switch drops the facade (`resetBackgroundWork`) while the cached runner stays alive, and a
   * captured reference would keep draining the previous session's queue.
   */
  getBackgroundWork: () => BackgroundWorkService;
  getCompactionConfig: () => CompactionConfig | null;
  getModelInfo: () => ModelInfo | null;
  getToolCompactCache: () => ToolCompactCache;
  getWireProjectionCache: () => WireProjectionCache;
  /**
   * Whether the restored transcript still holds `media://` refs hydration could not read.
   *
   * Live read, not a captured boolean: a restore can report misses while the cached runner stays
   * alive (mid-session switch), and `clearMessages` disarms it — either captured once would hand
   * `wire-recovery` a stale answer for the life of the cache.
   */
  hasUnhydratedMedia: () => boolean;
  getSystemPrompt: () => string | undefined;
  getFrozenSystemPrompt: () => string | undefined;
  /**
   * Normalised to `null` (its heaviest reader, `compaction`, matches `null`). The two
   * consumers that match `undefined` wrap this at their own call site rather than the
   * bag widening to `| null | undefined` — a union would be assignable to neither
   * narrow interface, forcing a cast in the assembly this refactor exists to remove.
   */
  getUIChannel: () => AgentUIChannel | null;
  /** Set-once stream hub used to end command previews when a tool settles. */
  streamHub: AgentStreamHub;
  /** Assigned once at construction, so capturing it cannot go stale. */
  config: Readonly<ManagedAgentConfig>;
  /** Immutable after construction. */
  parentId: string | undefined;
  /**
   * Workspace env for this run's tools/consumers — the owning runtime's resolved env, or the
   * ambient env for legacy single-instance hosts. Resolved once here (the composition point).
   */
  coreEnv: ResolvedCoreEnv;
  shouldTriggerAutoCompact: (messages?: ModelMessage[]) => boolean;
  /**
   * Persist the transcript when the trigger/fingerprint admits it. Returns the write's verdict
   * (undefined when skipped) so a caller that must not claim durability can await it.
   */
  shouldPersistUIMessage: (messages: TanStackUIMessage[], reason: "user-message") => void | Promise<boolean>;
  /** Force-persist the transcript (no fingerprint short-circuit) and report whether it landed. */
  persistUIMessagesNow: (messages: TanStackUIMessage[]) => Promise<boolean>;
  setIterationProgress: (state: AgentIterationState) => void;
  /**
   * Session identity from the same accessor the event envelope uses.
   *
   * Live read: a session switch can adopt a new id while the cached runner stays alive, and a
   * subagent resolves the parent session it was spawned in (not its agent id).
   */
  getEventSessionId: () => string | undefined;
  /**
   * Whether a session switch (unload → load) is admitted but not committed.
   *
   * Live read: background delivery must not write into the transcript a switch is about to target.
   */
  isSessionSwitching: () => boolean;
  getDynamicTurnContextSections: () => Promise<TurnContextSection[]>;
  /** Identity of the owning user turn (`null` outside a run), for per-turn facts like `firstOutput`. */
  getCurrentRunId: () => string | null;
}

/**
 * Build the complete {@link AgentRunDeps} surface for runner assembly.
 *
 * The collaborator fields are captured references, which is safe only because they are
 * set once at construction; everything that can change while the (cached) runner is alive
 * is exposed as an accessor instead. See the liveness contract on {@link AgentRunDeps}.
 *
 * **One module, one producer.** The interface and its factory shipped separately
 * (`agent-run-deps.ts` + `managed-agent-deps.ts`) while an earlier task moved the bag out of
 * `ManagedAgent`. It stayed split afterwards with no second producer and no consumer outside
 * `managers/` — the type is referenced only by this file, `run-agent.ts` and the gate that reads
 * `agent-run-deps.ts` as text. Two files, one topic, so they are one file: a reader asking
 * "what does the runner need, and where does it come from" gets both answers here, and a field
 * added to one half in isolation is no longer a possible mistake. The liveness split above is
 * real and stays; the file split was not.
 */
export function buildManagedAgentDeps(managed: ManagedAgent, manager: AgentManager): AgentRunDeps {
  return {
    agentId: managed.id,
    manager,
    usage: managed.usage,
    session: managed.session,
    usageHistory: managed.usageHistory,
    statusController: managed.statusController,
    compactions: managed.compactions,
    approvals: managed.getApprovals(),
    run: managed.run,
    getToolBeforeHooks: () => managed.getToolBeforeHooks(),
    getModeState: () => managed.getModeState(),
    getPolicyFacts: () => managed.getPolicyFacts(),
    resolveToolPresentation: (name) => managed.getToolPresentation(name),
    isToolNeedsApproval: (toolName) => managed.isToolNeedsApproval(toolName),
    isBuiltinTool: (toolName) => managed.isBuiltinTool(toolName),
    getTodoManager: () => managed.getTodoManager(),
    getExtensionRunner: () => managed.getExtensionRunner(),
    getCommandService: () => managed.getCommandService(),
    getBackgroundWork: () => managed.getBackgroundWork(),
    getCompactionConfig: () => managed.getCompactionConfig(),
    getModelInfo: () => managed.getModelInfo(),
    getToolCompactCache: () => managed.getToolCompactCache(),
    getWireProjectionCache: () => managed.getWireProjectionCache(),
    hasUnhydratedMedia: () => managed.hasUnhydratedMedia(),
    getSystemPrompt: () => managed.getSystemPrompt(),
    getFrozenSystemPrompt: () => managed.getFrozenSystemPrompt(),
    getUIChannel: () => managed.getUI() ?? null,
    streamHub: managed.getStreamHub(),
    config: managed.config,
    parentId: managed.parentId,
    coreEnv: managed.runtime?.env ?? getEnv(),
    shouldTriggerAutoCompact: (messages) => managed.shouldTriggerAutoCompact(messages),
    shouldPersistUIMessage: (messages, reason) => managed.maybeSaveSessionUIMessages(messages, reason),
    persistUIMessagesNow: (messages) => managed.persistSessionUIMessagesNow(messages),
    setIterationProgress: (state) => managed.setIterationProgress(state),
    getEventSessionId: () => managed.getEventSessionId(),
    isSessionSwitching: () => managed.isSessionSwitching(),
    getDynamicTurnContextSections: () => managed.getDynamicTurnContextSections(),
    getCurrentRunId: () => managed.getCurrentRunId(),
  };
}
