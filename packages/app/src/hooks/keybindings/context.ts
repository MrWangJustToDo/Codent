/**
 * Shared context for the central keybinding handlers.
 *
 * Ink broadcasts every keystroke to ALL registered `useInput` handlers, so
 * every mode handler must early-return when an overlay panel owns the keyboard
 * (`isAnyPanelOpen`).
 */

import { useConfigEditor } from "../use-config-editor.js";
import { useConfig } from "../use-config.js";
import { useExtensionPanel } from "../use-extension-panel.js";
import { useSubagentPanel } from "../use-subagent-panel.js";
import { useWorkspaceView } from "../use-workspace-view.js";

import type { useAutocomplete, useCommandOutput, useSelect, useUserInput } from "..";
import type { AgentAdapter } from "../../adapter/types.js";
import type { CommandContext } from "../../commands";
import type { UseAgentChatReturn } from "../use-agent-chat.js";
import type { InputMode, useInputMode } from "../use-input-mode.js";
import type { AgentSession } from "@codent/core";
import type { MutableRefObject } from "react";

export interface DenyingToolInfo {
  id: string;
  isLast: boolean;
  toolCallId?: string;
  toolName?: string;
}

/** Everything a keybinding handler may need, built once per render. */
export interface KeybindingContext {
  adapter: AgentAdapter;
  mode: InputMode;
  isLoading: boolean;
  isAutocompleteVisible: boolean;
  currentPendingIsLast: boolean;
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

/**
 * Any full-screen swap (workspace browser / task / extensions / config editor / resume picker)
 * is open. While one is up, its own `useInput` owns the keyboard — central handlers must
 * early-return or panel navigation leaks into chat input / approvals (arrows mutating history or
 * scrolling an invisible list, typed characters filling the hidden prompt, `y` approving a tool,
 * …).
 *
 * A new overlay is not gated by default: the resume picker returned `false` here for a while,
 * which is exactly how its arrows also drove prompt history underneath.
 */
export function isAnyPanelOpen(): boolean {
  return (
    useConfigEditor.getReadonlyState().view === "open" ||
    useWorkspaceView.getReadonlyState().view === "workspace" ||
    useSubagentPanel.getReadonlyState().view !== "closed" ||
    useExtensionPanel.getReadonlyState().view !== "closed" ||
    // `--resume` with no id, and `/resume` with none: `Agent` swaps to `SessionResumePicker`.
    // The sentinel itself is the signal — see `packages/cli/src/args.ts`.
    useConfig.getReadonlyState().config.resumeSession === "__picker__"
  );
}
