/** Freeform mode: deny reasons and ask_user answer editing. */

import { useMainInput } from "../input";
import { useSelect } from "../use-select.js";

import type { KeybindingContext } from "./context.js";

export function useFreeformModeKeybindings(ctx: KeybindingContext): void {
  const { inputActions, modeActions, selectActions, denyingRef, pendingAskUser, submitAskUserAnswer } = ctx;

  useMainInput(
    (inputChar, inputKey) => {
      if (inputKey.escape) {
        inputActions.clear();
        modeActions.setDenyMode(false);
        if (denyingRef.current) {
          denyingRef.current = null;
        }
        // ask_user freeform is entered from the select list (via →), which is
        // still open. Esc returns to the list WITHOUT re-opening it (re-opening
        // would wipe the user's toggles / draft). Only re-open if the list was
        // somehow closed (no-options freeform entry path).
        if (pendingAskUser && !useSelect.getReadonlyState().visible) {
          const opts = (pendingAskUser.options ?? []).map((option) => ({ label: option, value: option }));
          opts.push({ label: "Your answer...", value: "__freeform__" });
          selectActions.open(opts, pendingAskUser.multiSelect ?? false, true);
        }
        return;
      }

      if (inputKey.return) {
        // freeform inputs (deny reasons, ask_user answers) are transient —
        // do not pollute normal input history
        const { text } = inputActions.submit(false);

        if (pendingAskUser) {
          if (!text) return;
          // ask_user answer editing: Enter STAGES the typed text back into the
          // select list (shown as the freeform row's label) instead of submitting
          // immediately. This keeps Enter meaning "submit" in the select list and
          // "commit draft" in edit mode — the two never collide. Submission still
          // happens via Enter on the select list.
          if (useSelect.getReadonlyState().visible) {
            selectActions.setFreeformDraft(text);
            inputActions.clear();
            modeActions.setDenyMode(false);
            return;
          }
          // No live select list (pure freeform ask_user, no options): submit directly.
          selectActions.close();
          modeActions.setDenyMode(false);
          submitAskUserAnswer(text);
          return;
        }

        if (denyingRef.current) {
          const info = denyingRef.current;
          denyingRef.current = null;
          modeActions.setDenyMode(false);
          ctx.addToolApprovalResponse({
            id: info.id,
            approved: false,
            reason: text || "User denied this tool execution. Do not assume the action was performed.",
            toolCallId: info.toolCallId,
            toolName: info.toolName,
          });
        }
        return;
      }

      if (inputKey.backspace) {
        inputActions.backspace();
        return;
      }
      if (inputKey.delete) {
        inputActions.deleteForward();
        return;
      }
      if (inputKey.leftArrow) {
        inputActions.moveCursorLeft();
        return;
      }
      if (inputKey.rightArrow) {
        inputActions.moveCursorRight();
        return;
      }
      if (inputChar && !inputKey.ctrl && !inputKey.meta) {
        if (inputChar.length > 1) {
          // Bracketed paste: collapse large pastes into a placeholder (same as normal mode).
          inputActions.paste(inputChar);
        } else {
          inputActions.append(inputChar);
        }
      }
    },
    { when: ctx.mode === "freeform" }
  );
}
