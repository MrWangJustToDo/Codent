/** Select mode: ask_user option list navigation / toggle / submit. */

import { BUILTIN_TOOL_NAMES } from "@codent/core";
import { useInput } from "ink";

import { isAnyPanelOpen } from "./context.js";

import type { KeybindingContext } from "./context.js";

export function useSelectModeKeybindings(ctx: KeybindingContext): void {
  const { inputActions, selectActions, modeActions, pendingAskUser, submitAskUserAnswer } = ctx;

  useInput(
    (inputChar, inputKey) => {
      // Panel open: the panel's own useInput owns the keyboard — never let
      // panel navigation toggle options / submit an ask_user answer.
      if (isAnyPanelOpen()) return;
      if (inputKey.upArrow) {
        selectActions.selectPrev();
        return;
      }
      if (inputKey.downArrow) {
        selectActions.selectNext();
        return;
      }
      if (inputChar === " ") {
        selectActions.toggle();
        return;
      }
      // Enter ALWAYS submits — it never enters the answer-editing mode. Entering
      // edit mode is done exclusively via the right arrow (see below), so the two
      // actions never conflict.
      if (inputKey.return) {
        if (!pendingAskUser) return;
        if (selectActions.isFreeformSelected() && !selectActions.getFreeformDraft()) {
          // Cursor on "Your answer" but the user hasn't typed anything yet.
          inputActions.setInputError('Please type your answer first (press → to edit "Your answer")');
          return;
        }
        const result = selectActions.getResult();
        const selected = selectActions.getSelectedLabels();
        const draft = selectActions.getFreeformDraft();
        selectActions.close();
        submitAskUserAnswer(result, { selected, draft });
        return;
      }
      // Right arrow: enter the answer-editing mode when the cursor is on the
      // freeform "Your answer" row. We keep the select list open (preserving the
      // multi-select toggles) and switch to freeform input mode with the existing
      // draft pre-filled.
      if (inputKey.rightArrow && selectActions.isFreeformSelected()) {
        inputActions.clear();
        const draft = selectActions.getFreeformDraft();
        if (draft) inputActions.setValue(draft);
        inputActions.setLoading(false);
        modeActions.setDenyMode(true, BUILTIN_TOOL_NAMES.askUser);
        return;
      }
      if (inputKey.escape) {
        // Don't close the ask_user select list — the agent is waiting for an answer.
        // Closing it would leave the agent stuck with no way to respond.
        if (pendingAskUser) return;
        selectActions.close();
      }
    },
    { isActive: ctx.mode === "select" }
  );
}
