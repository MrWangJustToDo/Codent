/* eslint-disable max-lines -- composition root; the justification is in the file header. */
/**
 * # ManagedAgent
 *
 * ## Why this file exceeds the 400-line rule (`.cursor/rules/040`)
 *
 * This is the **composition root** for one live agent: it owns the object graph
 * (services, controllers, channel, caches) and the identity/lifecycle state that
 * every other module reads through a host interface. The file is long because the
 * graph is wide, not because one responsibility is sprawling — and the graph is
 * wide because splitting it further would mean either duplicating the accessors or
 * introducing a second placeholder for most of them.
 *
 * Concretely, four questions a reviewer should ask before adding to this file:
 *
 * 1. **Is it a field cluster with one invariant?** Then it belongs in its own
 *    module behind a host interface, and this file only delegates.
 *    `run-coordinator.ts` (run id / abort / timing), `managed-agent-runner-wiring.ts`
 *    (runner cache + adapter + UI channel, where "change the tools without dropping
 *    the cached runner" must be unexpressible), `managed-agent-compact.ts`,
 *    `managed-agent-session.ts`, `managed-agent-plan.ts` and
 *    `managed-agent-run-lifecycle.ts` all exist for this reason.
 * 2. **Is it pure computation over inputs?** Then it belongs in `agent/**` (e.g.
 *    `agent/turn-context/*`, `agent/compaction/*`) — this file should call it, not
 *    contain it.
 * 3. **Is it a middleware/host seam?** Then it is a `getXxx: () => ...` accessor, and
 *    the implementation moves to the seam's consumer.
 * 4. **Is it policy that reads and writes this same object graph?** Then it stays
 *    here for now. This is the honest limit of the split: the remaining ~610-line
 *    "Config & resources" region and ~245-line "Status & events" region are not
 *    field moves, they *are* the graph's mutation surface. Extracting them means
 *    moving policy and re-validating concurrency behaviour — tracked as P1-15 in
 *    `openspec/changes/core-structure-convergence/architecture-debt-tracker.md`.
 *
 * The disable above is deliberately unexplained-by-default in the linter and
 * justified here instead, because the previous one carried no justification at all
 * — which is how this file was marked "done" in the tracker at 514 lines and never
 * revisited at 1750.
 *
 * ## Accessor convention
 *
 * Reads are `getXxx()` / `setXxx()`; no property getters (see
 * `scripts/validate-accessor-convention.mjs`).
 */
import {
  convertMessagesToModelMessages,
  type LazyToolsConfig,
  type ModelMessage,
  type UIMessage as TanStackUIMessage,
} from "@tanstack/ai";

import { registerActiveAgentLog, unregisterActiveAgentLog } from "../agent/agent-log";
import { AutoModeController } from "../agent/approval/auto-mode-controller.js";
import { buildAutoModePrompt } from "../agent/approval/auto-mode-prompt.js";
import { ToolApprovalTable } from "../agent/approval/tool-approval-table.js";
import { keepPolicyProjectionOptions, resolveKeepPolicy } from "../agent/compaction/keep-policy.js";
import { getModelVisibleMessages } from "../agent/compaction/message-chain-projection.js";
import { ToolCompactCache } from "../agent/compaction/tool-compact/tool-compact-cache.js";
import { WireProjectionCache } from "../agent/compaction/wire-projection-cache.js";
import { projectWireFromChannel } from "../agent/compaction/wire-projection.js";
import { statusTransitionLogLevel } from "../agent/log/status-transition-log.js";
import { logSubagentLifecycle } from "../agent/log/subagent-log-mirror.js";
import {
  createSessionSyncTracker,
  type SessionSaveReason,
  type SessionSyncTracker,
} from "../agent/persistence/session-sync-tracker.js";
import { AGENT_LOG_DIR, type SessionData } from "../agent/persistence/types.js";
import { PlanModeController } from "../agent/plan/plan-mode-controller.js";
import { buildModeInactivePrompt, buildPlanModePrompt } from "../agent/plan/plan-prompts.js";
import { collectPendingApprovals, collectPendingAskUser } from "../agent/stream/tool-phase-utils.js";
import { SummaryStreamHub } from "../agent/summary-stream/summary-stream-hub.js";
import { describeToolPresentations } from "../agent/tools/presentation/registry.js";
import { registerStreamingEventBus } from "../agent/tools/util/streaming-callback.js";
import { getCurrentDate, getGitInfo } from "../agent/turn-context/env-context.js";
import {
  formatInstructionContextSection,
  instructionStateChanged,
  loadLatestInstructionContent,
  readInstructionContextState,
  type InstructionContextState,
} from "../agent/turn-context/instruction-context.js";
import { formatSessionRetrievalSection, hasSessionHistory } from "../agent/turn-context/session-retrieval.js";
import { type TurnContextSection } from "../agent/turn-context/turn-context-message.js";
import { generateId } from "../utils/generate-id.js";

import { AgentConfigSchema, DEFAULT_AGENT_MAX_ITERATIONS } from "./agent-types.js";
import { AgentChatController } from "./controllers/agent-chat-controller.js";
import { createAgentStatusController, type AgentStatusController } from "./controllers/agent-status-controller.js";
import { handleManagedReactiveCompact, runManualCompact } from "./managed-agent-compact.js";
import {
  beginPlanExecution as beginPlanExecutionHelper,
  cancelPlanExecution as cancelPlanExecutionHelper,
  completePlan as completePlanHelper,
  disablePlanMode as disablePlanModeHelper,
  enablePlanMode as enablePlanModeHelper,
  getPlanModeState as getPlanModeStateHelper,
  listWorkspacePlans as listWorkspacePlansHelper,
  loadPlanFromWorkspace as loadPlanFromWorkspaceHelper,
  savePlanToWorkspace as savePlanToWorkspaceHelper,
} from "./managed-agent-plan.js";
import { buildTurnContextSections, buildFrozenSystemPrompt } from "./managed-agent-prompt.js";
import {
  abortManagedAgentRun,
  finalizeManagedAgentRun,
  prepareManagedAgentForRun,
} from "./managed-agent-run-lifecycle.js";
import { RunnerWiring } from "./managed-agent-runner-wiring.js";
import {
  getSessionPersistInput,
  persistSessionModelState,
  restoreManagedSession,
  saveSessionUIMessages as saveSessionUIMessagesHelper,
} from "./managed-agent-session.js";
import { RunCoordinator } from "./run-coordinator.js";
import { CompactionService } from "./services/compaction-service.js";
import { ExtensionRegistryService } from "./services/extension-registry-service.js";
import { MemoryService } from "./services/memory-service.js";
import { SessionService } from "./services/session-service.js";
import { UsageHistoryService } from "./services/usage-history-service.js";
import { emitAgentTelemetry } from "./telemetry/emit-agent-telemetry.js";
import { UsageTracker } from "./telemetry/usage-tracker.js";

import type { AgentManager } from "./agent-manager.js";
import type { AgentConfig, AgentStatus, RunFinalizeReason } from "./agent-types.js";
import type { AgentEvent, AgentEventBus } from "../agent/agent-event-bus";
import type { AgentLog } from "../agent/agent-log";
import type { CodeModeExtensionConfig } from "../agent/code-mode";
import type { CompactionConfig, CompactionConfigInput } from "../agent/compaction/types.js";
import type { DispatchRank } from "../agent/dispatch-order.js";
import type {
  ExtensionCommand,
  ExtensionFactory,
  ExtensionLoader,
  ExtensionRunner,
  ExtensionToolDefinition,
} from "../agent/extension";
import type { ExtensionTurnContextSection } from "../agent/extension/types.js";
import type { SubagentLifecyclePhase, SubagentLogDetails } from "../agent/log/subagent-log-mirror.js";
import type { LspExtensionConfig } from "../agent/lsp";
import type { McpExtensionConfig } from "../agent/mcp";
import type { McpManager } from "../agent/mcp/manager.js";
import type { MemoryExtensionConfig } from "../agent/memory";
import type { MemoryManager } from "../agent/memory/memory-manager.js";
import type { SessionStore } from "../agent/persistence/session-store.js";
import type { BeginPlanExecutionResult, PlanModeState } from "../agent/plan/plan-mode-controller.js";
import type { AgentRunner } from "../agent/runner/agent-runner.js";
import type { SkillRegistry, SkillsExtensionConfig } from "../agent/skills";
import type { TodoManager } from "../agent/todo";
import type { ToolsRecord } from "../agent/tools/runtime/tools-record.js";
import type { AgentToolConfig } from "../agent/tools/tool-config.js";
import type { AgentUIChannel } from "../agent/ui-channel.js";
import type { TextAdapterConfig } from "../models/adapter/adapter-factory.js";
import type { ModelStyle } from "../models/config/model-config.js";
import type { ModelInfo } from "../models/types.js";
import type { AgentEventPayloadMap } from "../runtime-types/agent-event-payloads.js";
import type { AgentEventType } from "../runtime-types/agent-events.js";
import type { AgentRetryState } from "../runtime-types/agent-retry.js";
import type {
  AgentIterationState,
  AgentL1State,
  AgentMode,
  SessionInteractionsSnapshot,
} from "../runtime-types/session-payloads.js";

