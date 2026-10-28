/**
 * Transport-agnostic Agent Session protocol.
 *
 * TODO(messages-incremental): Session currently delivers full `UIMessage[]` on
 * snapshot and the `messages` channel. A future change may add JSON-patch / delta
 * delivery for large histories — do not assume patches in hosts yet.
 *
 * Session lifecycle note:
 * - `session.new` starts a fresh disk session; `session.resume` switches to an existing one.
 * - There is no in-place `clear` command: a new conversation is always a new session.
 */

import type { AgentEvent } from "../agent/agent-event-bus";
import type {
  ExtensionCommandOption,
  ExtensionInfo,
  ExtensionRenderPayload,
  ExtensionUiContext,
} from "../agent/extension/types.js";
import type { McpServerStatus } from "../agent/mcp/manager.js";
import type { BeginPlanExecutionResult, PlanModeState } from "../agent/plan/plan-mode-controller.js";
import type { AgentStreamEvent, AgentStreamSnapshot, StreamingChunk } from "../agent/stream-hub/types.js";
import type { TodoItem } from "../agent/todo/types.js";
import type { ToolPresentation, ToolPresentationInfo } from "../agent/tools/presentation/types.js";
import type { UsageHistoryResult } from "../agent/usage/usage-store.js";
import type { QueuedMessagesSnapshot } from "../managers/controllers/agent-chat-controller.js";
import type { AgentL1State, AgentMode } from "../managers/managed-agent.js";
import type { UsageChangeSnapshot } from "../managers/telemetry/usage-tracker.js";
import type { ModelInfo, ModelStyle, ReasoningEffort } from "../models/types.js";
import type { AgentRetryState } from "../runtime-types/agent-retry.js";
import type { AgentStatus } from "../runtime-types/agent-status.js";
import type {
  AgentSessionSubagentSummary,
  AgentIterationState,
  SessionInteractionsSnapshot,
  QueuedMessageContent,
  SessionJobsSnapshot,
} from "../runtime-types/session-payloads.js";
import type { ContentPart, UIMessage } from "@tanstack/ai";

// ============================================================================
// Snapshot
// ============================================================================

// ============================================================================
// Channels
// ============================================================================

export const AGENT_SESSION_CHANNELS = [
  "state",
  "messages",
  "queues",
  "usage",
  "todos",
  "plan",
  "tool",
  "summary",
  "lifecycle",
  "extension-ui",
  "extensions",
  "tool-presentation",
  "mcp",
  "mode",
  "interaction",
  "iteration",
  "jobs",
  "subagents",
] as const;

export type AgentSessionChannel = (typeof AGENT_SESSION_CHANNELS)[number];

/** Channels delivered when `subscribe()` omits `channels`. */
export const DEFAULT_AGENT_SESSION_CHANNELS: readonly AgentSessionChannel[] = [
  "state",
  "messages",
  "queues",
  "usage",
  "todos",
  "plan",
  "tool",
  "summary",
  "lifecycle",
  // Pending approvals / ask_user — core derives it, hosts should not re-scan.
  "interaction",
  // Agent-loop progress for the current run (1-based iteration vs budget).
  "iteration",
  // Background command jobs (retained). Subscribed by default on purpose: the
  // channel is projected from `session:jobs`, and a remote client that had to
  // opt in explicitly would never see it — the same reasoning recorded for `mcp`
  // below. The payload is counts/summaries only, so the extra frame is cheap.
  "jobs",
  // Child-agent rows (retained). Default for the same reason as `jobs`: no host
  // opts in explicitly, and it is the only channel that can add or drop a task row
  // off-process — `subagent:created`/`:destroyed` carry a single id.
  "subagents",
  // `mcp` is a retained projection (see `session:mcp`); it gets no explicit
  // `channels:[...]` opt-in from any host, so without this it is never delivered.
  "mcp",
];

export interface AgentSessionMcpSummary {
  servers: McpServerStatus[];
}

export interface AgentSessionExtensionsSummary {
  extensions: ExtensionInfo[];
}

/**
 * A child agent (a `task` delegation or an internal worker), as a status surface sees it.
 *
 * Re-exported from `runtime-types/session-payloads` (where the projection's own layer can reach
 * it) so the published name and its import path through this module are unchanged.
 */
export type { AgentSessionSubagentSummary } from "../runtime-types/session-payloads.js";

