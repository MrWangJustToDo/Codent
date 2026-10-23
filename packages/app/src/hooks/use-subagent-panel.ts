import { createState } from "reactivity-store";

// ============================================================================
// Types
// ============================================================================

export type SubagentPanelView = "closed" | "list" | "detail";

// ============================================================================
// State
// ============================================================================

export const useSubagentPanel = createState(
  () => ({
    view: "closed" as SubagentPanelView,
    selectedSubagentId: null as string | null,
    /**
     * Cursor row in the task list.
     *
     * Lives here rather than in `SubagentListPanel` because the list unmounts while the detail
     * view is shown: a component-local index resets on every return from detail, so the user
     * loses the row they were on. It is kept across a list↔detail switch and cleared only when
     * the panel is left or freshly opened.
     */
    selectedIndex: 0,
  }),
  {
    withActions: (state) => ({
      openList: () => {
        // A fresh open (Ctrl+T out of the chat) starts at the top. Re-opening while already
        // inside the panel is a view switch instead, so the cursor survives it the same way it
        // survives Esc from detail — and Ctrl+T is reachable from the detail view.
        if (state.view === "closed") state.selectedIndex = 0;
        state.view = "list";
        state.selectedSubagentId = null;
      },
      close: () => {
        state.view = "closed";
        state.selectedSubagentId = null;
        state.selectedIndex = 0;
      },
      openDetail: (subagentId: string) => {
        state.view = "detail";
        state.selectedSubagentId = subagentId;
      },
      backToList: () => {
        state.view = "list";
        state.selectedSubagentId = null;
      },
      /**
       * Move the list cursor.
       *
       * Not clamped here: only the list knows how many rows there are, and the membership can
       * change while the cursor sits in the detail view. {@link SubagentListPanel} clamps when
       * it renders.
       */
      setSelectedIndex: (index: number) => {
        state.selectedIndex = index;
      },
    }),
    withNamespace: "useSubagentPanel",
    withDeepSelector: false,
    withStableSelector: true,
  }
);
