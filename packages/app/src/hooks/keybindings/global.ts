/** Always-on global shortcuts: exit, panel toggles, clipboard, Esc cascade. */

import { useInput } from "ink";

import { clipboardImageFilename } from "../../utils/attachment-hash.js";
import { exitWithSummary } from "../../utils/exit-with-summary.js";
import { getActiveHost } from "../../utils/session-resolve.js";
import { useAutocomplete } from "../use-autocomplete.js";
import { useCommandOutput } from "../use-command-output.js";
import { useExtensionPanel, CLOSE_DEBOUNCE_MS as EXTENSION_CLOSE_DEBOUNCE_MS } from "../use-extension-panel.js";
import { usePlanPreview } from "../use-plan-preview.js";
import { useSubagentPanel, CLOSE_DEBOUNCE_MS as SUBAGENT_CLOSE_DEBOUNCE_MS } from "../use-subagent-panel.js";
import { useWorkspaceView, CLOSE_DEBOUNCE_MS as WORKSPACE_CLOSE_DEBOUNCE_MS } from "../use-workspace-view.js";

import { isAnyPanelOpen } from "./context.js";

import type { KeybindingContext } from "./context.js";

export function useGlobalKeybindings(ctx: KeybindingContext): void {
  const { adapter, inputActions, autocompleteActions, commandOutputActions } = ctx;

  useInput((inputChar, inputKey) => {
    inputActions.addEvent(inputChar, inputKey);

    // Panel open: let the panel's own handlers process plain keys
    // (Esc/Enter/↑↓); keep global Ctrl/meta shortcuts (exit, toggles) working.
    if (isAnyPanelOpen() && !inputKey.ctrl && !inputKey.meta) {
      return;
    }

    if (inputKey.ctrl && inputChar === "c") {
      exitWithSummary({
        adapter,
        session: ctx.getSession(),
        destroySession: (sessionId) => void getActiveHost()?.destroy(sessionId),
      });
      return;
    }

    if (inputKey.ctrl && inputChar === "u") {
      inputActions.setValue("");
      return;
    }

    if (inputKey.ctrl && inputChar === "a") {
      if (!ctx.pendingApproval) inputActions.setSelectAll(true);
      return;
    }

    if (inputKey.ctrl && inputChar === "v") {
      if (!ctx.pendingApproval) {
        adapter.readClipboardImage?.().then((result) => {
          if (result) {
            inputActions.addAttachment({
              path: "clipboard",
              filename: clipboardImageFilename(result.data),
              mediaType: result.mediaType,
              type: "image",
              size: Math.ceil((result.data.length * 3) / 4),
              dataUrl: `data:${result.mediaType};base64,${result.data}`,
            });
            inputActions.setInputError(null);
          } else {
            inputActions.setInputError("No image found in clipboard");
          }
        });
      }
      return;
    }

    if (inputKey.ctrl && inputChar === "t") {
      useSubagentPanel.getActions().openList();
      return;
    }

    if (inputKey.ctrl && inputChar === "y") {
      useExtensionPanel.getActions().toggle();
      return;
    }

    if (inputKey.ctrl && inputChar === "e") {
      const ws = useWorkspaceView.getReadonlyState();
      if (ws.view === "workspace") {
        useWorkspaceView.getActions().close();
      } else {
        useWorkspaceView.getActions().open();
      }
      return;
    }

    if (inputKey.escape && ctx.mode !== "freeform" && ctx.mode !== "select") {
      // Workspace panel open: let WorkspacePanel handle Esc
      if (useWorkspaceView.getReadonlyState().view === "workspace") return;
      const panel = useSubagentPanel.getReadonlyState();
      if (panel.view !== "closed") {
        return;
      }
      const extPanel = useExtensionPanel.getReadonlyState();
      if (extPanel.view !== "closed") {
        return;
      }
      if (usePlanPreview.getReadonlyState().open) {
        usePlanPreview.getActions().hide();
        return;
      }
      const workspace = useWorkspaceView.getReadonlyState();
      if (Date.now() - workspace.lastClosedAt < WORKSPACE_CLOSE_DEBOUNCE_MS) {
        return;
      }
      // Debounce: prevent ESC from calling stop() right after panel closes.
      if (Date.now() - panel.lastClosedAt < SUBAGENT_CLOSE_DEBOUNCE_MS) {
        return;
      }
      if (Date.now() - extPanel.lastClosedAt < EXTENSION_CLOSE_DEBOUNCE_MS) {
        return;
      }
      if (useAutocomplete.getReadonlyState().visible) {
        autocompleteActions.dismiss();
        return;
      }
      // Command output panel (e.g. /help) open: dismiss it before aborting
      if (useCommandOutput.getReadonlyState().lines) {
        commandOutputActions.dismiss();
        return;
      }
      if (ctx.isLoading) {
        ctx.stop();
        return;
      }
    }
  });
}