/**
 * A PERSISTED conversation id (`ses_…`): the `SessionData.id`, the `.agents/sessions/<id>.jsonl`
 * file name, and the `.agents/logs/<id>/` directory.
 *
 * Deliberately spelled differently from the AgentSession HANDLE, which is addressed by `agentId`.
 * The two have different lifetimes — a disk session survives a process restart, an agent id does
 * not — and one word for both was the main source of confusion in this API. Annotate disk ids with
 * this type; `activeSessionId` on the snapshot/list entry is the conversation an agent is
 * currently attached to (not "the session's own id").
 */
export type DiskSessionId = string;

export interface AgentSessionSnapshot {
  agentId: string;
  parentId?: string;
  name: string;
  status: AgentStatus;
  /**
   * The disk session ({@link DiskSessionId}) this agent is currently attached to; absent before
   * one exists. Named `active…` on purpose: the binding is one-at-a-time and can switch
   * (`/resume`), and the handle itself is addressed by `agentId`, never by this.
   */
  activeSessionId?: DiskSessionId;
  error: string;
  pendingApprovalCount: number;
  /** Present while a recoverable LLM failure is being retried (see {@link AgentRetryState}). */
  retry?: AgentRetryState | null;
  mode: AgentMode;
  lastStreamDurationMs: number;
  /** The last run's model finish reason, or null before one. */
  lastFinishReason: string | null;
  /**
   * The last finalized turn's iteration reading (`iteration` is reset at finalize).
   *
   * Needed for stop-reason classification: a turn can end exactly at its budget, and the live
   * counter is cleared on the way out, so a consumer reading `iteration` after the turn always
   * sees `0`.
   */
  lastIteration: AgentIterationState | null;
  /** Model name (informational). */
  model?: string;
  /** Model metadata (incl. reasoningConfig / effortValues) for UI display. */
  modelInfo?: ModelInfo;
  /** Current reasoning-effort level for this session (undefined = model default). */
  reasoningEffort?: ReasoningEffort;
  messages: UIMessage[];
  queues: QueuedMessagesSnapshot;
  usage: UsageChangeSnapshot;
  todos: TodoItem[];
  todosTitle: string | null;
  plan: PlanModeState;
  autoMode: boolean;
  mcp: AgentSessionMcpSummary;
  extensions: AgentSessionExtensionsSummary;
  /**
   * Serializable projection of the tool presentation registry (no functions), so a host
   * can render rows that have no per-call `part.display` yet — executing tools, older
   * messages — and off-process hosts (remote session, extension hosts) see the same
   * fold buckets and row rules as core.
   */
  toolDescriptors: ToolPresentationInfo[];
  /** Pending approvals / ask_user, mirroring the retained `interaction` channel. */
  interactions: SessionInteractionsSnapshot;
  /** Background command jobs started by this agent, mirroring the retained `jobs` channel. */
  jobs: SessionJobsSnapshot;
  /** Agent-loop progress for the current run, mirroring the retained `iteration` channel. */
  iteration: AgentIterationState;
  subagents: AgentSessionSubagentSummary[];
}

// ============================================================================
// Commands
// ============================================================================

export type AgentSessionMessageContent = string | ContentPart[];