// ============================================================================
// Config
// ============================================================================

/** When the turn context payload hasn't changed, re-admit every N messages to keep context fresh. */
export type { RunFinalizeReason } from "./agent-types.js";

export type { AgentL1State, AgentMode } from "../runtime-types/session-payloads.js";

export type ManagedAgentConfig<T = ManagedAgent> = AgentConfig & {
  id?: string;
  name: string;
  modelInfo?: ModelInfo;
  modelStyle?: ModelStyle;
  modelBaseURL?: string;
  modelApiKey?: string;
  setUp?: (instance: T) => T;
  /**
   * Additional skill directories to scan (before defaults). Relative paths resolve
   * against CoreEnv `rootPath`. When unset, defaults to `AGENT_SKILL_DIRS`,
   * `~/.agents/skills`, and `.agents/skills`. e.g. add `.cursor/skills` or
   * `.opencode/skills` to reuse skills written for other harnesses.
   */
  skillDirs?: string[];
  compaction?: CompactionConfigInput;
  mcpConfigPath?: string;
  /**
   * Pre-resolved on-disk session id to adopt at bootstrap (before the session
   * log sink attaches), so a reused/resumed session's id is fixed from the
   * start. The full restore is still performed by the caller via
   * {@link ManagedAgent.restoreSession}. Root agents only.
   */
  initialSessionId?: string;
  agentDocFilenames?: string[];
  agentDocLoadOverride?: boolean;
  /**
   * Custom tools for subagents. When set, `spawnSubagent` will use these
   * instead of the default subagent tools. Pass `null` to clear all tools,
   * or omit to use the default read-only + web subagent tools.
   */
  subagentTools?: ToolsRecord | null;
  /**
   * Programmatic extension factories to load on bootstrap.
   * Each factory is called during agent initialization.
   */
  extensions?: Array<ExtensionFactory>;
  /**
   * Enable the built-in LSP extension (default: true). Set to `false` to disable
   * LSP tools (lsp_diagnostics, lsp_hover, ...) and slash commands. Pass an
   * object to fine-tune which tools are registered (see {@link LspExtensionConfig}).
   */
  lsp?: boolean | LspExtensionConfig;
  /**
   * Enable the built-in Skills extension (default: true). Set to `false` to disable
   * skill tools (list_skills, load_skill) and the available-skills index in turn
   * context. Pass an object to fine-tune behavior (see {@link SkillsExtensionConfig}).
   */
  skills?: boolean | SkillsExtensionConfig;
  /**
   * Enable the built-in Memory extension (default: true). Set to `false` to disable
   * memory tools (memory_list, memory_read, memory_write) and the memory index in
   * turn context. Pass an object to fine-tune behavior (see {@link MemoryExtensionConfig}).
   */
  memory?: boolean | MemoryExtensionConfig;
  /**
   * Enable the built-in MCP extension (default: true). Set to `false` to disable
   * MCP servers and their `mcp__<server>_<tool>` tools. Pass an object to fine-tune
   * behavior (see {@link McpExtensionConfig}).
   */
  mcp?: boolean | McpExtensionConfig;
  /**
   * Enable the built-in Code Mode extension (default: true). Set to `false` to
   * disable sandboxed TypeScript execution (`execute_typescript`). Pass an object
   * to fine-tune the exposed `external_*` tool subset and lazy behavior (see
   * {@link CodeModeExtensionConfig}). The extension degrades gracefully when the
   * host does not provide a `createIsolateDriver` capability.
   */
  codeMode?: boolean | CodeModeExtensionConfig;
  /**
   * Tune lazy-tool discovery for top-level tools marked `lazy: true` (how much of
   * each lazy tool's description appears in the pre-discovery catalog). Defaults
   * to `{ includeDescription: 'none' }`. Only relevant when some tool is lazy.
   */
  lazyToolsConfig?: LazyToolsConfig;
  /**
   * Extra filesystem directories to scan for extensions (before env / defaults).
   * Relative paths resolve against CoreEnv `rootPath`.
   */
  extensionDirs?: string[];
  /** Explicit tool secrets / prefs (hosts pass; tools must not dig CoreEnv env bags). */
  toolConfig?: AgentToolConfig;
};

/** Subagent preview / non-useChat UI channel (TanStack StreamProcessor). */
export type AgentUIChannelRef = Pick<
  AgentUIChannel,
  "getMessages" | "subscribeCustomEvents" | "subscribeApprovalRequests"
>;

// ============================================================================
// ManagedAgent — composition root
// ============================================================================

/**
 * Central runtime object. Owns composed services and orchestrates cross-service calls.
 * Individual services ({@link MemoryService}, {@link SessionService}, {@link RunCoordinator})
 * hold only their own state; they never reference each other.
 */
export class ManagedAgent {
  // ============================================================================
  // Identity
  // ============================================================================

  readonly id: string;
  name: string;
  /**
   * Single source of truth for agent configuration (AgentConfig fields + agent
   * extras like name/id/modelInfo/skillDirs). Validated through
   * {@link AgentConfigSchema} at construction; mutated in place by
   * {@link updateConfig} so all runtime readers (`run-agent`, snapshots) see
   * updates immediately.
   */
  readonly config: ManagedAgentConfig;

  // ============================================================================
  // L1 state + local emitter
  // ============================================================================

  /** Lifecycle — hosts read via getter; mutate through {@link setStatus}. */
  private currentStatus: AgentStatus;
  private error: string;
  /** Tools awaiting user approval in the current run (set by approval middleware). */
  private pendingApprovalCount: number;
  /** Agent-loop progress for the current run; null until the first iteration. */
  private iterationState: AgentIterationState | null = null;
  /** Live LLM retry visibility (set by stream recovery; cleared when the stream recovers). */
  private retryInfo: AgentRetryState | null = null;

  // ============================================================================
  // Composed services / controllers
  // ============================================================================

  /** Composed services — each owns only its domain state */
  readonly usage: UsageTracker;
  readonly memory: MemoryService;
  readonly session: SessionService;
  /** Global (cross-session) LLM usage persistence — contribution-graph source. */
  readonly usageHistory: UsageHistoryService;
  readonly run: RunCoordinator;
  readonly statusController: AgentStatusController;
  /** Plan mode (read-only planning → execute). Root agents only; subagents leave phase off. */
  readonly planMode: PlanModeController;
  /** Auto / YOLO mode — skip all tool approvals. Cleared on reset / `/clear`. */
  readonly autoMode: AutoModeController;
  /** Session-backed tool-approval interrupt table. */
  readonly approvals: ToolApprovalTable;

  // ============================================================================
  // Tools / registries / extensions
  // ============================================================================

  tools: ToolsRecord;
  log: AgentLog;
  /** Detach handle for the active log sink (lets a rebind or teardown dispose it). */
  private logSinkDetach: (() => void) | null = null;
  /** Extension / tool / integration registration domain (todo, MCP, skills, extensions). */
  readonly extensions: ExtensionRegistryService;

  // ============================================================================
  // Agent tree + timestamps
  // ============================================================================

  parentId?: string;
  parentTaskId?: string;
  childIds: string[];
  createdAt: number;
  updatedAt: number;

  // ============================================================================
  // Run / UI / model wiring
  // ============================================================================

  /**
   * Runner cache + text adapter + UI channel, as one cluster: the cached
   * {@link AgentRunner} is only valid for the config it was built from, so the
   * cache and its invalidation rule live together (see
   * `managed-agent-runner-wiring.ts`).
   */
  private readonly runnerWiring: RunnerWiring;

  /** Package-internal TanStack runner wiring — not part of the host-facing surface. */
  resolveTextAdapter?: () => Promise<TextAdapterConfig | null>;
  /** Task / compact summary streams for the session `summary` channel. */
  readonly summaryStreams: SummaryStreamHub;
  private chatController?: AgentChatController;
  /** Set by AgentManager to route events to listeners. */
  dispatchEvent?: (event: AgentEvent) => void;
  /** Scoped unified event bus for this agent (set by the factory). */
  private eventBus?: AgentEventBus;
  /** Owning manager — set when registered via {@link AgentManager.createManagedAgent}. */
  manager?: AgentManager;
  modelInfo: ModelInfo | null;

