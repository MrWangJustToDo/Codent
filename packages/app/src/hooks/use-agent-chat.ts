import { isActiveStatus, resolvePendingInteractions } from "@codent/core";
import { throttle } from "lodash-es";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toRaw } from "reactivity-store";

import { bindAgentSession } from "../adapter/session-bootstrap.js";
import { clearExtensionCommands } from "../commands/utils/registry.js";
import { syncExtensionCommands } from "../commands/utils/sync-extension-commands.js";
import { useAdapter } from "../context/adapter-context.js";
import { useCoreEnv } from "../context/core-env-context.js";
import { relinkSessionModel } from "../utils/apply-model-selection.js";
import {
  consumeRuntimeSuspend,
  isRuntimeSuspended,
  resolveMountAction,
  resolveUnmountAction,
} from "../utils/runtime-suspend.js";
import { clearSessionScopedCaches } from "../utils/session-caches.js";
import { getActiveHost, getActiveSession, resolveAgentSession } from "../utils/session-resolve.js";
import { resolveStopDecision } from "../utils/stop-decision.js";
import { handleToolLifecycleEvent } from "../utils/tool-timing-store.js";

import { useAgentStatus } from "./use-agent-status.js";
import { useAgent } from "./use-agent.js";
import { useCallbackRef } from "./use-callback-ref.js";
import { useInit } from "./use-init.js";
import { useThinkingLine } from "./use-thinking-line.js";
import { getWorkSpaceInfo } from "./use-workspace-info.js";

import type { AppConfig } from "../adapter/types.js";
import type { Attachment } from "../types/attachment.js";
import type {
  AgentStatus,
  PendingInteractionEntry,
  QueuedMessagesSnapshot,
  SessionInteractionsSnapshot,
} from "@codent/core";
import type { ContentPart, UIMessage } from "@tanstack/ai";

// ============================================================================
// Types
// ============================================================================

export interface SendMessageContent {
  text: string;
  files?: Attachment[];
}

export interface UseAgentChatReturn {
  messages: UIMessage[];
  sendMessage: (content: string | SendMessageContent) => Promise<void>;
  /**
   * Queue a mid-run correction (after current tool batch). Idle → sendMessage.
   *
   * NOTE: Not the default keybinding anymore. Enter (running) → followUp;
   * Option+Enter → forceSubmit. `steer` is for programmatic use where you
   * want the message delivered within the same turn (before the next LLM call).
   */
  steer: (content: string | SendMessageContent) => void;
  /** Queue a message for when the agent would stop. Idle → sendMessage. */
  followUp: (content: string | SendMessageContent) => void;
  /** Force-submit: abort current run, inject message, start new pump. */
  forceSubmit: (content: string | SendMessageContent) => void;
  /**
   * Take the last queued message back, or `null` when nothing is queued. The queue is otherwise a
   * one-way door: wait for delivery, or drop the whole queue with `Esc`.
   */
  recallQueuedMessage: () => Promise<{ kind: "steer" | "followUp"; content: string | ContentPart[] } | null>;
  queuedMessages: QueuedMessagesSnapshot;
  status: AgentStatus;
  isLoading: boolean;
  isReady: boolean;
  stop: () => void;
  error: Error | null;
  initLoading: boolean;
  initError: Error | null | undefined;
  addToolApprovalResponse: (options: {
    id: string;
    approved: boolean;
    reason?: string;
    toolCallId?: string;
    toolName?: string;
  }) => void;
  allPendingApproval: Array<{
    id: string;
    toolName: string;
    toolCallId: string;
  }>;
  allPendingAskUser: Array<{
    toolCallId: string;
    question: string;
    options?: string[];
    multiSelect?: boolean;
  }>;
  /**
   * The interaction core says to present NOW (ask order), or undefined when nothing is pending.
   *
   * Hosts must not derive this from `allPendingApproval` / `allPendingAskUser`: "which kind is more
   * important" is a precedence question, and core already answered it with conversation order.
   */
  pendingInteraction: PendingInteractionEntry | undefined;
  addToolOutput: (options: { tool: string; toolCallId: string; output: Record<string, unknown> }) => void;
  /** Pause/resume status while a client tool waits for user input (`ask_user`). */
  setClientToolWaiting: (active: boolean) => void;
  /**
   * Last session persistence failure message (from `session:save-error`),
   * or empty string when none has occurred. Lets the UI surface disk-write
   * failures instead of silently dropping them.
   */
  saveError: string;
  /**
   * Persistence is owned by core (user-message / pump-complete / force).
   * Kept as a no-op for command-context compatibility.
   */
  saveSessionFromChat: () => void;
}

