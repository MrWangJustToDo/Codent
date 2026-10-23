/**
 * The chat screen's shortcuts: panel toggles, clipboard, Esc cascade.
 *
 * Ctrl+C is deliberately absent — it is registered on every screen by `useExitKeybinding`.
 * The panel toggles here only *open* (this screen means every panel is closed); each panel answers
 * its own chord to close, which is what keeps a keystroke inside one surface.
 */

import { clipboardImageFilename } from "../../utils/attachment-hash.js";
import { useMainInput } from "../input";
import { useAutocomplete } from "../use-autocomplete.js";
import { useCommandOutput } from "../use-command-output.js";
import { useExtensionPanel } from "../use-extension-panel.js";
import { usePlanPreview } from "../use-plan-preview.js";
import { useSubagentPanel } from "../use-subagent-panel.js";
import { useWorkspacePanel } from "../use-workspace-panel.js";

import type { KeybindingContext } from "./context.js";

export function useGlobalKeybindings(ctx: KeybindingContext): void {
  const { adapter, inputActions, autocompleteActions, commandOutputActions } = ctx;

  useMainInput((inputChar, inputKey) => {
    inputActions.addEvent(inputChar, inputKey);

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
      // The main screen is the one on screen, so the panel is closed by definition.
      useWorkspacePanel.getActions().open();
      return;
    }

    if (inputKey.escape && ctx.mode !== "freeform" && ctx.mode !== "select") {
      if (usePlanPreview.getReadonlyState().open) {
        usePlanPreview.getActions().hide();
        return;
      }
      if (useAutocomplete.getReadonlyState().visible) {
        // A nested menu retreats one level at a time (Esc inside `/models`' effort list goes back to
        // the model list, and the input is rewritten to that level's prefix). Only the root closes.
        const parent = autocompleteActions.back();
        if (parent !== null) {
          inputActions.setValue(parent);
          return;
        }
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
