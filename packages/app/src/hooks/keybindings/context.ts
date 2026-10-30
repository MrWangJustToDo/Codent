/**
 * Shared context for the main screen's keybinding handlers.
 *
 * Which screen owns a keystroke is decided by `InputScope` (see `context/input-scope-context.ts`),
 * not by a table of open-panel flags: these handlers are registered inside the `main` scope, so they
 * exist only while the main screen does. The former `isAnyPanelOpen()` / `panelJustClosed()` pair
 * lived here and is gone — see `openspec/specs/app-input-routing/spec.md`.
 */

import type { useAutocomplete, useCommandOutput, useSelect, useUserInput } from "..";
import type { AgentAdapter } from "../../adapter/types.js";
import type { CommandContext } from "../../commands";
import type { UseAgentChatReturn } from "../use-agent-chat.js";
import type { InputMode, useInputMode } from "../use-input-mode.js";
import type { AgentSession } from "@codent/core";
import type { MutableRefObject } from "react";

export interface DenyingToolInfo {
  id: string;
  toolCallId?: string;
  toolName?: string;
}

/** Everything a keybinding handler may need, built once per render. */
export interface KeybindingContext {
  adapter: AgentAdapter;
  mode: InputMode;
  isLoading: boolean;
  isAutocompleteVisible: boolean;
  pendingApproval: UseAgentChatReturn["allPendingApproval"][number] | undefined;
  pendingAskUser: UseAgentChatReturn["allPendingAskUser"][number] | undefined;
  inputActions: ReturnType<typeof useUserInput.getActions>;
  autocompleteActions: ReturnType<typeof useAutocomplete.getActions>;
  selectActions: ReturnType<typeof useSelect.getActions>;
  commandOutputActions: ReturnType<typeof useCommandOutput.getActions>;
  modeActions: ReturnType<typeof useInputMode.getActions>;
  denyingRef: MutableRefObject<DenyingToolInfo | null>;
  commandCtx: CommandContext;
  stop: UseAgentChatReturn["stop"];
  acceptAutocomplete: (triggerSubmit: boolean) => boolean;
  handleNormalSubmit: (behavior?: "send" | "steer" | "followUp" | "forceSubmit") => void;
  /** Take the last queued message back into the input (Ctrl+Q while running). */
  handleRecallQueued: () => void;
  /**
   * Submit an ask_user answer. `meta` carries structured multi-select info
   * (selected option labels + free-form draft) so the UI and the model-facing
   * result can clearly represent a multi-choice answer.
   */
  submitAskUserAnswer: (answer: string, meta?: { selected?: string[]; draft?: string }) => void;
  addToolApprovalResponse: UseAgentChatReturn["addToolApprovalResponse"];
  /** Resolved active session accessor (root or child). */
  getSession: () => AgentSession | null;
}