function attachmentToContentPart(attachment: Attachment, imageIndex?: number): ContentPart {
  if (attachment.type === "image") {
    return {
      type: "image",
      source: { type: "url", value: attachment.dataUrl },
      metadata: {
        mediaType: attachment.mediaType,
        filename: attachment.filename,
        ...(imageIndex !== undefined ? { imageIndex } : {}),
      },
    };
  }
  return {
    type: "text",
    content: `[Attached file: ${attachment.filename}]`,
  };
}

function toChatContent(content: string | SendMessageContent): string | ContentPart[] {
  if (typeof content === "string") return content;
  if (!content.files?.length) return content.text;
  const parts: ContentPart[] = [{ type: "text", content: content.text }];
  let imageIndex = 0;
  for (const file of content.files) {
    if (file.type === "image") {
      imageIndex += 1;
      parts.push(attachmentToContentPart(file, imageIndex));
    } else {
      parts.push(attachmentToContentPart(file));
    }
  }
  return parts;
}

function isAgentLoading(status: AgentStatus): boolean {
  return isActiveStatus(status) && status !== "waiting" && status !== "awaiting_user";
}

// ============================================================================
// Hook
// ============================================================================

export function useAgentChat(config: AppConfig): UseAgentChatReturn {
  const adapter = useAdapter();
  const env = useCoreEnv();

  const { loading: initLoading, error: initError } = useInit((s) => s);

  // const [initLoading, setInitLoading] = useState(true);
  // const [initError, setInitError] = useState<Error | null>(null);
  // Active session is store-owned: switching the active session only flips the
  // pointer (no destroy/rebuild). Derive it here so this hook re-subscribes to
  // the new handle on switch.
  const session = toRaw(useAgent((s) => s.session));
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessagesSnapshot>({ steer: [], followUp: [] });
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [agentError, setAgentError] = useState("");
  const [saveError, setSaveError] = useState("");
  // Pending approvals / ask_user come from core (retained `interaction` channel)
  // instead of each host re-scanning messages.
  const [interactions, setInteractions] = useState<SessionInteractionsSnapshot>({
    pending: [],
    approvals: [],
    askUser: [],
  });

  const initIdRef = useRef(0);
  // Last disk-session id observed on the session/state channels. `session.new` and
  // `session.resume` switch the conversation without replacing the AgentSession handle, so
  // this is how the UI cache is invalidated for in-place switches too.
  const activeSessionIdRef = useRef<string | null | undefined>(undefined);

  const noteSessionIdentity = useCallback((nextSessionId: string | null) => {
    const previousSessionId = activeSessionIdRef.current;
    if (previousSessionId !== undefined && previousSessionId !== nextSessionId) {
      clearSessionScopedCaches();
    }
    activeSessionIdRef.current = nextSessionId;
  }, []);

  // Last model seen on the session/state channels that has been relinked — dedupes
  // the state-channel watcher against the session-switch effect and repeated
  // state events for the same model.
  const relinkedModelRef = useRef<string | null>(null);

  useEffect(() => {
    const currentInitId = ++initIdRef.current;

    const { setLoading: setInitLoading, setError: setInitError } = useInit.getActions();

    const init = async () => {
      // A host suspend (the workspace browser's editor handoff) unmounted the UI without releasing
      // the runtime, so this mount is a RESUME: the session is still bound and may still be running.
      // Initializing here would destroy it and build a second one — exactly what the handoff exists
      // to avoid. Consuming the bit is what stops it leaking into a later, unrelated mount.
      const mountAction = resolveMountAction({
        suspended: isRuntimeSuspended(),
        hasSession: getActiveSession() !== null,
      });
      consumeRuntimeSuspend();
      if (mountAction === "resume") {
        // Nothing to build: the session-switch effect below repopulates from the live snapshot, so
        // the transcript/status/interactions are current without a splash or a second runtime.
        setInitError(null);
        setInitLoading(false);
        return;
      }

      setInitLoading(true);
      setInitError(null);

      try {
        await getWorkSpaceInfo(env);
        await adapter.destroy();
        if (currentInitId !== initIdRef.current) return;

        const result = await adapter.initialize(config);
        if (currentInitId !== initIdRef.current) return;

        bindAgentSession(result.session, result.host);
        // Snapshot population (messages/status/queues/todos) is NOT done here.
        // bindAgentSession activates the new session, which flips `session` and
        // triggers the session-switch effect below to repopulate UI state from its
        // snapshot — single source of truth, so init and switch share one path.
      } catch (e) {
        if (currentInitId !== initIdRef.current) return;
        setInitError(e as Error);
      }

      if (currentInitId !== initIdRef.current) return;
      setTimeout(() => {
        // Host-agnostic reveal. The init splash deliberately does NOT write a raw RIS
        // (Reset to Initial State, `\x1bc`) to the TTY: Ink owns the terminal and
        // tracks it row by row, so an external clear makes Ink skip every row it
        // believes is unchanged — the freshly rendered first frame then stays blank
        // until something else dirties those rows. Switching the tree off the splash
        // and letting Ink repaint it is what actually clears the splash.
        setInitLoading(false);
      }, 200);
    };

    void init();

    return () => {
      // A suspend outlives this mount: keep the bound session and the runtime so the resumed UI
      // re-binds them instead of rebuilding. Every other unmount (process exit, config rebuild)
      // releases them exactly as before.
      if (resolveUnmountAction({ suspended: isRuntimeSuspended() }) === "preserve") return;
      bindAgentSession(null, null);
      void adapter.destroy();
    };
    // Deliberately NOT depending on config.model/baseURL/style/apiKey (or the whole
    // `config` object): createAgentSessionFromConfig writes the resolved provider values
    // back into the config store DURING adapter.initialize (remote-provider mode
    // always changes them). Depending on them here would flip the effect mid-init
    // and rebuild the session, racing with the stale init's host.create — the old
    // session ends up registered too (Header shows "2 sessions"). Only rebuild for
    // inputs that genuinely require a fresh session.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `config` intentionally excluded; see comment above.
  }, [config.systemPrompt, config.maxIterations, config.maxConcurrentTasks, config.mcpConfigPath, adapter, env]);

  useEffect(() => {
    if (!session) return;

    // Initial identity only. The retained channel replay in the subscription effect
    // below is the single source for initial messages/status/queues/interactions;
    // setting the same snapshot here as well applied every bind/switch twice.
    const snap = session.getSnapshot();
    noteSessionIdentity(snap.activeSessionId ?? null);
  }, [noteSessionIdentity, session]);

  useEffect(() => {
    if (!session) return;

    // Extension slash commands live in the UI registry, sourced from the session — not
    // from the bootstrap. Sync on every session (init + switch) and again whenever an
    // extension is toggled (`extensions` channel) so `/skill`, `/mcp`, … stay current.
    syncExtensionCommands(session);

    const setAgentStatus = useAgentStatus.getActions().setStatus;

    const updateUi = throttle((next: UIMessage[]) => {
      setMessages(next);
    }, 60);

    const unsub = session.subscribe(
      (event) => {
        if (event.channel === "messages") {
          updateUi(event.payload);
          return;
        }
        if (event.channel === "queues") {
          setQueuedMessages(event.payload);
          return;
        }
        if (event.channel === "interaction") {
          setInteractions(event.payload);
          return;
        }
        if (event.channel === "state") {
          noteSessionIdentity(event.payload.sessionId ?? null);
          setStatus(event.payload.status);
          setAgentError(event.payload.error);
          setAgentStatus(event.payload.status);
          // In-place resume (`session.resume`) swaps the disk session without
          // changing the agent session identity, so the [session] effect never
          // re-runs. The state channel re-emits the adopted model on every resume
          // (refreshState), so watch it here to re-link the model connection.
          // relinkSessionModel is idempotent (skips non-session entries already
          // linked in the live config), so an echoed /models switch is a no-op.
          const model = event.payload.model;
          if (model && model !== relinkedModelRef.current) {
            relinkedModelRef.current = model;
            void relinkSessionModel(session, model);
          }
          return;
        }
        if (event.channel === "todos") {
          // No store projection — Footer subscribes to the session `todos` channel directly.
          return;
        }
        if (event.channel === "extensions") {
          syncExtensionCommands(session);
          return;
        }
        if (event.channel === "lifecycle") {
          const payload = event.payload;
          if (payload.type === "session:save-error") {
            setSaveError(payload.payload?.error ?? "Session save failed");
            return;
          }
          handleToolLifecycleEvent(payload);
        }
      },
      {
        channels: [
          "messages",
          "queues",
          "state",
          "todos",
          "lifecycle",
          "interaction",
          "extensions",
          "tool-presentation",
        ],
      }
    );

    return () => {
      // Drop a trailing throttled message update from the conversation being left;
      // otherwise it can land after the switch and restore the old transcript.
      updateUi.cancel();
      unsub();
      clearExtensionCommands();
    };
  }, [noteSessionIdentity, session]);

  useEffect(() => {
    let latestThinking = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j];
        if (part.type === "thinking") {
          const content = part.content ?? "";
          if (content.length > 0) {
            // The thinking content streams and grows every tick; splitting the
            // full string each time is O(content). The last non-empty line can
            // only come from the tail — scan a bounded suffix and fall back to
            // a full split only when the tail is entirely blank.
            const tail = content.length > 500 ? content.slice(-500) : content;
            const lines = tail.split("\n").filter((l) => l.trim().length > 0);
            if (lines.length > 0) {
              latestThinking = lines[lines.length - 1];
            } else if (tail.length < content.length) {
              const allLines = content.split("\n").filter((l) => l.trim().length > 0);
              latestThinking = allLines.length > 0 ? allLines[allLines.length - 1] : "";
            }
          }
          break;
        }
      }
      if (latestThinking) break;
    }
    useThinkingLine.getActions().setContent(latestThinking);
  }, [messages]);

  const error = agentError ? new Error(agentError) : null;
  const isLoading = isAgentLoading(status);

  const saveSessionFromChat = useCallbackRef(() => {
    // Core owns session disk writes; `/new` / `/resume` dispatch the session command.
  });

  const stop = useCallback(() => {
    const host = getActiveHost();
    if (session && host) {
      // Only a user-visible `task` delegation takes the subagent-first branch: the task
      // subagent is stopped first so its cancellation reaches the parent, and the parent
      // run is left to finish the turn. Internal workers (compaction / memory summarizers)
      // share the `subagents` snapshot but have no such contract, so they must not decide
      // this — an unfiltered active set is satisfied by the summarizer itself, which made
      // `stop()` a no-op for the session and let compaction restart on its own.
      const decision = resolveStopDecision(session.getSnapshot().subagents);
      if (!decision.stopSession) {
        for (const childId of decision.taskSubagentIds) {
          void resolveAgentSession(childId)?.dispatch({ type: "stop" });
        }
        return;
      }
    }
    void session?.dispatch({ type: "stop" });
  }, [session]);

  const sendMessage = useCallback(
    async (content: string | SendMessageContent) => {
      if (!session) return;
      await session.dispatch({ type: "send", content: toChatContent(content) });
    },
    [session]
  );

  const steer = useCallback(
    (content: string | SendMessageContent) => {
      if (!session) return;
      void session.dispatch({ type: "steer", content: toChatContent(content) });
    },
    [session]
  );

  const followUp = useCallback(
    (content: string | SendMessageContent) => {
      if (!session) return;
      void session.dispatch({ type: "followUp", content: toChatContent(content) });
    },
    [session]
  );

  const recallQueuedMessage = useCallback(async () => {
    if (!session) return null;
    const result = await session.dispatch({ type: "queue.pop" });
    if (!result.ok) return null;
    return result.data ?? null;
  }, [session]);

  const forceSubmit = useCallback(
    (content: string | SendMessageContent) => {
      if (!session) return;
      void session.dispatch({ type: "forceSubmit", content: toChatContent(content) });
    },
    [session]
  );

  const addToolApprovalResponse = useCallback(
    async (options: { id: string; approved: boolean; reason?: string; toolCallId?: string; toolName?: string }) => {
      await session?.dispatch({
        type: "respondApproval",
        approvalId: options.id,
        approved: options.approved,
        reason: options.reason,
      });
    },
    [session]
  );

  // Core derives these (retained `interaction` channel / snapshot); hosts no
  // longer scan messages themselves.
  const allPendingApproval = useMemo<UseAgentChatReturn["allPendingApproval"]>(
    () => interactions.approvals.map((a) => ({ id: a.approvalId, toolName: a.toolName, toolCallId: a.toolCallId })),
    [interactions]
  );

  const allPendingAskUser = useMemo<UseAgentChatReturn["allPendingAskUser"]>(
    () => interactions.askUser,
    [interactions]
  );

  // Core publishes the ordered queue; `[0]` is the one on screen. `resolvePendingInteractions` is
  // the ONE place that also rebuilds it for an older publisher (no `pending` field): hosts must not
  // each write their own fallback precedence.
  const pendingInteraction = useMemo<PendingInteractionEntry | undefined>(
    () => resolvePendingInteractions(interactions)[0],
    [interactions]
  );

  const setClientToolWaiting = useCallback(
    (active: boolean) => {
      void session?.dispatch({ type: "setClientToolWaiting", active });
    },
    [session]
  );

  const addToolOutput = useCallback(
    async (options: { tool: string; toolCallId: string; output: Record<string, unknown> }) => {
      await session?.dispatch({
        type: "addToolResult",
        toolCallId: options.toolCallId,
        output: options.output,
      });
    },
    [session]
  );

  return {
    messages,
    sendMessage,
    steer,
    followUp,
    forceSubmit,
    recallQueuedMessage,
    queuedMessages,
    allPendingApproval,
    allPendingAskUser,
    pendingInteraction,
    addToolOutput,
    setClientToolWaiting,
    status,
    isLoading,
    isReady: !initLoading && session !== null,
    stop,
    error,
    initLoading,
    initError,
    addToolApprovalResponse,
    saveSessionFromChat,
    saveError,
  };
}
