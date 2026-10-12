import { createState } from "reactivity-store";

/** Tabs available in the workspace panel. */
export type WorkspaceTab = "preview" | "variants" | "code";

export interface BootState {
  phase: "booting" | "ready" | "error";
  /** Shown in the work area and the status bar while booting. */
  message: string;
  error?: string;
}

export type ToastTone = "default" | "success" | "error";

export interface Toast {
  message: string;
  tone: ToastTone;
}

/**
 * Shell-owned UI state: which overlay is open, which workspace tab is active,
 * the agent boot phase, and the small amount of cross-feature wiring the command
 * palette needs (it must be able to act on the workspace without owning it).
 *
 * Deliberately separate from `usePlaygroundConfig`: none of this is a persisted
 * user preference, and none of it should survive a reload.
 */
export const useShellState = createState(
  () => ({
    boot: { phase: "booting", message: "Booting WebContainer…" } as BootState,
    settingsOpen: false,
    paletteOpen: false,
    exportOpen: false,
    workspaceTab: "code" as WorkspaceTab,
    /** Variants panel: side-by-side comparison instead of a single stage. */
    variantsCompare: false,
    toast: null as Toast | null,
    /** Set by the agent bootstrap so the shell can restart it (palette / status bar). */
    agentRestart: null as (() => void) | null,
    /** Incremented to ask the workspace preview to reload its iframe. */
    previewNonce: 0,
    /** Active preview URL, published by the workspace panel for shell actions. */
    previewUrl: null as string | null,
  }),
  {
    withActions: (state) => ({
      setBoot: (boot: BootState) => {
        state.boot = boot;
      },
      setSettingsOpen: (open: boolean) => {
        state.settingsOpen = open;
      },
      setPaletteOpen: (open: boolean) => {
        state.paletteOpen = open;
      },
      setExportOpen: (open: boolean) => {
        state.exportOpen = open;
      },
      setWorkspaceTab: (tab: WorkspaceTab) => {
        state.workspaceTab = tab;
      },
      setVariantsCompare: (compare: boolean) => {
        state.variantsCompare = compare;
      },
      showToast: (message: string, tone: ToastTone = "default") => {
        state.toast = { message, tone };
      },
      clearToast: () => {
        state.toast = null;
      },
      setAgentRestart: (restart: (() => void) | null) => {
        state.agentRestart = restart;
      },
      bumpPreviewNonce: () => {
        state.previewNonce += 1;
      },
      setPreviewUrl: (url: string | null) => {
        state.previewUrl = url;
      },
    }),
    withNamespace: "useShellState",
    withStableSelector: true,
  }
);