  // ============================================================================
  // Compaction / session sync
  // ============================================================================

  readonly compaction: CompactionService;
  /** Shared channel → wire projection cache (see `getWireProjectionCache`). */
  private wireProjectionCache: WireProjectionCache | null = null;
  readonly toolCompactCache: ToolCompactCache;
  readonly sessionSyncTracker: SessionSyncTracker;

  // ============================================================================
  // Run lifecycle flags + timing
  // ============================================================================

  // Run lifecycle flags/timing moved to RunCoordinator (this.run) — methods below delegate.

  // ============================================================================
  // Prompt / turn context
  // ============================================================================

  private systemPrompt: string;
  agentDocContent: string;
  agentDocSource: string;
  private frozenSystemPrompt: string | undefined;
  private systemPromptFrozen: boolean;
  /** Pending per-extension turn-context sections collected in prepareForRun (before injection). */
  private pendingExtensionTurnContextSections: ExtensionTurnContextSection[] | undefined;
  /** Latest admitted hash per section kind (restore-seeded; only changed kinds re-admit). */
  private lastAdmittedTurnContextHashes: Map<string, string> | undefined;
  /** Message count at the last context admit (for periodic refresh; state owned by turn-context middleware). */
  private turnContextAdmitMessageCount: number;
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

  constructor(
    config: ManagedAgentConfig,
    init: {
      id?: string;
      log: AgentLog;
      tools: ToolsRecord;
      todoManager: TodoManager | null;
      parentId?: string;
      usage?: UsageTracker;
      memory?: MemoryService;
      session?: SessionService;
      usageHistory?: UsageHistoryService;
      compaction?: CompactionService;
    }
  ) {
    this.id = init.id ?? config.id ?? generateId("agent");
    // Runner cache / adapter / UI channel are one cluster (see managed-agent-runner-wiring.ts).
    this.runnerWiring = new RunnerWiring({
      getEventBus: () => this.eventBus,
      onApprovalRequest: (request) => {
        this.approvals.upsert({
          id: request.approvalId!,
          toolCallId: request.toolCallId!,
          status: "pending",
        });
      },
    });
    this.name = config.name;
    // Single source of truth: shallow-copy the agent extras, then overlay the
    // zod-parsed AgentConfig subset (validation + defaults, e.g. maxIterations).
    this.config = { ...config, ...AgentConfigSchema.parse(config) };
    this.log = init.log;
    this.tools = init.tools;
    // Always its own service, never injectable. It holds per-agent state that cannot be shared:
    // the agent's `tools` record (written straight into by `registerTool`), a single
    // `ExtensionRunner` slot, and the MCP / todo / managed-tools providers. Two agents sharing
    // one would overwrite each other's tool objects and handlers, not just their presentation
    // descriptors — and the owner-id scoping applied at this boundary cannot help, because the
    // later agent's `setExtensionRunner` replaces the first agent's runner outright. Keeping it
    // un-injectable makes "one registry per agent" unexpressible rather than merely conventional.
    this.extensions = new ExtensionRegistryService();
    if (init.todoManager) this.extensions.setTodoManager(init.todoManager);
    this.parentId = init.parentId;
    this.usage = init.usage ?? new UsageTracker();
    this.memory = init.memory ?? new MemoryService();
    this.session = init.session ?? new SessionService();
    this.usageHistory = init.usageHistory ?? new UsageHistoryService();
    this.run = new RunCoordinator();
    this.childIds = [];
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.extensions.setManagedToolsProvider(() => this.tools);
    this.statusController = createAgentStatusController({
      getStatus: () => this.getStatus(),
      setStatus: (status, trigger) => this.setStatus(status, trigger),
      getError: () => this.error,
      setError: (error) => this.setError(error),
      setPendingApprovalCount: (count) => this.setPendingApprovalCount(count),
      emitEvent: (type, data) => this.emitEvent(type, data),
    });

    this.planMode = new PlanModeController({
      getTodoManager: () => this.getTodoManager(),
      onPhaseChange: () => {
        this.invalidateRunner();
        this.emitStateChange();
      },
    });
    // A mode switch is session state (autoMode is persisted with every save), so
    // emit it live AND persist: otherwise a toggle that is not followed by another
    // turn/state change is lost on the next launch.
    this.autoMode = new AutoModeController(() => {
      this.emitStateChange();
      this.persistSession();
    });
    this.approvals = new ToolApprovalTable({
      onResolved: (resolution) => {
        this.emitEvent("agent:tool-approval-resolved", {
          tool_call_id: resolution.toolCallId,
          approval_id: resolution.approvalId,
          tool_name: resolution.toolName,
          decision: resolution.decision,
          ...(resolution.reason ? { reason: resolution.reason } : {}),
        });
      },
    });

    // ============================================================================
    // L1 state + local emitter (inline inits)
    // ============================================================================
    this.currentStatus = "idle";
    this.error = "";
    this.pendingApprovalCount = 0;

    // ====================================================================================
    // (Tools / registries / extensions init moved into ExtensionRegistryService)
    // ====================================================================================

    // ============================================================================
    // Run / UI / model wiring (inline inits)
    // ============================================================================
    this.summaryStreams = new SummaryStreamHub();
    this.modelInfo = null;

    // ============================================================================
    // Compaction / session sync (inline inits)
    // ============================================================================
    this.compaction = init.compaction ?? new CompactionService();
    this.toolCompactCache = new ToolCompactCache();
    this.sessionSyncTracker = createSessionSyncTracker();

    // ============================================================================
    // (Run lifecycle flags + timing inits moved into RunCoordinator)
    // ============================================================================

    // ============================================================================
    // Prompt / turn context (inline inits)
    // ============================================================================
    this.systemPrompt = "";
    this.agentDocContent = "";
    this.agentDocSource = "";
    this.systemPromptFrozen = false;
    this.lastAdmittedTurnContextHashes = undefined;
    this.turnContextAdmitMessageCount = 0;
    this.instructionContextState = undefined;
    this.instructionContextActive = false;

    if (config.setUp) {
      return config.setUp(this);
    }

    return this;
  }

  // ============================================================================
  // Status & events
  // ============================================================================

  /** Host-facing status (read-only; use {@link setStatus} to mutate). */
  getStatus(): AgentStatus {
    return this.currentStatus;
  }

  /** Host-facing UI channel when present (read-only; package-internal {@link setUIChannel}). */
  getUI(): AgentUIChannel | undefined {
    return this.runnerWiring.getUI();
  }

  getError(): string {
    return this.error;
  }

  getPendingApprovalCount(): number {
    return this.pendingApprovalCount;
  }

  getStreamStartedAt(): number {
    return this.run.getStreamStartedAt();
  }

  setStreamStartedAt(value: number): void {
    this.run.setStreamStartedAt(value);
  }

  getLastStreamDurationMs(): number {
    return this.run.getLastStreamDurationMs();
  }

  /**
   * Record a subagent lifecycle line in the PARENT agent's own log.
   *
   * Every subagent event is delivered to the subagent's own file (the log bridge scopes
   * by `event.agentId`), so a `task` call's children are invisible in the parent log —
   * reconstructing which subagent belongs to which call needed cross-file timestamp
   * matching. The parent log is where a reader looks for the session's story, so the
   * child's lifecycle is mirrored here, attributed by call id and subagent id.
   *
   * Deliberately a direct write rather than a second bus event: the bus event already
   * exists and already has one destination, and "log this in my file" is not a fact
   * other consumers should react to. Subagents have no extension runner, so the mirror
   * has to be driven from this side anyway.
   */
  logSubagentLifecycle(phase: SubagentLifecyclePhase, details: SubagentLogDetails): void {
    logSubagentLifecycle(this.log, phase, details);
  }

  setStatus(status: AgentStatus, trigger?: string): void {
    const prev = this.currentStatus;
    if (status === "completed" || status === "aborted" || status === "error") {
      this.recordStreamDuration();
      // Terminal — any in-flight retry visibility is over.
      this.retryInfo = null;
    }
    this.currentStatus = status;
    // Timeline: log actual transitions only (no-op sets stay silent). Most transitions are
    // the pump's own bookkeeping, so the level follows the trigger — see
    // `statusTransitionLogLevel`. The set is still recorded either way; only its level moves.
    if (prev !== status) {
      const data = { from: prev, to: status, ...(trigger ? { trigger } : {}) };
      const message = `Status: ${prev} → ${status}`;
      if (statusTransitionLogLevel(status, trigger) === "debug") {
        this.log?.debug("agent", message, data);
      } else {
        this.log?.info("agent", message, data);
      }
    }
    this.emitStateChange();
  }

