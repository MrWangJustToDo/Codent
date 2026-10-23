import { createState } from "reactivity-store";

// ============================================================================
// Config editor overlay
//
// The model-config wizard (`ConfigEditor`) was first-run only: it rendered
// instead of `<App />` in the host bootstrap, so the connection fields could
// never be touched again without editing `.agents/config/models.json` by hand.
// This store is the mid-session entry point — `/settings config` opens it over
// the running app, and saving re-reads the file through the same unified
// pipeline so the new provider goes live without a restart.
//
// It is a full-screen swap (like the workspace / task / extension panels), not
// a stacked overlay, so it occupies the `main` input scope while it is up — the
// editor owns the keyboard because the chat screen is not mounted.
// ============================================================================

export type ConfigEditorView = "closed" | "open";

export const useConfigEditor = createState(
  () => ({
    view: "closed" as ConfigEditorView,
  }),
  {
    withActions: (state) => ({
      open: () => {
        state.view = "open";
      },
      close: () => {
        state.view = "closed";
      },
      toggle: () => {
        // Inlined rather than delegating to `close()`: the actions are not part of `state`.
        state.view = state.view === "open" ? "closed" : "open";
      },
    }),
    withNamespace: "useConfigEditor",
    withDeepSelector: false,
    withStableSelector: true,
  }
);
