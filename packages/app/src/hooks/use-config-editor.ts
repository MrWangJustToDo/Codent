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
// a stacked overlay, so the panel must be part of `isAnyPanelOpen()` — the
// editor owns the keyboard while it is up.
// ============================================================================

export type ConfigEditorView = "closed" | "open";

/**
 * How long after closing the panel still counts as "this keystroke closed it".
 *
 * The editor answers Esc itself, and Ink broadcasts the same keystroke to every `useInput`
 * handler, so the central Esc branch can run *after* this panel already closed. Without the
 * window it reads "no panel open" and aborts the in-flight run — see `panelJustClosed`.
 */
export const CLOSE_DEBOUNCE_MS = 300;

export const useConfigEditor = createState(
  () => ({
    view: "closed" as ConfigEditorView,
    /** Set on every close; the debounce window `panelJustClosed` reads. */
    lastClosedAt: 0,
  }),
  {
    withActions: (state) => ({
      open: () => {
        state.view = "open";
      },
      close: () => {
        state.view = "closed";
        state.lastClosedAt = Date.now();
      },
      toggle: () => {
        // Inlined rather than delegating to `close()`: the actions are not part of `state`.
        state.view = state.view === "open" ? "closed" : "open";
        if (state.view === "closed") state.lastClosedAt = Date.now();
      },
    }),
    withNamespace: "useConfigEditor",
    withDeepSelector: false,
    withStableSelector: true,
  }
);
