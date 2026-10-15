/**
 * Shared context for the central keybinding handlers.
 *
 * Ink broadcasts every keystroke to ALL registered `useInput` handlers, so every mode
 * handler must early-return while a panel owns the keyboard (`isAnyPanelOpen`) — and the
 * global Esc branch must also early-return while a panel has *just* closed
 * (`panelJustClosed`), because a panel's own handler may have handled the very same
 * keystroke before this one ran.
 */

import { useConfigEditor, CLOSE_DEBOUNCE_MS as CONFIG_EDITOR_CLOSE_DEBOUNCE_MS } from "../use-config-editor.js";
import { useConfig } from "../use-config.js";
import { useExtensionPanel, CLOSE_DEBOUNCE_MS as EXTENSION_CLOSE_DEBOUNCE_MS } from "../use-extension-panel.js";
import { useSubagentPanel, CLOSE_DEBOUNCE_MS as SUBAGENT_CLOSE_DEBOUNCE_MS } from "../use-subagent-panel.js";
import { useWorkspacePanel, CLOSE_DEBOUNCE_MS as WORKSPACE_CLOSE_DEBOUNCE_MS } from "../use-workspace-panel.js";

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

/**
 * One description per full-screen swap, so the two questions asked of every panel cannot
 * drift apart: whether one is up right now, and whether one closed within its debounce.
 *
 * `lastClosedAt` exists because a keystroke reaches every handler: a panel's own `useInput`
 * can close it *before* a later handler reads these stores, so "is it open" turns false
 * mid-keystroke. The debounce is what tells the later handler that this is the same
 * keystroke, not a fresh Esc.
 */
interface PanelSurface {
  isOpen: () => boolean;
  /** Present only for a panel that its own handler can close on the very keystroke in flight. */
  lastClosedAt?: () => number;
  closeDebounceMs?: number;
}

const PANEL_SURFACES: readonly PanelSurface[] = [
  {
    isOpen: () => useConfigEditor.getReadonlyState().view === "open",
    lastClosedAt: () => useConfigEditor.getReadonlyState().lastClosedAt,
    closeDebounceMs: CONFIG_EDITOR_CLOSE_DEBOUNCE_MS,
  },
  {
    isOpen: () => useWorkspacePanel.getReadonlyState().view === "workspace",
    lastClosedAt: () => useWorkspacePanel.getReadonlyState().lastClosedAt,
    closeDebounceMs: WORKSPACE_CLOSE_DEBOUNCE_MS,
  },
  {
    isOpen: () => useSubagentPanel.getReadonlyState().view !== "closed",
    lastClosedAt: () => useSubagentPanel.getReadonlyState().lastClosedAt,
    closeDebounceMs: SUBAGENT_CLOSE_DEBOUNCE_MS,
  },
  {
    isOpen: () => useExtensionPanel.getReadonlyState().view !== "closed",
    lastClosedAt: () => useExtensionPanel.getReadonlyState().lastClosedAt,
    closeDebounceMs: EXTENSION_CLOSE_DEBOUNCE_MS,
  },
  // The resume picker is not store-backed: `--resume` (or `/resume`) with no id swaps `Agent` to
  // `SessionResumePicker`, so the sentinel itself is the signal — see `packages/cli/src/args.ts`.
  // It needs no close debounce: cancelling it leaves no in-flight run to abort.
  { isOpen: () => useConfig.getReadonlyState().config.resumeSession === "__picker__" },
];

/**
 * Any full-screen swap is open. While one is up, its own `useInput` owns the keyboard —
 * central handlers must early-return or panel navigation leaks into chat input / approvals
 * (arrows mutating history or scrolling an invisible list, typed characters filling the hidden
 * prompt, `y` approving a tool, …).
 *
 * A new overlay is not gated by default: the resume picker returned `false` here for a while,
 * which is exactly how its arrows also drove prompt history underneath.
 */
export function isAnyPanelOpen(): boolean {
  return PANEL_SURFACES.some((surface) => surface.isOpen());
}

/**
 * A panel closed within its debounce window — i.e. THIS keystroke closed it.
 *
 * The gap this closes: the same Esc is delivered to every handler, so by the time the global
 * branch runs, `isAnyPanelOpen()` can already be false because the panel answered the key
 * first. Acting then would abort the in-flight run instead of just closing a panel.
 * The config editor was the case in point: it had no `lastClosedAt`, so its Esc reached
 * `stop()`. Every panel that Esc can close must appear in {@link PANEL_SURFACES}.
 */
export function panelJustClosed(now: number = Date.now()): boolean {
  return PANEL_SURFACES.some(
    (surface) =>
      surface.lastClosedAt !== undefined &&
      surface.closeDebounceMs !== undefined &&
      now - surface.lastClosedAt() < surface.closeDebounceMs
  );
}