  /** Track the active run id for log run-scoping (see RunLifecycleHost). */
  setCurrentRunId(runId: string | null): void {
    this.run.setCurrentRunId(runId);
  }

  getCurrentRunId(): string | null {
    return this.run.getCurrentRunId();
  }

  /** Snapshot wall-clock duration for the current turn into lastStreamDurationMs. */
  recordStreamDuration(): void {
    this.run.recordStreamDuration();
  }

  setError(error: string): void {
    this.error = error;
    this.emitStateChange();
  }

  setPendingApprovalCount(count: number): void {
    this.pendingApprovalCount = count;
    this.emitStateChange();
  }

  getRetry(): AgentRetryState | null {
    return this.retryInfo;
  }

  /** @internal Used by stream recovery to surface retry progress to hosts. */
  setRetry(retry: AgentRetryState | null): void {
    this.retryInfo = retry;
    this.emitStateChange();
  }

  /**
   * App host API — pause agent status while a client tool (e.g. `ask_user`) waits for user input.
   * Core does not infer this from messages; the UI sets it when opening/closing client-tool flows.
   */
  setClientToolWaiting(active: boolean): void {
    this.statusController.setClientToolWaiting(active);
  }

  /** Sync approval / client-tool pause status from loaded UIMessages (e.g. session resume). */
  syncInteractionStateFromUIMessages(
    messages: TanStackUIMessage[],
    options?: { whenClear?: "idle" | "running" | "completed" }
  ): void {
    if (options?.whenClear === "running") {
      this.statusController.reconcileWithPolicy(messages, "during-run");
      return;
    }
    if (options?.whenClear === "completed") {
      this.statusController.reconcileWithPolicy(messages, "after-chat-run");
      return;
    }
    this.statusController.reconcileWithPolicy(messages, "idle-clear");
  }

  /** Reconcile status after a chat pump finishes. */
  syncRunStatusFromUIMessages(messages: TanStackUIMessage[]): void {
    this.statusController.applyRunOutcome({ kind: "finished", messages, path: "chat" });
  }

  /** L1 status snapshot for Emitter / Session projection. */
  /** Rename the display name and notify state-channel subscribers (session rename command). */
  setDisplayName(name: string): void {
    this.name = name;
    this.emitStateChange();
  }

  /**
   * Re-emit the L1 state snapshot. Call after swapping the on-disk session
   * (`session.resume` / `session.new`) so live subscribers observe the new
   * `sessionId` without waiting for the next unrelated state change.
   */
  refreshState(): void {
    this.emitStateChange();
  }

  getL1State(): AgentL1State {
    return {
      status: this.currentStatus,
      name: this.name,
      sessionId: this.getSessionData()?.id ?? null,
      error: this.error,
      pendingApprovalCount: this.pendingApprovalCount,
      ...(this.retryInfo ? { retry: this.retryInfo } : {}),
      model: this.config.model,
      modelInfo: this.modelInfo,
      reasoningEffort: this.config.reasoningEffort ?? null,
    };
  }

  /**
   * Pending approvals / `ask_user` derived from the current conversation.
   * Projected onto the retained `interaction` channel so hosts stop re-scanning
   * messages to discover what the agent is waiting on.
   */
  readInteractions(): SessionInteractionsSnapshot {
    const messages = this.getChatController()?.getMessages() ?? this.getUI()?.getMessages() ?? [];
    return {
      approvals: collectPendingApprovals(messages),
      askUser: collectPendingAskUser(messages),
    };
  }

  /** Current agent-loop progress (1-based iteration vs budget); `{current:0}` when idle. */
  readIteration(): AgentIterationState {
    return this.iterationState ?? { current: 0, max: this.config.maxIterations ?? DEFAULT_AGENT_MAX_ITERATIONS };
  }

  /**
   * Record the agent-loop iteration progress for the current run and project it
   * onto the retained `iteration` channel. Called by the lifecycle middleware at
   * each model-iteration boundary.
   * @internal
   */
  setIterationProgress(state: AgentIterationState): void {
    this.iterationState = state;
    this.eventBus?.emit("agent:iteration", state);
  }

  private emitStateChange(): void {
    // L1 state and mode flow exclusively through the scoped bus (`agent:state`
    // retained, `session:mode` projected) — see unified-agent-event-bus.
    this.eventBus?.emit("agent:state", this.getL1State());
    this.eventBus?.emit("session:mode", this.modeState());
    // Approvals / ask_user pause also surface through emitStateChange (status +
    // pending-count transitions), so keep the retained interaction snapshot fresh.
    this.eventBus?.emit("session:interaction", this.readInteractions());
  }

  emitEvent<T extends AgentEventType>(
    type: T,
    payload?: AgentEventPayloadMap[T],
    options?: { parentId?: string; agentId?: string }
  ): void {
    emitAgentTelemetry(this, type, payload, options);
  }

  /**
   * Attach this agent's scoped unified event bus and propagate it to owned
   * domain objects (session channel projections + retained values).
   * @internal Wired by `agent-factory` during construction.
   */
  setEventBus(bus: AgentEventBus): void {
    this.eventBus = bus;
    registerStreamingEventBus(this.id, bus);
    this.usage.setEventBus(bus);
    this.summaryStreams.setEventBus(bus);
    this.planMode.setEventBus(bus);
    this.getTodoManager()?.setEventBus(bus);
    this.chatController?.setEventBus(bus);
    bus.retain("agent:state", () => this.getL1State());
    bus.retain("session:mode", () => this.modeState());
    bus.retain("session:extensions", () => ({
      extensions: this.extensions.getExtensionRunner()?.getExtensionInfos() ?? [],
    }));
    bus.retain("session:tool-presentation", () => ({ descriptors: describeToolPresentations() }));
    bus.retain("session:mcp", () => ({ servers: this.getMcpManager()?.getServerStatuses() ?? [] }));
    bus.retain("session:interaction", () => this.readInteractions());
    bus.retain("agent:iteration", () => this.readIteration());
    // Route telemetry through this agent's scoped bus (up-flows to the root
    // observer / Event→Log bridge) instead of the process-wide root bus.
    this.dispatchEvent = (event) => {
      bus.emit(event.type as never, event.payload as never, {
        agentId: event.agentId,
        ...(event.parentId !== undefined ? { parentId: event.parentId } : {}),
        ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      });
    };
  }

  /** @internal Scoped unified event bus (undefined before factory wiring). */
  getEventBus(): AgentEventBus | undefined {
    return this.eventBus;
  }

  /** Derived mode projection payload (plan phase + auto mode). */
  private modeState(): { mode: AgentMode; autoMode: boolean } {
    return { mode: this.getAgentMode(), autoMode: this.isAutoModeEnabled() };
  }

  getSessionData(): SessionData | null {
    return this.session.getSessionData();
  }

  /**
   * Ensure in-memory session data exists (allocates a stable `ses_` id without
   * writing to disk). See {@link SessionService.ensureSessionData}.
   */
  ensureSessionData(): SessionData | null {
    return this.session.ensureSessionData();
  }

  // ============================================================================
  // Config & resources
  // ============================================================================

  getConfig(): Readonly<AgentConfig> {
    return { ...this.config };
  }

  updateConfig(updates: Partial<AgentConfig>): void {
    // Mutate the single config object in place (AgentConfigSchema strips the
    // agent extras, so only the AgentConfig subset is overlaid).
    Object.assign(this.config, AgentConfigSchema.parse({ ...this.config, ...updates }));
  }

  /**
   * Adopt the model a resumed session was persisted with.
   *
   * No-op under remote-provider: there the provider server owns the model (see
   * {@link setModel}), so a local override would desync the connection. Also a no-op
   * when the persisted model already matches the live config.
   */
  applyPersistedModel(next: { model: string; modelStyle?: ModelStyle }): void {
    if (this.config.providerMode === "remote") return;
    const sameModel = next.model === this.config.model;
    const sameStyle = !next.modelStyle || next.modelStyle === this.config.modelStyle;
    if (sameModel && sameStyle) return;
    this.setModel({ model: next.model, ...(next.modelStyle ? { modelStyle: next.modelStyle } : {}) });
  }

  /** Current reasoning-effort level, or undefined when unset (model default). */
  getReasoningEffort(): AgentConfig["reasoningEffort"] {
    return this.config.reasoningEffort;
  }

