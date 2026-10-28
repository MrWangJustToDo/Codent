import { BUILTIN_TOOL_NAMES } from "@codent/core";
import { useEffect, useMemo, useRef } from "react";

import { dispatchCommand } from "../commands";
import { exitWithSummary } from "../utils/exit-with-summary.js";
import { queuedTailIsText } from "../utils/queue-preview.js";
import { getActiveHost, getActiveSession } from "../utils/session-resolve.js";

import { useAutocomplete } from "./use-autocomplete.js";
import { useCommandOutput } from "./use-command-output.js";
import { useConfig } from "./use-config.js";
import { useInputMode } from "./use-input-mode.js";
import { useSelect } from "./use-select.js";
import { useUserInput } from "./use-user-input.js";

import type { AgentAdapter } from "../adapter/types.js";
import type { CommandContext } from "../commands";
import type { DenyingToolInfo } from "./keybindings/context.js";
import type { UseAgentChatReturn } from "./use-agent-chat.js";
import type { UseAgentKeybindingsOptions } from "./use-agent-keybindings.js";
import type { UIMessage } from "@tanstack/ai";

interface UseAgentInputControlsOptions {
  adapter: AgentAdapter;
  initialPrompt?: string;
  isReady: boolean;
  isLoading: boolean;
  initLoading: boolean;
  messages: UIMessage[];
  sendMessage: UseAgentChatReturn["sendMessage"];
  steer: UseAgentChatReturn["steer"];
  followUp: UseAgentChatReturn["followUp"];
  forceSubmit: UseAgentChatReturn["forceSubmit"];
  recallQueuedMessage: UseAgentChatReturn["recallQueuedMessage"];
  queuedMessages: UseAgentChatReturn["queuedMessages"];
  stop: UseAgentChatReturn["stop"];
  addToolApprovalResponse: UseAgentChatReturn["addToolApprovalResponse"];
  addToolOutput: UseAgentChatReturn["addToolOutput"];
  setClientToolWaiting: UseAgentChatReturn["setClientToolWaiting"];
  allPendingApproval: UseAgentChatReturn["allPendingApproval"];
  allPendingAskUser: UseAgentChatReturn["allPendingAskUser"];
  saveSessionFromChat: UseAgentChatReturn["saveSessionFromChat"];
}

/**
 * The chat screen's state and handlers: everything the main screen needs that is *not* a keyboard
 * registration.
 *
 * Registration lives in `ChatKeybindings`, which the chat screen mounts, so the handlers are
 * subscribed only while that screen is on screen. What stays here runs regardless of which screen
 * is up — an approval or `ask_user` arriving while a panel is open still switches the input mode
 * and fills the select store, so closing the panel leaves `y` / `n` usable immediately.
 *
 * @returns The keybinding context for `useAgentKeybindings` (called from inside the `main` scope).
 */
