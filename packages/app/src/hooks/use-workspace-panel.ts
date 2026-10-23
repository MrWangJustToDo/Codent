import { createState } from "reactivity-store";

import { imagePanStep } from "../utils/image-viewport.js";

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

/**
 * Zoom levels for the image preview, in order. `1` is "fit the whole image".
 *
 * Discrete steps rather than free scaling: each step re-decodes a new source window, and a smooth
 * factor would decode a new grid per keypress for no visible gain.
 */
export const IMAGE_ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8] as const;

/** Deepest zoom. Beyond this the source pixels are upsampled past usefulness. */
export const MAX_IMAGE_ZOOM = IMAGE_ZOOM_STEPS[IMAGE_ZOOM_STEPS.length - 1]!;

/**
 * What the preview needs to know to turn a pan keypress into a step, published by the component.
 *
 * The store cannot derive it: the pane's cell box comes from layout and the image size comes from a
 * render. Without it, all it can do is move by a fixed fraction of the *remaining* range, and that
 * range grows as the window shrinks — which is exactly what made a press at 8× jump a whole screen.
 */
export interface WorkspaceImageGeometry {
  imageWidth: number;
  imageHeight: number;
  maxCols: number;
  maxRows: number;
}

export const useWorkspacePanel = createState(
  () => ({
    view: "closed" as WorkspaceView,
    mode: "preview" as WorkspaceMode,
    paneFocus: "tree" as WorkspacePaneFocus,
    selectedPath: null as string | null,
    treeScrollTop: 0,
    lastClosedAt: 0,
    quickOpen: null as WorkspaceQuickOpenState | null,
    /**
     * Image preview viewport: zoom level plus the window's position, both axes in [0, 1].
     *
     * It lives in the store rather than in the preview component because the KEYS are handled by
     * `WorkspaceFileMode` while the picture is drawn by `WorkspaceImagePreview` — the store is the
     * only place both can see. `0.5` is centred, and `imageZoom === 1` means "whole image".
     */
    imageZoom: 1 as number,
    imagePanX: 0.5,
    imagePanY: 0.5,
    imageGeometry: null as WorkspaceImageGeometry | null,
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
        state.imageZoom = 1;
        state.imagePanX = 0.5;
        state.imagePanY = 0.5;
        state.imageGeometry = null;
      },
      close: () => {
        state.view = "closed";
        state.selectedPath = null;
        state.quickOpen = null;
        state.lastClosedAt = Date.now();
        state.imageZoom = 1;
        state.imagePanX = 0.5;
        state.imagePanY = 0.5;
        state.imageGeometry = null;
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
        // A viewport belongs to the picture being looked at, not to the panel: the next file starts
        // fitted and centred, and publishes its own geometry once it renders.
        state.imageZoom = 1;
        state.imagePanX = 0.5;
        state.imagePanY = 0.5;
        state.imageGeometry = null;
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
      /** Publish the geometry the preview just rendered with, so panning can size its step. */
      setImageGeometry: (geometry: WorkspaceImageGeometry) => {
        const previous = state.imageGeometry;
        if (
          previous &&
          previous.imageWidth === geometry.imageWidth &&
          previous.imageHeight === geometry.imageHeight &&
          previous.maxCols === geometry.maxCols &&
          previous.maxRows === geometry.maxRows
        ) {
          // Same geometry, new object: assigning anyway would re-render the panel for nothing on
          // every keypress that re-decodes the same size.
          return;
        }
        state.imageGeometry = geometry;
      },
      /** Step one zoom level up/down; panning is clamped by the preview, which knows the geometry. */
      zoomImage: (direction: 1 | -1) => {
        const current = IMAGE_ZOOM_STEPS.findIndex((step) => step >= state.imageZoom);
        const index = current === -1 ? IMAGE_ZOOM_STEPS.length - 1 : current;
        const next = Math.min(IMAGE_ZOOM_STEPS.length - 1, Math.max(0, index + direction));
        state.imageZoom = IMAGE_ZOOM_STEPS[next]!;
        // Zooming out to "fit" means the window IS the whole image, so an offset would be a position
        // inside nothing.
        if (state.imageZoom === 1) {
          state.imagePanX = 0.5;
          state.imagePanY = 0.5;
        }
      },
      /**
       * Pan one visible-window's worth of the picture, in the given directions.
       *
       * Takes DIRECTIONS, not distances: the step depends on the zoom and on the image, and only the
       * store's geometry knows both. Moving by a constant fraction of the visible window is what
       * keeps the on-screen rate the same at every zoom level.
       */
      panImage: (dx: -1 | 0 | 1, dy: -1 | 0 | 1) => {
        if (state.imageZoom <= 1) return;
        const geometry = state.imageGeometry;
        if (!geometry) return;
        const step = imagePanStep({ ...geometry, zoom: state.imageZoom });
        state.imagePanX = Math.min(1, Math.max(0, state.imagePanX + dx * step.x));
        state.imagePanY = Math.min(1, Math.max(0, state.imagePanY + dy * step.y));
      },
      resetImageView: () => {
        state.imageZoom = 1;
        state.imagePanX = 0.5;
        state.imagePanY = 0.5;
      },
    }),
    withNamespace: "useWorkspacePanel",
    withDeepSelector: false,
    withStableSelector: true,
  }
);