  /**
   * Set the reasoning-effort level and invalidate the cached runner so the next
   * run rebuilds {@link AgentRunner} with the new `modelOptions`.
   */
  setReasoningEffort(effort: AgentConfig["reasoningEffort"]): void {
    this.updateConfig({ reasoningEffort: effort });
    this.invalidateRunner();
    this.persistSession();
    this.emitStateChange();
  }

  /** Replace the model metadata. Pass `null` to clear it (unknown model). */
  setModelInfo(info: ModelInfo | null): void {
    if (!info) {
      this.modelInfo = null;
      return;
    }
    this.log?.debug("agent", "Setting model info", {
      id: info.id,
      style: info.style,
      contextWindow: info.contextWindow,
    });
    this.modelInfo = info;
  }

  getModelInfo(): ModelInfo | null {
    return this.modelInfo;
  }

  /**
   * Switch the agent's model at runtime without rebuilding the session.
   *
   * Updates the frozen model config, drops the cached text adapter so the next
   * run resolves the new model, and persists — the conversation history and
   * live session are preserved. Only the provided fields are changed; omitted
   * ones keep their current value.
   *
   * NOTE: local provider mode only. Under remote-provider the server re-supplies
   * the model on the next (re)create, so callers should gate this on
   * `providerMode !== "remote"` (see resolve-from-provider.ts).
   */
  setModel(next: {
    model?: string;
    modelStyle?: ModelStyle;
    modelBaseURL?: string;
    modelApiKey?: string;
    modelInfo?: ModelInfo | null;
  }): void {
    const updates: Partial<AgentConfig> = {};
    if (next.model !== undefined) updates.model = next.model;
    if (next.modelStyle !== undefined) updates.modelStyle = next.modelStyle;
    if (next.modelBaseURL !== undefined) updates.modelBaseURL = next.modelBaseURL;
    if (next.modelApiKey !== undefined) updates.modelApiKey = next.modelApiKey;
    if (Object.keys(updates).length > 0) {
      this.updateConfig(updates);
    }

    if (next.modelInfo) {
      this.setModelInfo(next.modelInfo);
      if (next.modelInfo.pricing) {
        this.usage.setPricing(next.modelInfo.pricing);
      }
      this.usage.setCapabilities(next.modelInfo.capabilities);
    } else {
      // No metadata for the new model (unknown id / offline) means "unknown", not
      // "same as the previous model": keeping the old gate would strip media the
      // new model accepts (old `[]`) or send media it rejects (old `[vision]`).
      // `undefined` restores the permissive default.
      this.setModelInfo(null);
      this.usage.setCapabilities(undefined);
    }

    // Keep new on-disk sessions (`/clear`, session.new) on the switched model.
    if (updates.model !== undefined || updates.modelStyle !== undefined) {
      this.session.setModelConfig(updates.modelStyle ?? "openai", updates.model ?? "unknown");
    }

    // Drop the cached adapter + runner so the next run re-resolves the model.
    this.setTextAdapter(undefined);
    this.invalidateRunner();
    this.persistSession();
    this.emitStateChange();
  }

  /** Canonical model messages from the UI channel only. */
  getCanonicalFromUI(): ModelMessage[] {
    const uiMessages = this.getUI()?.getMessages() ?? [];
    if (uiMessages.length === 0) return [];
    return convertMessagesToModelMessages(uiMessages);
  }

  /**
   * Messages sent to the LLM after in-chain compaction summary projection.
   *
   * Projects through {@link projectWireFromChannel} — the **same** function the
   * compaction middleware uses per model call — so a manual `/compact`, a reactive
   * compact, or memory extraction sees exactly the window the model receives. Keeping
   * a second implementation here is what would let the two drift.
   */
  getMessagesForLLM(canon?: ModelMessage[]): ModelMessage[] {
    // An explicit base (a pre-projected chain) bypasses the channel entirely.
    if (canon) {
      return getModelVisibleMessages(
        canon,
        keepPolicyProjectionOptions(resolveKeepPolicy(this.compaction.getConfig() ?? {}, this.modelInfo?.contextWindow))
      );
    }

    const channel = this.getUI();
    if (!channel) return [];

    return projectWireFromChannel(
      channel,
      this.compaction.getConfig(),
      this.modelInfo?.contextWindow,
      this.getWireProjectionCache()
    );
  }

  /**
   * Wire-projection cache owned by the agent, so every projection site (middleware and
   * `getMessagesForLLM`) shares one cache and one fingerprint contract.
   */
  getWireProjectionCache(): WireProjectionCache {
    this.wireProjectionCache ??= new WireProjectionCache();
    return this.wireProjectionCache;
  }

  setLog(c: AgentLog): void {
    this.log = c;
  }

  getLog(): AgentLog {
    return this.log;
  }

  /**
   * Attach (or re-point) the session JSONL log sink to the current session id's
   * directory. Called once the session id is fixed at bootstrap, again after a
   * restore, and whenever the active session id changes — so logs follow the
   * reused/resumed session rather than the transient id allocated before restore.
   * No-op for subagents (they write an independent file into the parent's dir via
   * `spawnSubagent`).
   *
   * `sessionId` overrides the id taken from the session data, for the one caller that
   * knows the target before the restore has run: `restoreSession` binds ahead of
   * `restoreManagedSession`, so the restore's own `session:restore` entry lands in the
   * session being restored instead of the transient bootstrap dir.
   */
  bindSessionLogSink(sessionId?: string): void {
    if (this.parentId) return;
    const resolved = sessionId ?? this.getSessionData()?.id ?? this.id;
    const dir = `${AGENT_LOG_DIR}/${resolved}`;
    if (this.log.getFileSinkDir() === dir) return;
    this.logSinkDetach?.();
    // Bind through the built-in log extension (which tracks the sink for teardown); fall back to
    // the seam's own convenience attach for a standalone log with no manager.
    const options = { dir };
    this.logSinkDetach =
      this.manager?.getLogExtension()?.attachSink(this.log, options) ?? this.log.attachFileSink(options);
    // Track for the process-level crash/exit guards.
    registerActiveAgentLog(this.log);
  }

  /**
   * Record the release handle for a sink bound outside {@link bindSessionLogSink} — the subagent
   * path, where `spawnSubagent` owns the options (parent dir + `{subagentId}.log`) and core has to
   * defer release until that agent is destroyed.
   */
  setLogSinkDetach(detach: () => void): void {
    this.logSinkDetach?.();
    this.logSinkDetach = detach;
  }

  /**
   * Release the active log sink binding (registry entry + sink + seam), landing its buffered batch
   * first. Idempotent — the handle is cleared, so a second call is a no-op.
   *
   * Called from {@link flushLogOnDestroy} at the end of the teardown chain — *after* the
   * `session:shutdown` interception, which is how an extension lands its final work through
   * `ctx.logger`. Releasing earlier would send that write into the seam's retained buffer, where
   * nothing can drain it. Release (not just a flush) is required: the sink owns a periodic flush
   * timer, and leaving it armed after the agent is gone keeps writing into the session's log
   * directory — a leak in any runtime, and on Windows fatal to teardown, because a directory
   * cannot be removed while a handle is open in it (`rm` then fails with ENOTEMPTY).
   */
  detachLogSink(): void {
    const detach = this.logSinkDetach;
    this.logSinkDetach = null;
    detach?.();
  }

  /**
   * Land any buffered log entries synchronously and release the file sink. Called
   * from `destroyAgent`.
   */
  flushLogOnDestroy(): void {
    this.log.flushSync();
    this.detachLogSink();
    unregisterActiveAgentLog(this.log);
  }

  setTodoManager(t: TodoManager): void {
    this.extensions.setTodoManager(t);
  }

  getTodoManager(): TodoManager | null {
    return this.extensions.getTodoManager();
  }

  setMemoryManager(manager: MemoryManager): void {
    this.memory.setManager(manager);
  }

  getMemoryManager(): MemoryManager | null {
    return this.memory.getManager();
  }

  setSessionStore(store: SessionStore, sessionConfig: { modelStyle: string; model: string }): void {
    this.session.setStore(store, sessionConfig);
  }

  getSessionStore(): SessionStore | null {
    return this.session.getStore();
  }

  /**
   * Adopt session data for the *active* on-disk session.
   *
   * This is the single write point for "which session is active", so the log sink is
   * re-pointed here rather than at each caller: a resume and `/clear` both change the id
   * mid-process, and binding at the one place that records the change is what keeps the two
   * from drifting. Idempotent — same id rebinds to the same dir and returns.
   *
   * Skipped while `manager` is unset (factory construction): there the sink is bound by
   * `AgentManager.add`, which runs after the manager is attached so the binding is registered
   * with the log extension for teardown. Binding earlier would take the seam's fallback path and
   * leave a sink the extension does not know about.
   */
  setSessionData(data: SessionData): void {
    const previousId = this.getSessionData()?.id;
    this.session.setSessionData(data);
    if (this.manager && data.id && data.id !== previousId) this.bindSessionLogSink(data.id);
  }

