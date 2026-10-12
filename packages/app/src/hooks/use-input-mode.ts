import { createState } from "reactivity-store";

import type { BUILTIN_TOOL_NAMES } from "@codent/core";

// ============================================================================
// Types
// ============================================================================

export type InputMode = "normal" | "approval" | "select" | "freeform";

/** Why freeform mode was entered. The second value is the `ask_user` tool identifier. */
export type FreeformContext = "deny" | typeof BUILTIN_TOOL_NAMES.askUser;

// ============================================================================
// State Hook
// ============================================================================

export const useInputMode = createState(
  () => ({
    mode: "normal" as InputMode,
    denyMode: false,
    freeformContext: "deny" as FreeformContext,
  }),
  {
    withActions: (state) => ({
      setMode: (mode: InputMode) => {
        state.mode = mode;
      },
      setDenyMode: (deny: boolean, context?: FreeformContext) => {
        state.denyMode = deny;
        if (deny && context) {
          state.freeformContext = context;
        }
      },
    }),
    withNamespace: "useInputMode",
    withDeepSelector: false,
    withStableSelector: true,
  }
);
