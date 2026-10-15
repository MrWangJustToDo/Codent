/**
 * Transport-agnostic Agent Session protocol.
 *
 * TODO(messages-incremental): Session currently delivers full `UIMessage[]` on
 * snapshot and the `messages` channel. A future change may add JSON-patch / delta
 * delivery for large histories — do not assume patches in hosts yet.
 *
 * Session lifecycle note:
 * - `clear` clears in-place messages (and related chat state) on the current agent.
 * - Creating a brand-new agent / disk session is Host.create (+ switch active id), not `clear`.
 */

import type { AgentEvent } from "../agent/agent-event-bus";
import type { ExtensionInfo, ExtensionRenderPayload, ExtensionUiContext } from "../agent/extension/types.js";
import type { McpServerStatus } from "../agent/mcp/manager.js";
import type { PlanModeState } from "../agent/plan/plan-mode-controller.js";
import type { SummaryStreamEvent, SummaryStreamSnapshot } from "../agent/summary-stream/types.js";
import type { TodoItem } from "../agent/todo/types.js";
import type { ToolPresentationInfo } from "../agent/tools/presentation/types.js";
import type { StreamingChunk } from "../agent/tools/util/streaming-callback.js";
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
  /** Clear messages on the current agent. New agents use Host.create, not this command. */
  | { type: "clear" }
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
  /** Set reasoning-effort level for the current session (`/effort`). */
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
   * Start a fresh on-disk session (slash `/clear`): persist current if needed, reset
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

export type AgentSessionCommandResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string; code?: "unsupported" | "not_found" | "invalid" | "failed" };

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

export type AgentSessionEvent =
  | { channel: "state"; payload: AgentL1State; ts: number }
  | { channel: "messages"; payload: UIMessage[]; ts: number }
  | { channel: "queues"; payload: QueuedMessagesSnapshot; ts: number }
  | { channel: "usage"; payload: UsageChangeSnapshot; ts: number }
  | { channel: "todos"; payload: { items: TodoItem[]; title: string | null }; ts: number }
  | { channel: "plan"; payload: PlanModeState; ts: number }
  | {
      channel: "tool";
      payload: { kind: "chunk"; chunk: StreamingChunk } | { kind: "clear"; toolCallId: string };
      ts: number;
    }
  | { channel: "summary"; payload: SummaryStreamEvent; ts: number }
  | { channel: "lifecycle"; payload: AgentEvent; ts: number }
  | { channel: "extension-ui"; payload: ExtensionUIEvent; ts: number }
  | { channel: "extensions"; payload: AgentSessionExtensionsSummary; ts: number }
  | { channel: "tool-presentation"; payload: { descriptors: ToolPresentationInfo[] }; ts: number }
  | { channel: "mcp"; payload: AgentSessionMcpSummary; ts: number }
  | { channel: "mode"; payload: { mode: AgentMode; autoMode: boolean }; ts: number }
  | { channel: "interaction"; payload: SessionInteractionsSnapshot; ts: number }
  | { channel: "iteration"; payload: AgentIterationState; ts: number }
  | { channel: "jobs"; payload: SessionJobsSnapshot; ts: number }
  | { channel: "subagents"; payload: { subagents: AgentSessionSubagentSummary[] }; ts: number };

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
  /** Authoritative summary-stream state for remount (subscribe first, then call). */
  getSummaryStreamSnapshot(key: string): SummaryStreamSnapshot | null;
  /** All live summary streams (client cache seeding / remount over HTTP). */
  listSummaryStreamSnapshots?(): SummaryStreamSnapshot[];
  dispatch(command: AgentSessionCommand): Promise<AgentSessionCommandResult>;
  subscribe(handler: AgentSessionSubscriber, options?: AgentSessionSubscribeOptions): () => void;
  close?(): Promise<void>;
}