  /**
   * Persist `uiMessages` when an explicit trigger fires and the fingerprint changed.
   * Reasons: `user-message` | `pump-complete` | `force` (via {@link saveSessionUIMessages}).
   * Fire-and-forget — dehydrate + disk write happen in the background.
   */
  maybeSaveSessionUIMessages(uiMessages: TanStackUIMessage[], reason: SessionSaveReason): void {
    if (uiMessages.length === 0) return;
    if (!this.sessionSyncTracker.shouldPersist(uiMessages, { reason })) {
      return;
    }
    void saveSessionUIMessagesHelper(this, uiMessages).catch((err) => this.reportBackgroundPersistError(err));
  }

  /**
   * Force-persist session `uiMessages` (slash commands such as `/clear`).
   * Fire-and-forget — dehydrate + disk write happen in the background.
   */
  saveSessionUIMessages(uiMessages: TanStackUIMessage[]): void {
    void saveSessionUIMessagesHelper(this, uiMessages).catch((err) => this.reportBackgroundPersistError(err));
  }

  /**
   * Persist an **empty** transcript as the session's content (`/clear`).
   *
   * `saveSessionUIMessages` refuses to write an empty array (`persistSession`
   * delegates to `store.save`, whose empty-list path also guards against wiping a
   * session), so clearing in memory left the messages on disk — and resuming
   * afterwards brought back the conversation the user had discarded. Here the
   * empty write is intentional: it is what "clear" means, and the store rewrites
   * the log to its empty form. The sync tracker is reset to empty so a later
   * persist is not deduped against the pre-clear fingerprint.
   */
  clearPersistedSession(): void {
    void this.session
      .persistSession(() => ({
        ...getSessionPersistInput(this),
        uiMessages: [],
        forceEmptyMessages: true,
      }))
      .then((persisted) => {
        if (persisted) this.sessionSyncTracker.reset([]);
      })
      .catch((err) => this.reportBackgroundPersistError(err));
  }

  /** Reset fingerprint tracking after restore, clear, or new chat bootstrap. */
  resetSessionSyncTracker(uiMessages?: TanStackUIMessage[]): void {
    this.sessionSyncTracker.reset(uiMessages);
  }

  /** Persist model state only (usage, todos). Does not write `uiMessages`. */
  persistSession(): void {
    void persistSessionModelState(this).catch((err) => this.reportBackgroundPersistError(err));
  }