export function useAgentInputControls({
  adapter,
  initialPrompt,
  isReady,
  isLoading,
  initLoading,
  messages,
  sendMessage,
  steer,
  followUp,
  forceSubmit,
  recallQueuedMessage,
  queuedMessages,
  stop,
  addToolApprovalResponse,
  addToolOutput,
  setClientToolWaiting,
  allPendingApproval,
  allPendingAskUser,
  saveSessionFromChat,
}: UseAgentInputControlsOptions): UseAgentKeybindingsOptions {
  const hasInitRef = useRef(false);
  const denyingRef = useRef<DenyingToolInfo | null>(null);
  const askUserStartTimeRef = useRef<number>(0);
  const prevPendingQuestionRef = useRef<string | undefined>(undefined);

  const inputActions = useUserInput.getActions();
  const autocompleteActions = useAutocomplete.getActions();
  const isAutocompleteVisible = useAutocomplete((s) => s.visible);
  const selectActions = useSelect.getActions();
  const isSelectVisible = useSelect((s) => s.visible);
  const commandOutputActions = useCommandOutput.getActions();
  const { mode, denyMode } = useInputMode((s) => ({ mode: s.mode, denyMode: s.denyMode }));
  const modeActions = useInputMode.getActions();

  const pendingApproval = allPendingApproval[0];
  const currentPendingIsLast = useMemo(() => {
    if (!pendingApproval) return true;
    const index = allPendingApproval.findIndex((item) => item.id === pendingApproval.id);
    return index === allPendingApproval.length - 1;
  }, [allPendingApproval, pendingApproval]);
  const pendingAskUser = allPendingAskUser[0];
  const setMode = modeActions.setMode;
  const setLoading = inputActions.setLoading;

  useEffect(() => {
    if (denyMode) {
      setMode("freeform");
    } else if (isSelectVisible) {
      setMode("select");
    } else if (allPendingApproval.length > 0) {
      setMode("approval");
    } else {
      setMode("normal");
    }
  }, [allPendingApproval.length, denyMode, isSelectVisible, setMode]);

  const askUserToolCallId = pendingAskUser?.toolCallId;
  const clientToolWaitingRef = useRef(false);
  useEffect(() => {
    // Depend on the stable toolCallId (not the pending object — fresh
    // interaction snapshots change its reference every emit) and dispatch only
    // when the boolean flips, so repeated interaction events cannot re-trigger
    // setClientToolWaiting and feed an app↔core emit loop.
    const waiting = !!askUserToolCallId;
    if (clientToolWaitingRef.current === waiting) return;
    clientToolWaitingRef.current = waiting;
    setClientToolWaiting(waiting);
  }, [askUserToolCallId, setClientToolWaiting]);

  const submitAskUserAnswer = (answer: string, meta?: { selected?: string[]; draft?: string }) => {
    if (!pendingAskUser) return;
    // setClientToolWaiting(false);
    const durationMs = askUserStartTimeRef.current ? Date.now() - askUserStartTimeRef.current : 0;
    addToolOutput({
      tool: BUILTIN_TOOL_NAMES.askUser,
      toolCallId: pendingAskUser.toolCallId,
      output: {
        question: pendingAskUser.question,
        answer,
        hasOptions: !!pendingAskUser.options?.length,
        // Structured multi-select info: lets the UI echo and the model-facing
        // result clearly represent a multi-choice answer instead of an ambiguous
        // comma-joined string (option text may itself contain commas).
        multiSelect: !!pendingAskUser.multiSelect,
        selected: meta?.selected && meta.selected.length > 0 ? meta.selected : undefined,
        draft: meta?.draft || undefined,
        durationMs,
        cachedOutputPath: null,
      },
    });
    askUserStartTimeRef.current = 0;
  };

  useEffect(() => {
    const key = pendingAskUser?.toolCallId;
    if (key && key !== prevPendingQuestionRef.current) {
      prevPendingQuestionRef.current = key;
      askUserStartTimeRef.current = Date.now();
      const hasOptions = pendingAskUser.options && pendingAskUser.options.length > 0;
      if (hasOptions) {
        const opts = pendingAskUser.options!.map((option) => ({ label: option, value: option }));
        opts.push({ label: "Your answer...", value: "__freeform__" });
        selectActions.open(opts, pendingAskUser.multiSelect ?? false, true);
      } else {
        inputActions.clear();
        inputActions.setLoading(false);
        modeActions.setDenyMode(true, BUILTIN_TOOL_NAMES.askUser);
      }
    } else if (!key && prevPendingQuestionRef.current) {
      prevPendingQuestionRef.current = undefined;
      selectActions.close();
    }
  }, [inputActions, modeActions, pendingAskUser, selectActions]);

  useEffect(() => {
    if (!isReady || !initialPrompt || hasInitRef.current) return;
    hasInitRef.current = true;
    // Consume the positional prompt: the ref is per MOUNT, so an editor-handoff remount would
    // otherwise send it a second time into the same conversation. Clearing the store value makes
    // "once" hold per launch — a new process re-initializes it from the CLI argument, and neither
    // a runtime rebuild nor `session.new` (both keep the empty value) re-sends it.
    useConfig.getActions().updateConfig({ initialPrompt: "" });
    sendMessage(initialPrompt);
  }, [isReady, initialPrompt, sendMessage]);

  useEffect(() => {
    setLoading(initLoading || isLoading);
  }, [isLoading, initLoading, setLoading]);

  const commandCtx: CommandContext = {
    inputActions,
    getInputState: () => useUserInput.getReadonlyState(),
    getSession: () => getActiveSession(),
    getMessages: () => messages,
    saveSessionFromChat,
    exit: () => {
      exitWithSummary({
        adapter,
        session: getActiveSession(),
        destroySession: (sessionId) => void getActiveHost()?.destroy(sessionId),
      });
    },
    adapter,
    addToolApprovalResponse,
  };

  const acceptAutocomplete = (triggerSubmit: boolean): boolean => {
    if (!isAutocompleteVisible) return false;
    const currentInput = useUserInput.getReadonlyState().value;
    const result = autocompleteActions.accept(currentInput);
    if (!result) return false;
    inputActions.setValue(result.value);
    if (triggerSubmit && result.type === "execute") {
      setTimeout(() => handleNormalSubmit(), 0);
    }
    return true;
  };

  /**
   * Ctrl+Q: take the last queued message back into the input.
   *
   * Checked before popping: a message whose content is attachments cannot be put back (the input's
   * attachment state is not a `ContentPart[]`), and popping it anyway would leave it nowhere.
   */
  const handleRecallQueued = async () => {
    if (!queuedTailIsText(queuedMessages)) {
      inputActions.setInputFeedback(
        queuedMessages && (queuedMessages.steer.length > 0 || queuedMessages.followUp.length > 0)
          ? "That message carries attachments — Esc drops the queue"
          : "Nothing queued to recall",
        "info"
      );
      return;
    }
    const popped = await recallQueuedMessage();
    if (!popped || typeof popped.content !== "string") {
      inputActions.setInputFeedback("Nothing queued to recall", "info");
      return;
    }
    inputActions.setValue(popped.content);
  };

  const handleNormalSubmit = async (behavior: "send" | "steer" | "followUp" | "forceSubmit" = "send") => {
    commandOutputActions.dismiss();
    const { text: prompt, attachments } = inputActions.submit();

    if (prompt.startsWith("/")) {
      if (behavior !== "send") {
        inputActions.setInputError("Slash commands cannot be queued while the agent is running");
        return;
      }
      if (await dispatchCommand(prompt, commandCtx)) return;
      inputActions.setInputError(`Unknown command: ${prompt.split(" ")[0]}`);
      return;
    }

    if (!prompt && !attachments.length) return;
    if (!isReady) return;

    const content = attachments.length > 0 ? { text: prompt, files: attachments } : prompt;

    if (behavior === "steer") {
      // NOTE: steer is not the default Enter keybinding anymore.
      // Enter (running) → followUp; Option+Enter → forceSubmit.
      // steer is kept for programmatic use (same-turn injection).
      steer(content);
      return;
    }
    if (behavior === "followUp") {
      followUp(content);
      return;
    }
    if (behavior === "forceSubmit") {
      forceSubmit(content);
      return;
    }
    if (isLoading) {
      followUp(content);
      return;
    }
    await sendMessage(content);
  };

  return {
    adapter,
    mode,
    isLoading,
    isAutocompleteVisible,
    currentPendingIsLast,
    pendingApproval,
    pendingAskUser,
    inputActions,
    autocompleteActions,
    selectActions,
    commandOutputActions,
    modeActions,
    denyingRef,
    commandCtx,
    stop,
    acceptAutocomplete,
    handleNormalSubmit,
    handleRecallQueued,
    submitAskUserAnswer,
    addToolApprovalResponse,
  };
}
