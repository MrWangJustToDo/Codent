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
 *    here for now. This is the honest limit of the split: the remaining status /
 *    session / resource regions are not field moves, they *are* the graph's
 *    mutation surface. Extracting one means moving policy and re-validating
 *    concurrency behaviour — see the archived debt tracker at
 *    `openspec/changes/archive/2026-10-10-core-structure-convergence/architecture-debt-tracker.md`.
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

import { AutoModeController } from "../agent/approval/auto-mode-controller.js";
import { ToolApprovalTable } from "../agent/approval/tool-approval-table.js";
import { keepPolicyProjectionOptions, resolveKeepPolicy } from "../agent/compaction/keep-policy.js";
import { getModelVisibleMessages } from "../agent/compaction/message-chain-projection.js";
import { ToolCompactCache } from "../agent/compaction/tool-compact/tool-compact-cache.js";
import { WireProjectionCache } from "../agent/compaction/wire-projection-cache.js";
import { projectWireFromChannel } from "../agent/compaction/wire-projection.js";
import { scopeExtensionOwnerId } from "../agent/extension/owner-id.js";
import { statusTransitionLogLevel } from "../agent/log/status-transition-log.js";
import { logSubagentLifecycle } from "../agent/log/subagent-log-mirror.js";
import { type SessionSaveReason } from "../agent/persistence/session-sync-tracker.js";
import { type SessionData } from "../agent/persistence/types.js";
import { PlanModeController } from "../agent/plan/plan-mode-controller.js";
import { collectPendingApprovals, collectPendingAskUser } from "../agent/stream/tool-phase-utils.js";
import { AgentStreamHub } from "../agent/stream-hub/agent-stream-hub.js";
import { buildSubagentSummaries } from "../agent/subagent/subagent-summaries.js";
import {
  type PreforkDiscardCause,
  discardRegisteredPrefork,
  peekTaskPreforkCoordinator,
} from "../agent/subagent/task-prefork.js";
import { getBuiltinToolPresentation } from "../agent/tools/presentation/builtin.js";
import { getToolMetadata } from "../agent/tools/runtime/define-tool.js";
import { type TurnContextSection } from "../agent/turn-context/turn-context-message.js";
import { UsageStore } from "../agent/usage/usage-store.js";
import { getEnv, resolveCoreEnv } from "../env";
import { selectModel } from "../models/config/model-selection.js";
import { selectableModelIds } from "../models/config/models-config.js";
import { offerableReasoningEfforts } from "../models/types.js";
import { isActiveStatus } from "../runtime-types/agent-status.js";
import { generateId } from "../utils/generate-id.js";
import { copyModelMessages } from "../utils/model-messages.js";

import { AgentLogBinding } from "./agent-log-binding.js";
import { AgentConfigSchema, DEFAULT_AGENT_MAX_ITERATIONS } from "./agent-types.js";
import { AgentChatController } from "./controllers/agent-chat-controller.js";
import { createAgentStatusController, type AgentStatusController } from "./controllers/agent-status-controller.js";
import { TurnContextController } from "./controllers/turn-context-controller.js";
import { completeExtensionQuery, DEFAULT_EXTENSION_CALLS_PER_RUN, ExtensionLlmError } from "./extension-completion.js";
import { handleManagedReactiveCompact, runManualCompact, type ManualCompactHost } from "./managed-agent-compact.js";
import {
  beginPlanExecution as beginPlanExecutionHelper,
  cancelPlanExecution as cancelPlanExecutionHelper,
  completePlan as completePlanHelper,
  getPlanModeState as getPlanModeStateHelper,
  listWorkspacePlans as listWorkspacePlansHelper,
  loadPlanFromWorkspace as loadPlanFromWorkspaceHelper,
  savePlanToWorkspace as savePlanToWorkspaceHelper,
} from "./managed-agent-plan.js";
import {
  abortManagedAgentRun,
  finalizeManagedAgentRun,
  prepareManagedAgentForRun,
} from "./managed-agent-run-lifecycle.js";
import { RunnerWiring } from "./managed-agent-runner-wiring.js";
import { ModeCoordinator } from "./mode-coordinator.js";
import { RunCoordinator } from "./run-coordinator.js";
import { RunFinalizer } from "./run-finalizer.js";
import { AgentCommandService } from "./services/agent-command-service.js";
import { AgentToolService } from "./services/agent-tool-service.js";
import { CompactionService } from "./services/compaction-service.js";
import { ExtensionRegistryService } from "./services/extension-registry-service.js";
import { MemoryService } from "./services/memory-service.js";
import { SessionLifecycleService, type SessionLifecycleReason } from "./services/session-lifecycle-service.js";
import { SessionService } from "./services/session-service.js";
import { UsageHistoryService } from "./services/usage-history-service.js";
import { SessionPersistence } from "./session-persistence.js";
import { emitAgentTelemetry } from "./telemetry/emit-agent-telemetry.js";
import { UsageTracker } from "./telemetry/usage-tracker.js";

import type { AgentManager } from "./agent-manager.js";
import type { ResolvedCoreEnv } from "../env";
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
import type {
  ExtensionContext,
  ExtensionLlmRequest,
  ExtensionLlmResult,
  ExtensionRuntimeAccess,
} from "../agent/extension/types.js";
import type { SubagentLifecyclePhase, SubagentLogDetails } from "../agent/log/subagent-log-mirror.js";
import type { LspExtensionConfig } from "../agent/lsp";
import type { McpExtensionConfig, McpServerConfig } from "../agent/mcp";
import type { McpManager } from "../agent/mcp/manager.js";
import type { MemoryExtensionConfig } from "../agent/memory";
import type { MemoryManager } from "../agent/memory/memory-manager.js";
import type { SessionStore } from "../agent/persistence/session-store.js";
import type { BeginPlanExecutionResult, PlanModeState } from "../agent/plan/plan-mode-controller.js";
import type { AgentRunner } from "../agent/runner/agent-runner.js";
import type { SkillRegistry, SkillsExtensionConfig } from "../agent/skills";
import type { TodoManager } from "../agent/todo";
import type { ToolsRecord } from "../agent/tools/catalog/tool-set.js";
import type { ToolPresentation } from "../agent/tools/presentation/types.js";
import type { ToModelOutputFn } from "../agent/tools/runtime/contract.js";
import type { AgentToolConfig } from "../agent/tools/tool-config.js";
import type { AgentUIChannel } from "../agent/ui/ui-channel.js";
import type { TextAdapterConfig } from "../models/adapter/adapter-factory.js";
import type { ModelStyle } from "../models/config/model-config.js";
import type { ModelInfo } from "../models/types.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { AgentEventPayloadMap } from "../runtime-types/agent-event-payloads.js";
import type { AgentEventType } from "../runtime-types/agent-events.js";
import type { AgentProfileId, AgentToolsetProfile } from "../runtime-types/agent-profile.js";
import type { AgentRetryState } from "../runtime-types/agent-retry.js";
import type {
  QueuedMessageContent,
  AgentIterationState,
  AgentL1State,
  AgentSessionSubagentSummary,
  AgentMode,
  SessionInteractionsSnapshot,
  SessionJobsSnapshot,
} from "../runtime-types/session-payloads.js";