  /**
   * Backstop for fire-and-forget persists. Without it a rejected persist (e.g. a
   * media/dehydrate IO error thrown outside `saveToStore`) becomes an unhandled
   * rejection — and there is no global `unhandledRejection` handler, so the host
   * process would crash. Surface it as `session:save-error` instead.
   */
  private reportBackgroundPersistError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.warn("system", "background session persist failed", { error: message });
    this.emitEvent("session:save-error", { target: "session+uiMessages", error: message });
  }

  /**
   * Finalize a user turn / detached run — persist session, clear turn memory, optionally extract memories, emit `agent:stop`.
   * Owned by {@link AgentChatController} / subagent runners (not per-`chat()` middleware).
   * Memory extraction runs only when `reason === "finished"`. Idempotent per turn until {@link resetTurnLifecycle}.
   */
  finalizeRun(reason: RunFinalizeReason): void {
    finalizeManagedAgentRun(this, reason);
  }

  /** Call at the start of a chat pump or detached run so finalize can run once for that turn. */
  resetTurnLifecycle(): void {
    this.run.resetTurnLifecycle();
  }

  /**
   * Claim turn finalization. @returns false when already finalized for this turn.
   * @internal Used by {@link finalizeManagedAgentRun}.
   */
  beginTurnFinalize(): boolean {
    return this.run.beginTurnFinalize();
  }

  setAgentDocContent(content: string, source?: string): void {
    this.agentDocContent = content;
    this.agentDocSource = source ?? "";
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
    this.sessionHistoryPresent = await hasSessionHistory();
  }

  getAgentDocContent(): string {
    return this.agentDocContent;
  }

  setSkillRegistry(t: SkillRegistry): void {
    this.extensions.setSkillRegistry(t);
  }

  getSkillRegistry(): SkillRegistry | null {
    return this.extensions.getSkillRegistry();
  }

  setMcpManager(m: McpManager): void {
    this.extensions.setMcpManager(m);
  }

  getMcpManager(): McpManager | null {
    return this.extensions.getMcpManager();
  }

  getExtensionRunner(): ExtensionRunner | null {
    return this.extensions.getExtensionRunner();
  }

  getExtensionLoader(): ExtensionLoader | null {
    return this.extensions.getExtensionLoader();
  }

  /**
   * Register a tool on THIS agent.
   *
   * `extensionId` (the caller's own id, defaulting to the agent id) is scoped to this agent
   * inside the registry. The same extension loaded onto two agents in one process produces the
   * same extension id twice, and the two entries must stay independent — they describe tools in
   * two different agents' tool sets, and a disable on one agent has to leave the other alone.
   */
  registerTool(def: ExtensionToolDefinition, extensionId = this.id, rank?: DispatchRank): void {
    this.extensions.registerTool(def, {
      tools: this.tools,
      ownerId: this.scopedOwnerId(extensionId),
      warn: (message) => this.log?.warn("system", message),
      onToolsChanged: () => this.setRunnerConfigKey(undefined),
      agentId: this.id,
      rank,
    });
  }

  registerCommand(cmd: ExtensionCommand): void {
    this.extensions.registerCommand(cmd, (message) => this.log?.warn("system", message));
  }

  /**
   * Unregister a tool previously added by an extension (used when disabling).
   *
   * Removes this owner's entries for the name and re-derives what is live, so whatever the name
   * meant before the extension loaded comes back — an earlier extension's tool, or the built-in
   * it shadowed. One code path covers both "this extension owned it" and "this extension was
   * buried under a newer one", which is why the runner needs no ownership test of its own.
   */
  unregisterExtensionTool(name: string, extensionId = this.id): void {
    this.extensions.unregisterExtensionTool(name, {
      tools: this.tools,
      ownerId: this.scopedOwnerId(extensionId),
      warn: (message) => this.log?.warn("system", message),
      onToolsChanged: () => this.setRunnerConfigKey(undefined),
    });
    this.emitToolPresentationCatalog();
  }

  /**
   * Namespace an extension owner id to this agent.
   *
   * The tool and presentation registries are process-global while an agent's tools are its own,
   * so a bare extension id is not a unique owner: two agents loading the same extension share it,
   * and a disable on one would release the other's claim. Scoping the id here is what keeps the
   * two apart, and it is needed for the paths where no extension is involved either — the
   * `defineServerTool` default owner (the tool name, `createTools()` re-run per agent) collides
   * the same way, breaking the descriptor of every agent's `read_file` but the last created.
   *
   * `:` separates the two halves; a generated agent id is unique per agent, so the scoped id is
   * too. Owner ids are matched by string equality only — nothing parses them back apart.
   */
  private scopedOwnerId(extensionId: string): string {
    return `${this.id}:${extensionId}`;
  }

  /** Publish the current presentation catalog (tool set changed). */
  private emitToolPresentationCatalog(): void {
    this.getEventBus()?.emit("session:tool-presentation", { descriptors: describeToolPresentations() });
  }

  /** Unregister a command previously added by an extension (used when disabling). */
  unregisterExtensionCommand(name: string): void {
    this.extensions.unregisterExtensionCommand(name);
  }

  getExtensionCommands(): ExtensionCommand[] {
    return this.extensions.getExtensionCommands();
  }

  setCompactionConfig(config: CompactionConfig): void {
    this.log?.debug("agent", "Setting compaction config", {
      tokenThreshold: config.tokenThreshold,
    });
    this.compaction.setConfig(config);
    this.usage.setTokenLimit(config.tokenThreshold);
  }

  getCompactionConfig(): CompactionConfig | null {
    return this.compaction.getConfig();
  }

  getToolCompactCache(): ToolCompactCache {
    return this.toolCompactCache;
  }

  getSystemPrompt(): string | undefined {
    if (this.systemPromptFrozen) return this.frozenSystemPrompt;
    this.frozenSystemPrompt = buildFrozenSystemPrompt({
      config: this.config,
      agentDocContent: this.agentDocContent,
    });
    this.systemPromptFrozen = true;
    this.systemPrompt = this.frozenSystemPrompt ?? "";
    return this.frozenSystemPrompt;
  }

  /** Alias for the cacheable system prompt prefix (before per-turn dynamic segment). */
  getFrozenSystemPrompt(): string | undefined {
    return this.getSystemPrompt();
  }

  // --- Turn-context admission state (owned here, mutated by turn-context middleware). ---

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

    const runner = this.extensions.getExtensionRunner();
    if (!runner) return;

    const collected = await runner.collectBeforeAgentStart(prompt, this.id);
    this.pendingExtensionTurnContextSections = collected.turnContextSections;

    this.emitEvent("prompt:before", {
      prompt,
      hasTurnContext: Boolean(collected.turnContextSections?.length),
    });
  }

  /** After compaction / clear — force the next turn to re-admit full dynamic context. */
  resetAdmittedTurnContext(): void {
    this.lastAdmittedTurnContextHashes = undefined;
    this.turnContextAdmitMessageCount = 0;
    this.instructionContextState = undefined;
    this.instructionContextActive = false;
  }

  clearTurnContext(): void {
    this.memory.clearTurnContext();
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
    this.invalidateRunner();
  }

  /** Build the ordered dynamic turn-context sections for the current user turn. */
  async getDynamicTurnContextSections(): Promise<TurnContextSection[]> {
    let todoNagReminder: string | undefined;
    if (this.getTodoManager()?.shouldNag()) {
      todoNagReminder = this.getTodoManager()!.getNagReminder(this.getTodoManager()!.getRoundsSinceUpdate());
      this.log?.debug("todo", "Capturing nag reminder in turn context snapshot", {
        roundsSinceUpdate: this.getTodoManager()!.getRoundsSinceUpdate(),
      });
    }

    const currentDate = getCurrentDate();
    const { branch: gitBranch, status: gitStatus } = await getGitInfo();

    const planState = this.planMode.getState();
    const planModeContent = buildPlanModePrompt(planState.phase, planState.planMarkdown, planState.planFilePath);
    // Plan turn-context wins when plan is active; auto prompt only in pure auto mode.
    // The mode section is always present (inactive declaration when neither is
    // active) so mode exits are explicitly communicated and re-entries with
    // identical instructions still re-inject (content reflects state).
    const autoModeContent = !planModeContent && this.autoMode.isEnabled() ? buildAutoModePrompt() : undefined;
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
    const sessionId = this.getSessionData()?.id;

    const sections = buildTurnContextSections({
      relevantMemoryContent: this.memory.getRelevantContent(),
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
    return sections;
  }

  /**
   * Detect whether instruction files changed since the last evaluation and, when
   * so, return the rendered `<instruction_context>` section with the latest content.
   * Always refreshes the stored digest snapshot (baseline = first evaluation).
   */
  private async readChangedInstructionContext(): Promise<string | undefined> {
    try {
      const current = await readInstructionContextState();
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
      const loaded = await loadLatestInstructionContent();
      return formatInstructionContextSection(loaded);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log?.warn("agent", "Instruction-context detection failed", { error: message });
      return undefined;
    }
  }

  // ============================================================================
  // Auto-approve mode (skip all tool approvals)
  // ============================================================================

  isAutoModeEnabled(): boolean {
    return this.autoMode.isEnabled();
  }

  setAutoModeEnabled(enabled: boolean): void {
    this.autoMode.setEnabled(enabled);
    // Auto mode and plan mode are mutually exclusive — enabling auto disables plan
    if (enabled && this.planMode.getPhase() !== "off") {
      this.planMode.disable();
    }
  }

  /**
   * Whether pending tool approvals should be auto-approved this turn.
   * True when auto mode is on, or plan mode is building a seeded plan.
   */
  shouldAutoApprovePendingTools(): boolean {
    return this.autoMode.isEnabled() || this.planMode.shouldAutoApproveTools();
  }

  /**
   * Return the current agent mode.
   * Plan mode takes priority over auto mode; normal is the fallback.
   */
  getAgentMode(): AgentMode {
    if (this.planMode.getPhase() !== "off") return "plan";
    if (this.autoMode.isEnabled()) return "auto";
    return "normal";
  }

  /**
   * Set the agent to an explicit mode. Modes are mutually exclusive:
   * setting auto exits plan; setting plan exits auto; normal clears both.
   * @returns the resulting mode
   */
  setAgentMode(mode: AgentMode): AgentMode {
    if (mode === "plan") {
      this.enablePlanMode();
    } else if (mode === "auto") {
      this.setAutoModeEnabled(true);
    } else {
      if (this.planMode.getPhase() !== "off") this.disablePlanMode();
      this.autoMode.setEnabled(false);
    }
    return this.getAgentMode();
  }

  /** Cycle normal → auto → plan → normal. @returns the resulting mode */
  cycleAgentMode(): AgentMode {
    const current = this.getAgentMode();
    return this.setAgentMode(current === "normal" ? "auto" : current === "auto" ? "plan" : "normal");
  }

  // ============================================================================
  // Plan mode
  // ============================================================================

  enablePlanMode(): void {
    enablePlanModeHelper(this);
    // Plan mode and auto mode are mutually exclusive — enabling plan disables auto
    if (this.autoMode.isEnabled()) {
      this.autoMode.setEnabled(false);
    }
    // planMode is session state too; persist it without waiting for the next turn
    // (a redundant call here is a no-op: nothing changed since the autoMode write).
    this.persistSession();
  }

  disablePlanMode(): void {
    disablePlanModeHelper(this);
    this.persistSession();
  }

  getPlanModeState(): PlanModeState {
    return getPlanModeStateHelper(this);
  }

  beginPlanExecution(options: { sendSteer?: boolean } = {}): BeginPlanExecutionResult {
    return beginPlanExecutionHelper(this, options);
  }

  cancelPlanExecution(): boolean {
    return cancelPlanExecutionHelper(this);
  }

  async savePlanToWorkspace(nameHint?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    return savePlanToWorkspaceHelper(this, nameHint);
  }

  async loadPlanFromWorkspace(
    name: string
  ): Promise<{ ok: boolean; path?: string; error?: string; stepCount?: number }> {
    return loadPlanFromWorkspaceHelper(this, name);
  }

  completePlan(): { ok: boolean; error?: string } {
    return completePlanHelper(this);
  }

  async listWorkspacePlans(): Promise<string[]> {
    return listWorkspacePlansHelper();
  }

  // ============================================================================
  // Run orchestration (ManagedAgent coordinates services)
  // ============================================================================

  /** Mark the next prepareForRun as a mid-turn continuation (queued steer / tool phase). */
  markNextPrepareAsContinuation(): void {
    this.run.markNextPrepareAsContinuation();
  }

  /** Clear a leftover continuation mark (e.g. on turn finalize). */
  clearPrepareAsContinuation(): void {
    this.run.clearPrepareAsContinuation();
  }

  /** Consume and clear the continuation flag for prepareForRun. */
  consumePrepareAsContinuation(): boolean {
    return this.run.consumePrepareAsContinuation();
  }

  async prepareForRun(options: {
    prompt?: string;
    messages?: Array<TanStackUIMessage | ModelMessage>;
    abortSignal?: AbortSignal;
  }) {
    await prepareManagedAgentForRun(this, options);
  }

  shouldTriggerAutoCompact(messages?: ModelMessage[]): boolean {
    // The context fill, not `window.inputTokens`: an exclusive upstream reports only the
    // cache-miss part there, which would keep the trigger from ever firing.
    return this.compaction.shouldTriggerAutoCompact({
      contextFillTokens: this.usage.getContextFillTokens(),
      messages,
      contextWindow: this.modelInfo?.contextWindow,
    });
  }

  /**
   * Register a tool-scoped AbortController so {@link abort} cancels in-flight
   * HTTP work (e.g. webfetch / websearch) alongside the main run controller.
   */
  addPendingAbortController(abortController: AbortController): void {
    this.run.addPendingAbortController(abortController);
  }

  removePendingAbortController(abortController: AbortController): void {
    this.run.removePendingAbortController(abortController);
  }

  /**
   * Cancel the current run. Aborts {@link RunCoordinator.currentAbortController}
   * (the same identity wired into TanStack `chat` by {@link prepareForRun}) and
   * any pending tool controllers.
   */
  abort(reason?: string): void {
    abortManagedAgentRun(this, reason);
    this.cascadeAbortToChildren(reason);
  }

  /**
   * Abort actively running child subagents so a parent stop (server/extension
   * hosts dispatching stop directly, force-submit) does not leave detached
   * tasks streaming in the background. Idle/completed children are untouched.
   */
  private cascadeAbortToChildren(reason?: string): void {
    const manager = this.manager;
    if (!manager || this.childIds.length === 0) return;
    for (const childId of [...this.childIds]) {
      const child = manager.getAgent(childId);
      if (!child) continue;
      const status = child.getStatus();
      if (status !== "running" && status !== "compacting" && status !== "thinking" && status !== "responding") {
        continue;
      }
      try {
        child.abort(reason ?? "parent-aborted");
      } catch {
        // Never let a cascade failure break the parent's own abort path.
      }
    }
  }

  isAbortError(err: unknown): boolean {
    return this.run.isAbortError(err);
  }

  /** Current run abort signal — lets compaction helpers cancel their summarizer. */
  getAbortSignal(): AbortSignal | undefined {
    return this.run.currentAbortController?.signal;
  }

  async handleReactiveCompact(error: unknown, manager: AgentManager): Promise<boolean> {
    return handleManagedReactiveCompact(this, error, manager);
  }

  /** Model input context window in tokens, if known (compaction keep policy). */
  getContextWindow(): number | undefined {
    return this.modelInfo?.contextWindow ?? undefined;
  }
  /**
   * Manual context compaction (AgentSession `compact` / `/compact`).
   * Requires {@link manager} to be set (bootstrap always attaches it for root agents).
   */
  async compact(options?: { focus?: string; messages?: TanStackUIMessage[] }): Promise<
    | {
        ok: true;
        message: string;
        tokensBefore?: number;
        tokensAfter?: number;
      }
    | { ok: false; error: string }
  > {
    const manager = this.manager;
    if (!manager) {
      return { ok: false, error: "AgentManager required for compact" };
    }
    return runManualCompact(
      {
        id: this.id,
        getStatus: () => this.getStatus(),
        setStatus: (status, trigger) => this.setStatus(status, trigger ?? "manual-compact"),
        getUI: () => this.getUI(),
        usage: this.usage,
        getTodoManager: () => this.getTodoManager(),
        statusController: this.statusController,
        compactionConfig: this.compaction.getConfig(),
        getContextWindow: () => this.getContextWindow(),
        resetAdmittedTurnContext: () => this.resetAdmittedTurnContext(),
        resetSystemPrompt: () => this.resetSystemPrompt(),
        persistSession: () => this.persistSession(),
        maybeSaveSessionUIMessages: (messages, reason) => this.maybeSaveSessionUIMessages(messages, reason),
        getLog: () => this.log,
        getAbortSignal: () => this.getAbortSignal(),
      },
      manager,
      options
    );
  }

  async restoreSession(sessionId: string): Promise<SessionData> {
    const manager = this.manager;
    // Disk-session ownership check: refuse to resume a session already held by
    // another live agent. Idempotent for the same agent (re-resume is allowed).
    if (manager && !manager.acquireSessionOwnership(sessionId, this.id)) {
      throw new Error(`Session "${sessionId}" is already active in another live session and cannot be resumed here.`);
    }
    try {
      // Announce the departure BEFORE anything re-points the sink — in particular before the
      // pre-bind below, which is itself a re-point. Ordering is the whole point: this entry
      // describes the session being left, so it must be written while the sink still points at it.
      // A no-op when the id is already the target (a re-resume of the same session), which would
      // otherwise log a switch from a session to itself.
      const leavingId = this.getSessionData()?.id;
      if (leavingId && leavingId !== sessionId) {
        this.emitEvent("session:switch", {
          fromSessionId: leavingId,
          toSessionId: sessionId,
          messageCount: this.getSessionData()?.uiMessages.length ?? 0,
          reason: "resume",
        });
      }
      // Bind ahead of the restore: `restoreManagedSession` emits `session:restore` (and the
      // restore can log its own failures), so pointing the sink at the target first is what makes
      // "which session was restored" land in that session's log. The target id is passed
      // explicitly because the session data still holds the transient bootstrap id here.
      //
      // Consequence, deliberate: an entry emitted by the restore itself lands in the *target*
      // session's file even when the restore then throws. The sink is best-effort either way, and
      // the alternative is losing the record of the attempt entirely.
      this.bindSessionLogSink(sessionId);
      const session = await restoreManagedSession(this, sessionId);
      // Re-point the log sink at the restored session's dir so a mid-session
      // switch keeps logging to the session being viewed. A no-op at bootstrap
      // (the sink was already bound to this id by `createManagedAgent`).
      this.bindSessionLogSink();
      return session;
    } catch (err) {
      // Roll back ownership so a failed restore (e.g. missing session) doesn't
      // leave a stale claim.
      manager?.releaseSessionOwnership(sessionId, this.id);
      // …and the log binding, for the same reason: a failed restore leaves the session data on
      // the transient id, so the sink must go back there or the agent keeps writing into a
      // directory belonging to a session it is not running.
      this.bindSessionLogSink();
      throw err;
    }
  }

  isToolNeedsApproval(toolName: string): boolean {
    const tools = this.extensions.getManagedToolsProvider()?.() ?? {};
    const tool = tools[toolName];
    return tool != null && "needsApproval" in tool && (tool as { needsApproval?: boolean }).needsApproval === true;
  }

  /** Create or replace the core-owned main chat session (StreamProcessor + run loop). */
  initChat(manager: AgentManager, initialMessages?: TanStackUIMessage[]): AgentChatController {
    this.chatController = new AgentChatController(this, manager, initialMessages);
    if (this.eventBus) this.chatController.setEventBus(this.eventBus);
    this.resetSessionSyncTracker(initialMessages);
    return this.chatController;
  }

  getChatController(): AgentChatController | undefined {
    return this.chatController;
  }

  /** Drop steer/follow-up queues without clearing the transcript. */
  clearQueuedMessages(): void {
    this.chatController?.clearQueuedMessages();
  }

  /**
   * Stop the in-flight run if one exists (session switch). Idle hosts are a
   * no-op, so resuming a session does not fire a spurious abort.
   */
  stopActiveRun(reason = "session-switch"): void {
    this.chatController?.stopIfActive(reason);
  }

  reset(): void {
    const prevStatus = this.getStatus();
    this.log?.info("agent", "Resetting agent", {
      previousStatus: prevStatus,
      hadTodos: this.getTodoManager()?.hasTodos() ?? false,
    });
    // Exit plan / auto-approve first so approval bypass cannot stick across sessions.
    this.planMode.disable();
    this.setAutoModeEnabled(false);
    this.approvals.clear();
    this.run.resetRunState();
    this.compaction.resetReactiveCompactRetries();
    this.statusController.resetToIdle();
    this.setError("");
    this.retryInfo = null;
    this.pendingApprovalCount = 0;
    this.memory.resetState();
    this.pendingExtensionTurnContextSections = undefined;
    this.usage.reset();
    this.getTodoManager()?.reset();
    this.run.resetTurnLifecycle();
    // Keep chatController + uiChannel alive — /clear calls clearMessages() separately.
    // Resetting these would break subsequent sendMessage() calls.
    this.lastAdmittedTurnContextHashes = undefined;
    this.systemPromptFrozen = false;
    this.frozenSystemPrompt = undefined;
  }

  // ============================================================================
  // Package-internal runner / adapter / UI wiring
  // ============================================================================

  /** @internal Used by run-agent / stream recovery. */
  getRunner(): AgentRunner | undefined {
    return this.runnerWiring.getRunner();
  }

  /** @internal */
  setRunner(runner: AgentRunner | undefined): void {
    this.runnerWiring.setRunner(runner);
  }

  /** @internal */
  getRunnerConfigKey(): string | undefined {
    return this.runnerWiring.getRunnerConfigKey();
  }

  /** @internal */
  setRunnerConfigKey(key: string | undefined): void {
    this.runnerWiring.setRunnerConfigKey(key);
  }

  /** @internal Invalidate cached AgentRunner (tools / plan phase / prompt changed). */
  invalidateRunner(): void {
    this.runnerWiring.invalidateRunner();
  }

  /** @internal */
  getTextAdapter(): TextAdapterConfig | undefined {
    return this.runnerWiring.getTextAdapter();
  }

  /** @internal */
  setTextAdapter(adapter: TextAdapterConfig | undefined): void {
    this.runnerWiring.setTextAdapter(adapter);
  }

  /** @internal Wire chat / subagent UI channel (hosts read via {@link getUI}). */
  setUIChannel(ui: AgentUIChannel | undefined): void {
    this.runnerWiring.setUIChannel(ui);
  }
}

export function createManagedAgentTimestamps(): Pick<ManagedAgent, "createdAt" | "updatedAt" | "childIds"> {
  const now = Date.now();
  return { createdAt: now, updatedAt: now, childIds: [] };
}