export type AgentSessionCommand =
  | { type: "send"; content: AgentSessionMessageContent }
  | { type: "steer"; content: AgentSessionMessageContent }
  | { type: "followUp"; content: AgentSessionMessageContent }
  | { type: "forceSubmit"; content: AgentSessionMessageContent }
  /** Take back the last queued message, so a queued message is not a one-way door. */
  | { type: "queue.pop" }
  | { type: "stop" }
  | { type: "respondApproval"; approvalId: string; approved: boolean; reason?: string }
  | { type: "addToolResult"; toolCallId: string; output: Record<string, unknown> }
  | { type: "setClientToolWaiting"; active: boolean }
  | { type: "compact"; focus?: string }
  | { type: "rename"; name: string }
  /** Side-LLM title generation on the Host process (not in the UI). */
  | { type: "rename.generate" }
  | { type: "mode.set"; mode: AgentMode }
  | { type: "mode.toggle" }
  | { type: "plan.execute"; sendSteer?: boolean }
  | { type: "plan.cancel" }
  | { type: "plan.save"; nameHint?: string }
  | { type: "plan.load"; name: string }
  | { type: "plan.list" }
  | { type: "plan.complete" }
  | { type: "mcp.refresh" }
  | { type: "extension.toggle"; id: string; enabled: boolean }
  | { type: "extension.invokeCommand"; name: string; args?: string[] }
  | { type: "extension.getCommandOptions"; name: string; args?: string[] }
  /**
   * Restore an on-disk session onto the current agent (mid-session switch).
   * Same `ManagedAgent.restoreSession` path as Host.create `{ resumeSessionId | continueSession }`.
   * Also clears steer/follow-up queues and reconciles approval / ask_user status
   * from the restored messages.
   */
  | { type: "session.resume"; sessionId: DiskSessionId }
  /** List on-disk sessions for the resume picker. */
  | { type: "session.list" }
  /** Set reasoning-effort level for the current session (chosen via `/models <model> [effort|off]`). */
  | { type: "effort.set"; effort?: ReasoningEffort }
  /** Switch the model for the current session without rebuilding it (`/model`). */
  | {
      type: "model.set";
      model?: string;
      modelStyle?: ModelStyle;
      modelBaseURL?: string;
      modelApiKey?: string;
      modelInfo?: ModelInfo | null;
    }
  /**
   * Start a fresh on-disk session (slash `/new`): persist current if needed, reset
   * transcript/plan/auto/todos, create a new SessionData. Prefer Host.create for a
   * brand-new agent process.
   */
  | { type: "session.new" }
  /**
   * Duplicate the current session into a new one and switch to it (`/clone`).
   * The source session is left untouched.
   */
  | { type: "session.clone"; name?: string }
  /**
   * Start a new session from an earlier user message (`/fork`): copy the messages
   * strictly before `upToMessageId`, switch to the new session, and return that
   * message's text so the caller can put it back in the editor.
   */
  | { type: "session.fork"; upToMessageId: string; name?: string }
  /** Query the global usage history store for the contribution graph (`/usage`). */
  | { type: "usage.history"; weeks?: number };

/** One row of `session.list` / the resume picker's disk catalog. */
export interface AgentSessionListRow {
  id: DiskSessionId;
  name: string;
  model: string;
  updatedAt: number;
  createdAt: number;
}

/**
 * Per-command success payloads. The command side now has the same single source of truth the
 * channel side has: adding a command without a row is a compile error, and hosts consume
 * `result.data` without re-declaring its shape at every call site.
 */
export interface AgentSessionCommandResultData {
  send: undefined;
  steer: undefined;
  followUp: undefined;
  forceSubmit: undefined;
  "queue.pop": { kind: "steer" | "followUp"; content: QueuedMessageContent } | null;
  stop: undefined;
  respondApproval: undefined;
  addToolResult: undefined;
  setClientToolWaiting: undefined;
  compact: { ok: true; message: string; tokensBefore?: number; tokensAfter?: number };
  rename: { name: string };
  "rename.generate": { name: string };
  "mode.set": { mode: AgentMode };
  "mode.toggle": { mode: AgentMode };
  "plan.execute": BeginPlanExecutionResult;
  "plan.cancel": undefined;
  "plan.save": { ok: boolean; path?: string; error?: string };
  "plan.load": { ok: boolean; path?: string; error?: string; stepCount?: number };
  "plan.list": { files: string[] };
  "plan.complete": undefined;
  "mcp.refresh": { servers: McpServerStatus[] };
  "extension.toggle": { ok: boolean; message: string };
  "extension.invokeCommand": { message?: string };
  "extension.getCommandOptions": { options: ExtensionCommandOption[] };
  "session.resume": {
    sessionId: DiskSessionId;
    name: string;
    model: string;
    uiMessages: UIMessage[];
  };
  "session.list": { sessions: AgentSessionListRow[] };
  "session.new": { sessionId: DiskSessionId };
  "session.clone": {
    sessionId: DiskSessionId;
    name: string;
    model: string;
    uiMessages: UIMessage[];
  };
  "session.fork": {
    sessionId: DiskSessionId;
    name: string;
    model: string;
    uiMessages: UIMessage[];
    forkText?: string;
  };
  "usage.history": UsageHistoryResult & { weeks: number };
  "effort.set": { effort: ReasoningEffort | undefined };
  "model.set": { model: string; modelStyle: ModelStyle; modelBaseURL?: string };
}

type _MissingCommandResultKeys = Exclude<keyof AgentSessionCommandResultData, AgentSessionCommand["type"]>;
type _ExtraCommandResultKeys = Exclude<AgentSessionCommand["type"], keyof AgentSessionCommandResultData>;
type _AssertCommandResultMapComplete = [_MissingCommandResultKeys | _ExtraCommandResultKeys] extends [never]
  ? true
  : _MissingCommandResultKeys | _ExtraCommandResultKeys;
const _commandResultMapComplete: _AssertCommandResultMapComplete = true;
void _commandResultMapComplete;