// ============================================================================
// Config
// ============================================================================

/** When the turn context payload hasn't changed, re-admit every N messages to keep context fresh. */
export type { RunFinalizeReason } from "./agent-types.js";

export type { AgentL1State, AgentMode } from "../runtime-types/session-payloads.js";

export type ManagedAgentConfig<T = ManagedAgent> = AgentConfig & {
  name: string;
  /** Toolset family (root/explore/internal/general). */
  toolsetProfile?: AgentToolsetProfile;
  /** Profile id used for log/task attribution. */
  profileId?: AgentProfileId;
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
   * Explicit MCP servers for this agent, replacing the config file when non-empty.
   * See `AgentSessionCreateOptions.mcpServers` — this is the same option one layer down.
   */
  mcpServers?: Record<string, McpServerConfig>;
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
   * Enable the built-in Memory extension (default: true). Set to `false` to disable the whole
   * memory capability: tools (memory_list, memory_read, memory_write), the index in turn context,
   * per-turn relevance selection, and end-of-turn extraction. Pass an object to fine-tune behavior
   * (see {@link MemoryExtensionConfig}).
   */
  memory?: boolean | MemoryExtensionConfig;
  /**
   * Extension model access limits (`ctx.llm`).
   *
   * Completions are budgeted **per run**: the counter resets when the run's abort controller changes,
   * so one runaway extension cannot spend a session's whole budget in a single turn. The refusal is
   * reported once per run as `agent:extension-error`.
   */
  extensionLlm?: {
    /** Completions allowed per run (default 20). */
    callsPerRun?: number;
    /** Output-token cap applied when a caller does not set one (default 4096). */
    maxOutputTokens?: number;
  };
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

  /**
   * Instance id — an agent *bound to one conversation*: the conversation-scoped state below
   * (the UI channel, `SessionData`, todos, queues, usage) and beside it (`planMode`, `approvals`)
   * lives on this instance, which is why `/resume` re-binds it instead of creating a second one.
   * Process-scoped: re-minted on restart, so it is NOT a correlation key — the disk session is
   * (`AgentSessionSnapshot.activeSessionId`). See ARCHITECTURE.md §1.7.
   */
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
  /** The last run's model finish reason, projected on the state channel. */
  private lastFinishReason: string | null = null;
  /** Tools awaiting user approval in the current run (set by approval middleware). */
  private pendingApprovalCount: number;
  /** Agent-loop progress for the current run; null until the first iteration. */
  private iterationState: AgentIterationState | null = null;
  /** Live LLM retry visibility (set by stream recovery; cleared when the stream recovers). */
  private retryInfo: AgentRetryState | null = null;
  /** Session-transition state coalescing: publish one L1 frame after unload/load commits. */
  private stateBatchDepth = 0;
  private stateBatchPending = false;

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
  /** Cached live accessors handed to extensions (`ctx.llm`, run/session facts). */
  private extensionRuntime: ExtensionRuntimeAccess | null = null;
  /**
   * Extension completion budget for the CURRENT run. Keyed by the run's abort signal so the counter
   * resets when a new run starts without touching the run lifecycle.
   */
  private extensionLlmBudget: { runId: string | null; count: number; reported: boolean } = {
    runId: null,
    count: 0,
    reported: false,
  };
  readonly statusController: AgentStatusController;
  /** End-of-run sequence (outcome → persist → finalize → turn summary). */
  readonly runFinalizer: RunFinalizer;
  /** Plan mode (read-only planning → execute). Root agents only; subagents leave phase off. */
  readonly planMode: PlanModeController;
  /** Auto / YOLO mode — skip all tool approvals. Cleared on reset / `/new`. */
  readonly autoMode: AutoModeController;
  /** Plan/auto mutual exclusion + mode persistence/restore. */
  readonly mode: ModeCoordinator;
  /** Session-backed tool-approval interrupt table. */
  private approvals: ToolApprovalTable;

  // ============================================================================
  // Tools / registries / extensions
  // ============================================================================

  tools: ToolsRecord;
  /** Unified per-agent tool service (built-ins + extension registrations). */
  readonly toolService: AgentToolService;
  private todoManager: TodoManager | null;
  private mcpManager: McpManager | null = null;
  private skillRegistry: SkillRegistry | null = null;
  log: AgentLog;
  /** Session log sink lifetime (bind / re-point / flush-on-destroy). */
  private readonly logBinding: AgentLogBinding;
  /** Extension / tool / integration registration domain (todo, MCP, skills, extensions). */
  readonly extensions: ExtensionRegistryService;

  // ============================================================================
  // Agent tree + timestamps
  // ============================================================================

  parentId?: string;
  /** Disk session this child belongs to; set by `spawnSubagent` for session-scoped subagent rows. */
  private sessionScopeId?: string;
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
  /** Live command/task/compact streams for the session `summary` / `tool` projection. */
  private readonly streamHub: AgentStreamHub;
  private chatController?: AgentChatController;
  /**
   * Abort controller for a manual `/compact` run. Manual compaction is not a chat pump, so it has
   * no `RunCoordinator.currentAbortController`; without its own controller a session switch could
   * clear the stream hub while the next compaction segment was still about to start.
   */
  private compactAbortController?: AbortController;
  /** Owner generation for the current manual compaction; bumped whenever it is cancelled. */
  private compactGeneration = 0;
  /** Per-agent background work ownership (registry + durable restore + turn-context pointer). */
  private commandService?: AgentCommandService;
  /** Set by AgentManager to route events to listeners. */
  dispatchEvent?: (event: AgentEvent) => void;
  /** Scoped unified event bus for this agent (set by the factory). */
  private eventBus?: AgentEventBus;
  /** Owning manager — set when registered via {@link AgentManager.createManagedAgent}. */
  manager?: AgentManager;
  /** Deferred bootstrap telemetry for hosts that must restore/init chat before session:start. */
  private bootstrapEvents?: () => Promise<void>;
  /**
   * Runtime this agent belongs to (env + model provider) — set by the factory from the
   * owning manager. `undefined` means the ambient runtime (legacy single-instance hosts).
   */
  runtime?: AgentRuntime;
  modelInfo: ModelInfo | null;

  // ============================================================================
  // Compaction / session sync
  // ============================================================================

  private compaction: CompactionService;
  /** Shared channel → wire projection cache (see `getWireProjectionCache`). */
  private wireProjectionCache: WireProjectionCache | null = null;
  private toolCompactCache: ToolCompactCache;
  readonly sessionPersistence: SessionPersistence;
  /** Session switch/reset transaction owner (stop producers, clear transient state). */
  readonly sessionLifecycle: SessionLifecycleService;

  // ============================================================================
  // Run lifecycle flags + timing
  // ============================================================================

  // Run lifecycle flags/timing moved to RunCoordinator (this.run) — methods below delegate.

  // ============================================================================
  // Prompt / turn context
  // ============================================================================

  /** Prompt + dynamic turn-context state (frozen prefix, admission, instruction detection). */
  private readonly turnContext: TurnContextController;

  constructor(
    config: ManagedAgentConfig,
    init: {
      id?: string;
      log: AgentLog;
      tools: ToolsRecord;
      todoManager: TodoManager | null;
      parentId?: string;
      /** Runtime this agent belongs to (env + provider); undefined = ambient. */
      runtime?: AgentRuntime;
      usage?: UsageTracker;
      memory?: MemoryService;
      session?: SessionService;
      usageHistory?: UsageHistoryService;
      compaction?: CompactionService;
    }
  ) {
    // Core mints the id, or takes the one core itself assigned to a spawned subagent (`init.id`, e.g.
    // `subagent_…`). A host cannot choose one: `ManagedAgentConfig` has no `id` — an id a host could
    // set is an id a host would correlate against, and this one is per-process (the disk session is
    // the correlation key; ARCHITECTURE.md §1.7).
    this.id = init.id ?? generateId("agent");
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
    this.logBinding = new AgentLogBinding({
      getLog: () => this.log,
      getParentId: () => this.parentId,
      getSessionId: () => this.getSessionData()?.id,
      getAgentId: () => this.id,
      getCoreEnv: () => this.getCoreEnv(),
      attachViaManager: (log, options) => this.manager?.getLogExtension()?.attachSink(log, options),
    });
    this.tools = init.tools;
    this.toolService = new AgentToolService(this.tools);
    this.todoManager = init.todoManager ?? null;
    // Always its own service, never injectable. It holds per-agent extension state that cannot be
    // shared: the AgentToolService's owner stacks, a single `ExtensionRunner` slot, and extension
    // commands. Two agents sharing one would overwrite each other's tool objects and handlers, not
    // just their presentation descriptors — and the owner-id scoping applied at this boundary
    // cannot help, because the later agent's `setExtensionRunner` replaces the first agent's runner
    // outright. Keeping it un-injectable makes "one registry per agent" unexpressible rather than
    // merely conventional. MCP / todo / skill state lives on this agent, not the extension service.
    this.extensions = new ExtensionRegistryService(this.toolService);
    this.parentId = init.parentId;
    this.runtime = init.runtime;
    this.usage = init.usage ?? new UsageTracker();
    this.memory =
      init.memory ??
      new MemoryService((type, data) => {
        // The service owns the memory telemetry; it is constructed here so the sink is the
        // agent's own emitter (extensions cannot emit bus events, and the memory extension is
        // only the trigger for selection).
        this.emitEvent(type, data);
      });
    this.session = init.session ?? new SessionService();
    this.sessionPersistence = new SessionPersistence(this);
    // The store resolves the runtime env when bound, else ambient lazily at first write.
    this.usageHistory = init.usageHistory ?? new UsageHistoryService(new UsageStore(this.runtime?.env));
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
      setFinishReason: (reason) => {
        this.lastFinishReason = reason;
      },
      emitEvent: (type, data) => this.emitEvent(type, data),
    });
    this.runFinalizer = new RunFinalizer({
      status: this.statusController,
      getStatus: () => this.getStatus(),
      getError: () => this.getError(),
      finalizeRun: (reason) => this.finalizeRun(reason),
      discardPreforkRuns: (cause) => this.discardPreforkRuns(cause),
      emitEvent: (type, data) => this.emitEvent(type, data),
      usage: this.usage,
    });

    this.planMode = new PlanModeController({
      getTodoManager: () => this.getTodoManager(),
      getCoreEnv: () => this.getCoreEnv(),
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
    this.mode = new ModeCoordinator({
      planMode: this.planMode,
      autoMode: this.autoMode,
      persist: () => this.persistSession(),
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
    this.streamHub = new AgentStreamHub();
    this.modelInfo = null;

    // ============================================================================
    // Compaction / session sync (inline inits)
    // ============================================================================
    this.compaction = init.compaction ?? new CompactionService();
    this.toolCompactCache = new ToolCompactCache();

    // ============================================================================
    // (Run lifecycle flags + timing inits moved into RunCoordinator)
    // ============================================================================

    // ============================================================================
    // Prompt / turn context (owned by the controller)
    // ============================================================================
    this.turnContext = new TurnContextController({
      agentId: this.id,
      getConfig: () => this.config,
      getCoreEnv: () => this.getCoreEnv(),
      getSessionId: () => this.getSessionData()?.id,
      getPlanState: () => this.planMode.getState(),
      isAutoModeEnabled: () => this.autoMode.isEnabled(),
      getExtensionRunner: () => this.extensions.getExtensionRunner(),
      getParentId: () => this.parentId,
      onPromptBefore: (input) => this.emitEvent("prompt:before", input),
      invalidateRunner: () => this.invalidateRunner(),
      log: this.log,
    });

    this.sessionLifecycle = new SessionLifecycleService({
      sessionPersistence: this.sessionPersistence,
      getSessionData: () => this.getSessionData(),
      setSessionData: (data) => this.setSessionData(data),
      getSessionStore: () => this.getSessionStore(),
      awaitSessionPersistIdle: () => this.session.awaitPersistIdle(),
      getChatController: () => this.getChatController(),
      acquireSessionOwnership: (sessionId) => this.manager?.acquireSessionOwnership(sessionId, this.id) ?? true,
      releaseSessionOwnership: (sessionId) => this.manager?.releaseSessionOwnership(sessionId, this.id),
      bindSessionLogSink: (sessionId) => this.bindSessionLogSink(sessionId),
      emitSessionNew: (sessionId, reason) => this.emitEvent("session:new", { sessionId, reason }),
      emitSessionSwitch: (fromSessionId, toSessionId, messageCount) =>
        this.emitEvent("session:switch", { fromSessionId, toSessionId, messageCount, reason: "resume" }),
      refreshState: () => this.refreshState(),
      refreshSubagents: () => this.refreshSubagents(),
      beginStateBatch: () => this.beginStateBatch(),
      endStateBatch: () => this.endStateBatch(),
      syncInteractionStateFromUIMessages: (messages) => this.syncInteractionStateFromUIMessages(messages),
      resetRunOutcome: () => this.resetRunOutcome(),
      getToolCompactCache: () => this.getToolCompactCache(),
      mode: this.mode,
      approvals: this.approvals,
      run: this.run,
      getCompaction: () => this.compaction,
      statusController: this.statusController,
      memory: this.memory,
      usage: this.usage,
      streamHub: this.streamHub,
      getTodoManager: () => this.getTodoManager(),
      stopActiveRun: (reason) => this.stopActiveRun(reason),
      abortManualCompaction: (reason) => this.abortManualCompaction(reason),
      cascadeAbortToChildren: (reason) => this.cascadeAbortToChildren(reason),
      discardPreforkRuns: () => this.discardPreforkRuns(),
      clearErrorAndRetry: () => {
        this.setError("");
        this.retryInfo = null;
      },
      clearPendingApprovals: () => {
        this.pendingApprovalCount = 0;
      },
      resetMediaHydrationMisses: () => this.setMediaHydrationMisses(0),
      resetTurnContext: () => this.turnContext.resetTurnState(),
      resetSessionSyncTracker: () => this.resetSessionSyncTracker(),
      resetIterationProgress: () => this.resetIterationProgress(),
      resetCommandJobs: (reason) => {
        const service = this.commandService;
        this.commandService = undefined;
        void service?.reset(reason).catch((error: unknown) => {
          this.log?.warn("system", "Failed to reset command jobs", { reason, error: String(error) });
        });
      },
    });

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

  /** Model finish reason of the last completed run, or null before one. */
  getLastFinishReason(): string | null {
    return this.lastFinishReason;
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
    this.runFinalizer.finalizeSnapshot(messages);
  }

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

  /** L1 status snapshot for Emitter / Session projection. */
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
      lastFinishReason: this.lastFinishReason,
      // Set at the end of a run, so it has to ride the state event that follows the status flip.
      lastStreamDurationMs: this.getLastStreamDurationMs(),
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
   * Background command jobs owned by this agent, summarized for a status surface.
   * Projected onto the retained `jobs` channel so the built-in jobs extension (and
   * remote clients) see the current list without polling the registry.
   *
   * Reads through the lazy registry, which would mint an empty one — so with no
   * registry the answer is an explicit empty list instead.
   */
  readJobs(): SessionJobsSnapshot {
    return { jobs: this.commandService?.list() ?? [] };
  }

  /**
   * Child-agent list for the retained `subagents` channel.
   *
   * Same projection as the snapshot's `subagents` field, and the reason it needs a channel at all:
   * `subagent:created` / `subagent:destroyed` carry a single id, so off-process a task row could
   * never be added or removed — the list only moved on a full snapshot refetch.
   */
  readSubagents(): { subagents: AgentSessionSubagentSummary[] } {
    return { subagents: buildSubagentSummaries(this, this.manager) };
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

  /** Clear retained run progress and publish the idle value (`current: 0`). */
  resetIterationProgress(): void {
    // finalizeRun and resetTransientState can both reach a terminal/reset path;
    // only publish when there is progress to clear.
    if (this.iterationState === null) return;
    this.iterationState = null;
    this.eventBus?.emit("agent:iteration", this.readIteration());
  }

  /**
   * Clear the completed-run surface that is not part of SessionData.
   *
   * A new/restored conversation must not inherit the previous session's finish reason or
   * "completed in" duration; both are L1 state fields and are otherwise only overwritten
   * by the next run's start/finish.
   */
  resetRunOutcome(): void {
    this.lastFinishReason = null;
    this.run.resetLastStreamDuration();
  }

  /**
   * Coalesce L1 state publication across a session unload/load transaction.
   *
   * The individual reset/restore steps still update their own channels, but `state` is
   * committed once after the target session has been adopted. A nested begin/end pair is
   * counted, so an outer host transaction can safely wrap a lifecycle operation.
   * @internal
   */
  beginStateBatch(): void {
    this.stateBatchDepth += 1;
  }

  /** End a state batch and publish the final L1 frame if anything changed. @internal */
  endStateBatch(): void {
    if (this.stateBatchDepth === 0) return;
    this.stateBatchDepth -= 1;
    if (this.stateBatchDepth > 0 || !this.stateBatchPending) return;
    this.stateBatchPending = false;
    this.publishStateChange();
  }

  private emitStateChange(): void {
    if (this.stateBatchDepth > 0) {
      this.stateBatchPending = true;
      return;
    }
    this.publishStateChange();
  }

  private publishStateChange(): void {
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
    // Default the parent link to this agent's own parent: a child's events up-flow into the parent's
    // scope, and without this the envelope dropped `parentId` for everything except the explicit
    // `subagent:*` emits — so an extension could not tell a child's turn from its own by envelope alone.
    emitAgentTelemetry(this, type, payload, {
      ...(this.parentId ? { parentId: this.parentId } : {}),
      ...options,
    });

    // Any `subagent:*` transition can change a child row, which is what the retained `subagents`
    // summary carries. Refresh here, at the ONE place these events are dispatched, rather than at
    // each call site — per-site publishing is how the list ended up with no channel at all:
    // `subagent:created` / `:destroyed` each had to remember, and neither did.
    //
    // The event is dispatched by the CHILD, but the rows describe the PARENT's children, so resolve
    // the parent and refresh its scope. A root agent emitting its own event refreshes itself.
    if (type.startsWith("subagent:")) {
      const parent = this.parentId ? this.manager?.getAgent(this.parentId) : this;
      parent?.refreshSubagents();
    }
  }

  /**
   * Republish the retained `subagents` list for this agent's scope.
   * @internal
   */
  refreshSubagents(): void {
    this.eventBus?.emit("session:subagents", this.readSubagents());
  }

  /**
   * Attach this agent's scoped unified event bus and propagate it to owned
   * domain objects (session channel projections + retained values).
   * @internal Wired by `agent-factory` during construction.
   */
  setEventBus(bus: AgentEventBus): void {
    this.eventBus = bus;
    this.usage.setEventBus(bus);
    this.streamHub.setEventBus(bus);
    this.planMode.setEventBus(bus);
    this.getTodoManager()?.setEventBus(bus);
    this.chatController?.setEventBus(bus);
    bus.retain("agent:state", () => this.getL1State());
    bus.retain("session:mode", () => this.modeState());
    bus.retain("session:extensions", () => ({
      extensions: this.extensions.getExtensionRunner()?.getExtensionInfos() ?? [],
    }));
    bus.retain("session:tool-presentation", () => ({ descriptors: this.getToolPresentationCatalog() }));
    bus.retain("session:mcp", () => ({ servers: this.getMcpManager()?.getServerStatuses() ?? [] }));
    bus.retain("session:interaction", () => this.readInteractions());
    bus.retain("agent:iteration", () => this.readIteration());
    bus.retain("session:jobs", () => this.readJobs());
    bus.retain("session:subagents", () => this.readSubagents());
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
   * The persisted model is a CLIENT choice (it is what `/models` last wrote), so it stands —
   * unless this runtime's catalog does not offer it. Then the model the session already runs
   * (`config.model`, resolved at bootstrap) is the fallback, because a resume that reintroduces an
   * id the provider refuses would fail on the first request rather than degrade. Under
   * remote-provider the STYLE is not adopted: the server owns it, and a persisted `anthropic`
   * style against an OpenAI-style proxy is a hard error.
   *
   * A no-op when the effective model already matches the live config.
   */
  applyPersistedModel(next: { model: string; modelStyle?: ModelStyle }): void {
    const remote = this.config.providerMode === "remote";
    const selection = remote
      ? selectModel({
          requested: next.model,
          fallback: this.config.model,
          allowed: selectableModelIds(this.runtime?.models),
        })
      : { model: next.model };

    if (selection.fallback) {
      this.log?.warn(
        "agent",
        "Persisted model is not in this provider's catalog; keeping the session's model",
        selection.fallback
      );
    }

    const style = remote ? this.config.modelStyle : next.modelStyle;
    const sameModel = selection.model === this.config.model;
    const sameStyle = !style || style === this.config.modelStyle;
    if (sameModel && sameStyle) return;
    this.setModel({ model: selection.model, ...(style ? { modelStyle: style } : {}) });
  }

  /** Current reasoning-effort level, or undefined when unset (model default). */
  getReasoningEffort(): AgentConfig["reasoningEffort"] {
    return this.config.reasoningEffort;
  }

  /**
   * Set the reasoning-effort level and invalidate the cached runner so the next
   * run rebuilds {@link AgentRunner} with the new `modelOptions`.
   *
   * The persisted value is a *record* of the state a message was produced under (see
   * `SessionData.reasoningEffort`), not a session-owned setting: `/models` chooses it together
   * with the model, and this only stamps the transcript being written.
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
   * Under remote-provider the switch is honoured like any other: the adapter is rebuilt from
   * `config.model`, so the new id is what the proxy receives. What that plane constrains is the
   * CATALOG, not the seat of the decision — a switch to an id the provider does not advertise is
   * refused by the proxy (`model_not_allowed`), which is why the callers that can see the catalog
   * (`/models`, `applyPersistedModel`, `resolveModelConfigFromProvider`) resolve the choice through
   * `selectModel` first.
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

    // A reasoning level belongs to the model it was chosen for: an explicit `high` carried onto a
    // model that advertises no levels is forwarded to the adapter anyway (`run-agent` passes
    // `config.reasoningEffort ?? defaultEffort`), so the request either fails upstream or silently
    // means something else. `/models` exists to make model + depth ONE decision; a switch that keeps
    // the old depth defeats that. Only an EXPLICIT level is dropped — `undefined` (the model default)
    // is already correct, and clearing it would be a no-op.
    //
    // The predicate is the STRICT rule (`offerableReasoningEfforts`): `supportedReasoningEfforts`
    // falls back to every known level when a model advertises none, which is right for validating a
    // hand-typed level but would report "supports high" for a model with no thinking depth at all.
    if (
      this.config.reasoningEffort !== undefined &&
      !offerableReasoningEfforts(this.modelInfo ?? undefined).includes(this.config.reasoningEffort)
    ) {
      this.updateConfig({ reasoningEffort: undefined });
    }

    // Keep new on-disk sessions (`/new`, session.new) on the switched model.
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

  /** @internal Defer bootstrap telemetry until the host has restored the session/chat. */
  setBootstrapEvents(events: () => Promise<void>): void {
    this.bootstrapEvents = events;
  }

  /** @internal Emit bootstrap telemetry exactly once, after host restore. */
  async emitBootstrapEvents(): Promise<void> {
    const events = this.bootstrapEvents;
    if (!events) return;
    this.bootstrapEvents = undefined;
    await events();
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
    this.logBinding.bind(sessionId);
  }

  /**
   * Record the release handle for a sink bound outside {@link bindSessionLogSink} — the subagent
   * path, where `spawnSubagent` owns the options and core defers release until destroy.
   */
  setLogSinkDetach(detach: () => void): void {
    this.logBinding.setExternalDetach(detach);
  }

  /** Release the active log sink binding. Idempotent. */
  detachLogSink(): void {
    this.logBinding.detach();
  }

  /** Land buffered entries, release the sink, then unregister the process guard. */
  flushLogOnDestroy(): void {
    this.logBinding.flushOnDestroy();
  }

  getTodoManager(): TodoManager | null {
    return this.todoManager;
  }

  getApprovals(): ToolApprovalTable {
    return this.approvals;
  }

  getCompaction(): CompactionService {
    return this.compaction;
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
   * re-pointed here rather than at each caller: a resume and `/new` both change the id
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
    this.sessionPersistence.maybeSave(uiMessages, reason);
  }

  /**
   * Force-persist session `uiMessages` (slash commands such as `/new`).
   * Fire-and-forget — dehydrate + disk write happen in the background.
   */
  saveSessionUIMessages(uiMessages: TanStackUIMessage[]): void {
    this.sessionPersistence.save(uiMessages);
  }

  /** Reset fingerprint tracking after restore, clear, or new chat bootstrap. */
  resetSessionSyncTracker(uiMessages?: TanStackUIMessage[]): void {
    this.sessionPersistence.resetTracker(uiMessages);
  }

  /** Persist model state only (usage, todos). Does not write `uiMessages`. */
  persistSession(): void {
    this.sessionPersistence.persistState();
  }

  /**
   * Finalize a user turn / detached run — persist session, clear turn memory, optionally extract memories, emit `agent:stop`.
   * Owned by {@link AgentChatController} / subagent runners (not per-`chat()` middleware).
   * Memory extraction runs only when `reason === "finished"`. Idempotent per turn until {@link resetTurnLifecycle}.
   */
  finalizeRun(reason: RunFinalizeReason): void {
    // A terminal turn (or an abort) must not leave the retained `iteration` channel
    // reporting the last model turn of the run.
    this.resetIterationProgress();
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
    this.turnContext.setAgentDocContent(content, source);
  }

  /** Evaluate the session-history gate once, at agent creation. */
  async primeSessionHistoryGate(): Promise<void> {
    await this.turnContext.primeSessionHistoryGate();
  }

  getAgentDocContent(): string {
    return this.turnContext.getAgentDocContent();
  }

  /** Source of the loaded agent doc (`AGENTS.md` / `CLAUDE.md`); empty when none. */
  getAgentDocSource(): string {
    return this.turnContext.getAgentDocSource();
  }

  setSkillRegistry(t: SkillRegistry): void {
    if (!this.skillRegistry) this.skillRegistry = t;
  }

  getSkillRegistry(): SkillRegistry | null {
    return this.skillRegistry;
  }

  setMcpManager(m: McpManager): void {
    if (!this.mcpManager) this.mcpManager = m;
  }

  getMcpManager(): McpManager | null {
    return this.mcpManager;
  }

  getExtensionRunner(): ExtensionRunner | null {
    return this.extensions.getExtensionRunner();
  }

  /**
   * Live accessors for the extension runtime (`ctx.signal`, `ctx.getMessages()`, `ctx.llm`, …).
   *
   * One cached object: every accessor resolves through `this` at call time, so the extension side can
   * hold it across runs without ever observing a stale fact.
   */
  getExtensionRuntime(): ExtensionRuntimeAccess {
    if (this.extensionRuntime) return this.extensionRuntime;

    const host = {
      usage: this.usage,
      log: this.log,
      resolveTextAdapter: async () => (await this.resolveTextAdapter?.()) ?? null,
      getExtensionConnection: () => ({
        ...(this.config.modelStyle ? { style: this.config.modelStyle } : {}),
        ...(this.config.modelBaseURL ? { baseURL: this.config.modelBaseURL } : {}),
        ...(this.config.modelApiKey ? { apiKey: this.config.modelApiKey } : {}),
      }),
      getExtensionCatalog: () => this.runtime?.models?.entries,
      getExtensionSignal: () => this.extensionRunSignal(),
      getExtensionModel: () => this.config.model || this.getModelInfo()?.id,
      getExtensionMaxOutputTokens: () => this.config.extensionLlm?.maxOutputTokens,
      consumeExtensionBudget: (extensionId: string) => this.consumeExtensionLlmBudget(extensionId),
      refundExtensionBudget: () => this.refundExtensionLlmBudget(),
    };

    this.extensionRuntime = {
      sessionId: () => this.getSessionData()?.id ?? null,
      sessionName: () => this.getSessionData()?.name || null,
      isIdle: () => !isActiveStatus(this.getStatus()),
      mode: () => this.getAgentMode(),
      model: () => this.config.model || this.getModelInfo()?.id,
      signal: () => this.extensionRunSignal(),
      messages: () => copyModelMessages(this.getMessagesForLLM()),
      contextUsage: () => {
        const limitTokens = this.usage.getTokenLimit();
        // The footer hides the segment at a non-positive limit; reporting `{ fill, 0 }` would make a
        // consumer's percentage `Infinity` instead of "unknown".
        if (limitTokens <= 0) return undefined;
        return { fillTokens: this.usage.getContextFillTokens(), limitTokens };
      },
      systemPrompt: () => this.getSystemPrompt() ?? "",
      complete: (extensionId: string, request: ExtensionLlmRequest): Promise<ExtensionLlmResult> =>
        completeExtensionQuery(host, extensionId, request),
    };
    return this.extensionRuntime;
  }

  /**
   * The current run's abort signal — and only that.
   *
   * `currentAbortController` survives a finished run (it is cleared on session reset, not at run end),
   * so returning it unconditionally made `ctx.signal` truthy while idle and, after a user abort,
   * handed every idle `ctx.llm` call an already-aborted signal. `isIdle()` and `signal` must agree.
   */
  private extensionRunSignal(): AbortSignal | undefined {
    if (isActiveStatus(this.getStatus())) return this.run.currentAbortController?.signal;
    return undefined;
  }

  /** The live context of the extension that owns a command (commands are dispatched by the session). */
  getExtensionContextForCommand(name: string): ExtensionContext | undefined {
    return this.extensions.getExtensionRunner()?.contextForCommand(name);
  }

  /**
   * Count one `ctx.llm` call against the current run's budget.
   *
   * Keyed by the run's abort signal rather than reset by the run lifecycle: a fresh controller means a
   * fresh run, and no lifecycle wiring is needed for a limit that is only ever read here.
   */
  private consumeExtensionLlmBudget(extensionId: string): void {
    // Keyed by the user turn (`currentRunId`), not by the abort controller: tool phases mint a new
    // controller inside one turn (which reset the counter mid-turn), and an idle call has no run to
    // charge. Idle completions are bounded by the output-token cap instead — a command the user typed
    // is not a runaway loop.
    const runId = this.getCurrentRunId();
    if (runId === null) return;
    if (this.extensionLlmBudget.runId !== runId) {
      this.extensionLlmBudget = { runId, count: 0, reported: false };
    }
    const limit = this.config.extensionLlm?.callsPerRun ?? DEFAULT_EXTENSION_CALLS_PER_RUN;
    if (this.extensionLlmBudget.count >= limit) {
      if (!this.extensionLlmBudget.reported) {
        this.extensionLlmBudget.reported = true;
        this.emitEvent("agent:extension-error", {
          extensionId,
          phase: "model-access",
          error: `Extension model budget exhausted (${limit} completions per run).`,
        });
      }
      throw new ExtensionLlmError(
        "budget-exceeded",
        `Extension model budget exhausted: ${limit} completions are allowed per run.`
      );
    }
    this.extensionLlmBudget.count += 1;
  }

  /** Return one budget slot after an attempt that was not billed (see `refundExtensionBudget`). */
  private refundExtensionLlmBudget(): void {
    if (this.extensionLlmBudget.runId === null) return;
    if (this.extensionLlmBudget.count > 0) this.extensionLlmBudget.count -= 1;
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
  registerTool(
    def: ExtensionToolDefinition,
    extensionId = this.id,
    rank?: DispatchRank,
    options: { publishCatalog?: boolean } = {}
  ): void {
    this.extensions.registerTool(def, {
      tools: this.tools,
      ownerId: this.scopedOwnerId(extensionId),
      warn: (message) => this.log?.warn("system", message),
      onToolsChanged: () => {
        this.setRunnerConfigKey(undefined);
        if (options.publishCatalog !== false) this.publishToolPresentationCatalog();
      },
      agentId: this.id,
      rank,
      getExtensionContext: () => this.extensions.getExtensionRunner()?.contextFor(extensionId),
    });
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
    this.publishToolPresentationCatalog();
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
    return scopeExtensionOwnerId(this.id, extensionId);
  }

  /** Publish the current presentation catalog (tool set changed). */
  publishToolPresentationCatalog(): void {
    this.getEventBus()?.emit("session:tool-presentation", { descriptors: this.getToolPresentationCatalog() });
  }

  /** Unregister a command previously added by an extension (used when disabling). */
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
    return this.turnContext.getSystemPrompt();
  }

  /** Alias for the cacheable system prompt prefix (before per-turn dynamic segment). */
  getFrozenSystemPrompt(): string | undefined {
    return this.turnContext.getFrozenSystemPrompt();
  }

  /** Collect `before_agent_start` interceptors + turn-context providers for this user turn. */
  async collectExtensionPromptHooks(prompt: string): Promise<void> {
    await this.turnContext.collectExtensionPromptHooks(prompt);
  }

  clearTurnContext(): void {
    this.memory.clearTurnContext();
    this.turnContext.clearTurnContext();
  }

  resetSystemPrompt(): void {
    this.turnContext.resetSystemPrompt();
  }

  /** Build the ordered dynamic turn-context sections for the current user turn. */
  async getDynamicTurnContextSections(): Promise<TurnContextSection[]> {
    return this.turnContext.getDynamicTurnContextSections();
  }

  /** Live command/task/compact stream hub for hosts and child-run projections. */
  getStreamHub(): AgentStreamHub {
    return this.streamHub;
  }

  /** @internal Bind a child agent to the parent's disk session for task-panel filtering. */
  setSessionScopeId(sessionId: string | undefined): void {
    this.sessionScopeId = sessionId;
  }

  /** @internal Disk session this child belongs to (undefined for legacy/ambient children). */
  getSessionScopeId(): string | undefined {
    return this.sessionScopeId;
  }

  /**
   * Release resources acquired before this agent reached the manager registry.
   * Used only by the bootstrap failure path; a registered agent is torn down through
   * {@link AgentManager} / lifecycle instead (which also releases ownership and scopes).
   */
  async disposeBuiltResources(): Promise<void> {
    try {
      this.getMcpManager()?.forceKill();
    } catch {
      // Best-effort teardown.
    }
    try {
      await this.getExtensionRunner()?.destroyAll();
    } catch {
      // Best-effort teardown.
    }
    try {
      await this.destroyCommandService();
    } catch {
      // Best-effort teardown.
    }
    try {
      this.getMemoryManager()?.dispose();
    } catch {
      // Best-effort teardown.
    }
    try {
      // Flush and unregister the active log guard, not just detach the seam: a
      // half-released binding leaves the process-exit flush pointing at a dead sink.
      this.flushLogOnDestroy();
    } catch {
      // Best-effort teardown.
    }
  }

  /** Lazily build the command service (registry is created on first use). */
  getCommandService(): AgentCommandService {
    if (!this.commandService) {
      this.commandService = new AgentCommandService({
        env: () => this.getCoreEnv(),
        ownerSessionId: () => this.getSessionData?.()?.id,
        onJobsChange: (jobs) => {
          this.eventBus?.emit("session:jobs", { jobs });
        },
      });
    }
    return this.commandService;
  }

  // ============================================================================
  // Auto-approve mode (skip all tool approvals)
  // ============================================================================

  isAutoModeEnabled(): boolean {
    return this.mode.isAutoEnabled();
  }

  setAutoModeEnabled(enabled: boolean): void {
    this.mode.setAuto(enabled);
  }

  /**
   * Whether pending tool approvals should be auto-approved this turn.
   * True when auto mode is on, or plan mode is building a seeded plan.
   */
  shouldAutoApprovePendingTools(): boolean {
    return this.mode.shouldAutoApprove();
  }

  /**
   * Return the current agent mode.
   * Plan mode takes priority over auto mode; normal is the fallback.
   */
  getAgentMode(): AgentMode {
    return this.mode.getMode();
  }

  /**
   * Set the agent to an explicit mode. Modes are mutually exclusive:
   * setting auto exits plan; setting plan exits auto; normal clears both.
   * @returns the resulting mode
   */
  setAgentMode(mode: AgentMode): AgentMode {
    return this.mode.setMode(mode);
  }

  /** Cycle normal → auto → plan → normal. @returns the resulting mode */
  cycleAgentMode(): AgentMode {
    return this.mode.cycle();
  }

  // ============================================================================
  // Plan mode
  // ============================================================================

  enablePlanMode(): void {
    this.mode.enablePlan();
  }

  disablePlanMode(): void {
    this.mode.disablePlan();
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
    return listWorkspacePlansHelper(this);
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
   * Claim compaction status ownership.
   *
   * Auto, manual, and reactive compaction share one generation: only the owner that still holds
   * the current generation may restore `compacting` / `previousStatus`. A session switch bumps the
   * generation through {@link abortManualCompaction}.
   */
  beginCompactionGeneration(): number {
    this.compactGeneration += 1;
    return this.compactGeneration;
  }

  /** Whether a compaction generation still owns the current status. */
  isCompactionCurrent(generation: number | undefined): boolean {
    return generation === undefined || generation === this.compactGeneration;
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
    this.abortManualCompaction(reason ?? "aborted");
    abortManagedAgentRun(this, reason);
    this.cascadeAbortToChildren(reason);
    // A cancelled tool may never reach `onAfterToolCall`, so its command preview has no chance
    // to be marked ended. Settle every command stream here; completed previews remain available
    // for remount, and the bounded prune can now evict them.
    //
    // This is a deliberate stop, not a drain: a chunk that the transport delivers after abort is
    // ignored by the ended stream. The tool result (and the command job's durable log) still owns
    // the final output; only the live preview loses an abort-race tail.
    this.streamHub.endAllCommands();
    // Drop the pre-forked `task` runs this agent started, HERE and not only at the stream's terminal
    // hooks — a run can be abandoned while `chat()` is not running at all.
    //
    // TanStack's `onAbort` fires from inside a `chat()` invocation (its run loop's `finally`), and a
    // wait ENDS that invocation: a run abandoned while paused for an approval or a client tool
    // reaches no terminal hook, so middleware-only discarding leaves the eager runs registered —
    // streaming on until some later run discards them and reports them as its own orphans. See
    // {@link discardRegisteredPreforkRuns} for the other seats that abandon a run this way.
    // `cascadeAbortToChildren` above is the precedent for touching child bookkeeping from here.
    this.discardPreforkRuns();
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

  /**
   * Throw away the eager `task` runs this agent started, reporting what each discard orphaned.
   *
   * For the seats that abandon a run without reaching (or after deferring) a stream terminal hook. A
   * run left behind is not idle: it keeps streaming into whatever transcript comes next, and is later
   * reported as an orphan of a run that never spawned it.
   *
   * The seats are listed here as one inventory because they do not share a call path:
   *
   * - `abort()` — the funnel for every run abort (Esc / force-submit via `interruptCurrentRun`, the
   *   local-session dispatch stop, `AgentManager.destroyAgent`). A session switch reaches it too when
   *   the run is PAUSED: `stopIfActive` treats a registered pre-fork as "still active" and
   *   interrupts, because those subagents can still be writing into the channel being replaced;
   * - `reset()` — a session switch or `/new` rewinds the run state through
   *   `RunCoordinator.resetRunState` without an agent abort, so neither a stream hook nor `abort()`
   *   runs. (`resetRunState` does abort the eager run's controller, which stops the subagent, but the
   *   registry record survives and is misreported by a later run.)
   * - the pump finalizing a turn (`AgentChatController.pumpToolPhases`, cause `"run-finish"`) — the
   *   one case the `onFinish` hook defers and nothing follows: the hook sees a pending tool call and
   *   keeps the pre-forks for the tool phase that will join them, but a call that cannot run (truncated
   *   arguments, cancelled by `cancelIncompleteToolCalls`) is never joined by anything, so the turn's
   *   own end is what has to collect them.
   *
   * Non-creating: an agent that never pre-forked anything allocates nothing and reports nothing.
   *
   * @param cause why the run ended, recorded on each discard (`"run-abort"` for the abort/reset seats,
   * `"run-finish"` for a turn that ended without joining them).
   */
  discardPreforkRuns(cause: PreforkDiscardCause = "run-abort"): void {
    const coordinator = peekTaskPreforkCoordinator(this);
    if (!coordinator || coordinator.size === 0) return;
    discardRegisteredPrefork(this, cause, (discard) => {
      this.emitEvent("subagent:prefork-discarded", {
        toolCallId: discard.toolCallId,
        cause: discard.cause,
        subagentIds: discard.subagentIds,
      });
    });
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

  /** Resolved workspace env for this agent: its runtime's env, or the ambient env. */
  getCoreEnv(): ResolvedCoreEnv {
    return resolveCoreEnv(this.runtime?.env ?? getEnv());
  }

  /**
   * Kill this agent's background jobs and drop the command service (no-op if none was ever
   * created). Called on destroy so a disposed runtime does not leak child processes.
   */
  destroyCommandService(): Promise<void> {
    const service = this.commandService;
    this.commandService = undefined;
    return service?.destroy() ?? Promise.resolve();
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
    if (this.compactAbortController) {
      return { ok: false, error: "Compaction already in progress" };
    }
    const controller = new AbortController();
    const generation = this.beginCompactionGeneration();
    this.compactAbortController = controller;
    try {
      return await runManualCompact(
        createManualCompactHost(this, controller.signal, () => this.compactGeneration === generation),
        manager,
        options
      );
    } finally {
      if (this.compactAbortController === controller) this.compactAbortController = undefined;
    }
  }

  /**
   * Count of `media://` refs the most recent restore could not hydrate (0 = none).
   *
   * The transcript keeps those refs — the files may come back — but the wire cannot carry them:
   * `wire-recovery` swaps each one for a text placeholder so a provider never receives a scheme it
   * cannot fetch. Agent-scoped rather than run-scoped because the condition belongs to the restored
   * history, not to one turn.
   */
  private unhydratedMediaCount = 0;

  /** @internal Record the hydration misses of a restore (`0` clears the flag). */
  setMediaHydrationMisses(count: number): void {
    this.unhydratedMediaCount = Number.isFinite(count) && count > 0 ? count : 0;
  }

  /** @internal Whether the current transcript still holds un-hydratable `media://` refs. */
  hasUnhydratedMedia(): boolean {
    return this.unhydratedMediaCount > 0;
  }

  async restoreSession(sessionId: string): Promise<SessionData> {
    return this.sessionLifecycle.resume(sessionId);
  }

  isToolNeedsApproval(toolName: string): boolean {
    const tools = this.extensions.getManagedToolsProvider()?.() ?? {};
    const tool = tools[toolName];
    return tool != null && "needsApproval" in tool && (tool as { needsApproval?: boolean }).needsApproval === true;
  }

  /** Agent-local model-output shaping; the live tool entry wins. */
  getToolModelOutput(toolName: string): ToModelOutputFn | undefined {
    const toolService = this.toolService;
    toolService.useTools(this.tools);
    return toolService.resolve(toolName)?.toModelOutput ?? getToolMetadata(this.tools[toolName])?.toModelOutput;
  }

  /** Agent-local tool presentation; the live tool entry wins. */
  getToolPresentation(toolName: string): ToolPresentation | undefined {
    const toolService = this.toolService;
    toolService.useTools(this.tools);
    return (
      toolService.resolve(toolName)?.present ??
      getToolMetadata(this.tools[toolName])?.present ??
      getBuiltinToolPresentation(toolName)
    );
  }

  /** Register a decorator on this agent's tool service (owner-scoped). */
  registerToolOutputDecorator(
    toolName: string,
    fn: Parameters<AgentToolService["registerDecorator"]>[1],
    ownerId = this.id
  ): () => void {
    return this.toolService.registerDecorator(toolName, fn, ownerId);
  }

  /** Remove every decorator belonging to an owner (extension disable/destroy). */
  removeToolOutputDecoratorOwner(ownerId = this.id): void {
    this.toolService.removeDecoratorOwner(ownerId);
  }

  /** Presentation catalog for this agent's live tools, not the process-wide union. */
  getToolPresentationCatalog() {
    const toolService = this.toolService;
    toolService.useTools(this.tools);
    return toolService.catalog();
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

  /** Take back the last queued message (see `AgentChatController.popQueuedMessage`). */
  popQueuedMessage(): { kind: "steer" | "followUp"; content: QueuedMessageContent } | null {
    return this.chatController?.popQueuedMessage() ?? null;
  }

  /**
   * Stop the in-flight run if one exists (session switch).
   *
   * Safe when idle: `stopIfActive` is a no-op unless a pump is live or an eager `task` run is still
   * registered — a PAUSED run's subagents can still be writing into the channel being replaced — so
   * a plain resume fires no spurious abort.
   */
  stopActiveRun(reason = "session-switch"): void {
    this.chatController?.stopIfActive(reason);
  }

  /**
   * Stop every producer that can still write a session-scoped stream before a session switch.
   *
   * Clearing the stream hub is not enough: a serial `task` child has no controller registered on
   * the root run, and a manual compaction is not a chat pump. `stopActiveRun` covers a live pump /
   * registered pre-fork; the explicit cascade reaches children that were started outside that
   * surface, and `endAllCommands` settles the root's command previews. Call this before
   * `clearAll()`.
   */
  stopForSessionSwitch(reason: SessionLifecycleReason = "session-switch"): void {
    this.sessionLifecycle.stop(reason);
  }

  /**
   * Cancel the current manual compaction, if any.
   *
   * Keep the controller until {@link compact}'s own `finally` releases it: while the aborted
   * `runManualCompact` is still unwinding (status restoration, persistence), a new `/compact`
   * must not be admitted and overlap that teardown.
   */
  private abortManualCompaction(reason: string): void {
    this.compactGeneration += 1;
    this.compactAbortController?.abort(reason);
  }

  reset(reason: SessionLifecycleReason = "session-switch"): void {
    this.log?.info("agent", "Resetting agent", {
      reason,
      previousStatus: this.getStatus(),
      hadTodos: this.getTodoManager()?.hasTodos() ?? false,
    });
    this.sessionLifecycle.reset(reason);
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
    ui?.setToolPresentationResolver((name) => this.getToolPresentation(name));
    this.runnerWiring.setUIChannel(ui);
  }
}

/** Build the {@link ManualCompactHost} adapter for one agent. */
export function createManualCompactHost(
  managed: ManagedAgent,
  abortSignal?: AbortSignal,
  isCurrent?: () => boolean
): ManualCompactHost {
  return {
    id: managed.id,
    getStatus: () => managed.getStatus(),
    setStatus: (status, trigger) => managed.setStatus(status, trigger ?? "manual-compact"),
    getUI: () => managed.getUI(),
    usage: managed.usage,
    getTodoManager: () => managed.getTodoManager(),
    statusController: managed.statusController,
    compactionConfig: managed.getCompaction().getConfig(),
    getContextWindow: () => managed.getContextWindow(),
    getCoreEnv: () => managed.getCoreEnv(),
    resetSystemPrompt: () => managed.resetSystemPrompt(),
    persistSession: () => managed.persistSession(),
    maybeSaveSessionUIMessages: (messages, reason) => managed.maybeSaveSessionUIMessages(messages, reason),
    getLog: () => managed.log,
    getAbortSignal: () => abortSignal ?? managed.getAbortSignal(),
    ...(isCurrent ? { isCurrent } : {}),
  };
}
