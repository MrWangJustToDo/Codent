import { createState } from "reactivity-store";

// ============================================================================
// Types
// ============================================================================

/** Right-pane content mode in the workspace file browser. */
export type WorkspaceMode = "preview" | "diff";

/** Left/right pane focus between file tree and preview/diff pane. */
export type WorkspacePaneFocus = "tree" | "preview";

export type WorkspaceView = "closed" | "workspace";

// ============================================================================
// State
// ============================================================================

export const CLOSE_DEBOUNCE_MS = 300;

/** Active quick-open (fuzzy file finder) session, or null when closed. */
export interface WorkspaceQuickOpenState {
  query: string;
  cursor: number;
}

export const useWorkspaceView = createState(
  () => ({
    view: "closed" as WorkspaceView,
    mode: "preview" as WorkspaceMode,
    paneFocus: "tree" as WorkspacePaneFocus,
    selectedPath: null as string | null,
    treeScrollTop: 0,
    lastClosedAt: 0,
    quickOpen: null as WorkspaceQuickOpenState | null,
  }),
  {
    withActions: (state) => ({
      open: () => {
        state.view = "workspace";
        state.mode = "preview";
        state.selectedPath = null;
        state.paneFocus = "tree";
        state.treeScrollTop = 0;
        state.quickOpen = null;
      },
      close: () => {
        state.view = "closed";
        state.selectedPath = null;
        state.quickOpen = null;
        state.lastClosedAt = Date.now();
      },
      openQuickOpen: () => {
        state.quickOpen = { query: "", cursor: 0 };
      },
      closeQuickOpen: () => {
        state.quickOpen = null;
      },
      setQuickOpenQuery: (query: string) => {
        if (state.quickOpen) state.quickOpen = { ...state.quickOpen, query, cursor: 0 };
      },
      setQuickOpenCursor: (cursor: number) => {
        if (state.quickOpen) state.quickOpen = { ...state.quickOpen, cursor };
      },
      moveQuickOpenCursor: (delta: number, total: number) => {
        if (!state.quickOpen) return;
        const count = Math.max(0, total);
        if (count === 0) return;
        const cursor = (((state.quickOpen.cursor + delta) % count) + count) % count;
        state.quickOpen = { ...state.quickOpen, cursor };
      },
      selectFile: (path: string) => {
        state.selectedPath = path;
        state.paneFocus = "preview";
      },
      setMode: (mode: WorkspaceMode) => {
        // Preview and diff list *different* row sets (the full tree vs the changed files), so a
        // window offset does not carry over: an offset from the full tree lands past the end of
        // the usually-shorter changed-files list and the pane draws blank. Reset it with the rows.
        state.mode = mode;
        state.treeScrollTop = 0;
      },
      toggleMode: () => {
        state.mode = state.mode === "preview" ? "diff" : "preview";
        state.treeScrollTop = 0;
      },
      setPaneFocus: (paneFocus: WorkspacePaneFocus) => {
        state.paneFocus = paneFocus;
      },
      togglePaneFocus: () => {
        state.paneFocus = state.paneFocus === "tree" ? "preview" : "tree";
      },
      setTreeScrollTop: (scrollTop: number) => {
        state.treeScrollTop = Math.max(0, scrollTop);
      },
    }),
    withNamespace: "useWorkspaceView",
    withDeepSelector: false,
    withStableSelector: true,
  }
);