export type AgentSessionCommandFailure = {
  ok: false;
  error: string;
  code?: "unsupported" | "not_found" | "invalid" | "failed";
};

export type AgentSessionCommandResultFor<C extends AgentSessionCommand["type"]> =
  { ok: true; data?: AgentSessionCommandResultData[C] } | AgentSessionCommandFailure;

export type AgentSessionCommandResult = { ok: true; data?: unknown } | AgentSessionCommandFailure;

// ============================================================================
// Subscribe payloads
// ============================================================================

/**
 * Extension UI notification forwarded from the extension runner to session
 * subscribers on the `extension-ui` channel. Mirrors the events published via
 * `ExtensionUI` (`render`, `notify`, `context`) so hosts can render extension
 * surfaces without touching ManagedAgent.
 */
export type ExtensionUIEvent =
  | { type: "render"; surface: string; key: string; payload: ExtensionRenderPayload | null }
  | { type: "notify"; message: string; level?: "success" | "info" | "error" }
  | { type: "context"; context: ExtensionUiContext };

/**
 * The channel → payload pairing, in one place. {@link AgentSessionEvent} is derived from it, and
 * `AGENT_EVENT_META` is constrained against it, so a channel paired with the wrong payload type is
 * not expressible. `channel` alone is a free string and the projector's per-case `as` erases the
 * payload side, which is how `session:mcp` could be routed to `"plan"` and still compile.
 */
export interface AgentSessionChannelPayloads {
  state: AgentL1State;
  messages: UIMessage[];
  queues: QueuedMessagesSnapshot;
  usage: UsageChangeSnapshot;
  todos: { items: TodoItem[]; title: string | null };
  plan: PlanModeState;
  tool: { kind: "chunk"; chunk: StreamingChunk } | { kind: "clear"; toolCallId: string };
  summary: AgentStreamEvent;
  lifecycle: AgentEvent;
  "extension-ui": ExtensionUIEvent;
  extensions: AgentSessionExtensionsSummary;
  "tool-presentation": { descriptors: ToolPresentationInfo[] };
  mcp: AgentSessionMcpSummary;
  mode: { mode: AgentMode; autoMode: boolean };
  interaction: SessionInteractionsSnapshot;
  iteration: AgentIterationState;
  jobs: SessionJobsSnapshot;
  subagents: { subagents: AgentSessionSubagentSummary[] };
}

export type AgentSessionEvent = {
  [C in AgentSessionChannel]: { channel: C; payload: AgentSessionChannelPayloads[C]; ts: number };
}[AgentSessionChannel];

/**
 * Compile-time completeness check against {@link AgentSessionChannel}.
 *
 * A missing key is already an error (the mapped type above needs it); this catches the other half — a
 * key left behind after a channel is renamed, which would otherwise sit here unread.
 */
type _MissingChannelPayloadKeys = Exclude<AgentSessionChannel, keyof AgentSessionChannelPayloads>;
type _ExtraChannelPayloadKeys = Exclude<keyof AgentSessionChannelPayloads, AgentSessionChannel>;
type _AssertChannelPayloadMapExact = [_MissingChannelPayloadKeys | _ExtraChannelPayloadKeys] extends [never]
  ? true
  : _MissingChannelPayloadKeys | _ExtraChannelPayloadKeys;
const _channelPayloadMapExact: _AssertChannelPayloadMapExact = true;
void _channelPayloadMapExact;

export type AgentSessionSubscriber = (event: AgentSessionEvent) => void;

export interface AgentSessionSubscribeOptions {
  channels?: AgentSessionChannel[];
}

// ============================================================================
// Session interface
// ============================================================================

export interface AgentSession {
  readonly id: string;
  getSnapshot(): AgentSessionSnapshot;
  /** Authoritative live-stream state for remount (subscribe first, then call). */
  getAgentStreamSnapshot(key: string): AgentStreamSnapshot | null;
  /** All live summary streams (client cache seeding / remount over HTTP). */
  listAgentStreamSnapshots?(): AgentStreamSnapshot[];
  /** Session-scoped tool presentation (local agent catalog or a remote snapshot's descriptors). */
  getToolPresentation?(name: string): ToolPresentation | undefined;
  dispatch<C extends AgentSessionCommand["type"]>(
    command: Extract<AgentSessionCommand, { type: C }>
  ): Promise<AgentSessionCommandResultFor<C>>;
  subscribe(handler: AgentSessionSubscriber, options?: AgentSessionSubscribeOptions): () => void;
  close?(): Promise<void>;
}
