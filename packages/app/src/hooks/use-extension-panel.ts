import { createState } from "reactivity-store";

// ============================================================================
// Types
// ============================================================================

export type ExtensionPanelView = "closed" | "open";

// ============================================================================
// State
// ============================================================================

export const useExtensionPanel = createState(
  () => ({
    view: "closed" as ExtensionPanelView,
    revision: 0,
  }),
  {
    withActions: (state) => ({
      open: () => {
        state.view = "open";
        state.revision += 1;
      },
      close: () => {
        state.view = "closed";
      },
      toggle: () => {
        if (state.view === "open") {
          state.view = "closed";
        } else {
          state.view = "open";
          state.revision += 1;
        }
      },
      /** Bump the revision to re-read extension state after a toggle. */
      refresh: () => {
        state.revision += 1;
      },
    }),
    withNamespace: "useExtensionPanel",
    withDeepSelector: false,
    withStableSelector: true,
  }
);
