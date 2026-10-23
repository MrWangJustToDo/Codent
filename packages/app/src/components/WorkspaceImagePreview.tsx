/**
 * Image preview for the workspace panel.
 *
 * A half-block renderer gives 1×2 pixels per cell, so the picture on screen is a downscaled raster
 * — at panel size a 2172px screenshot is ~14× reduced. Two things follow, and both live here:
 *
 *  - the whole pane is used (`FileContent` measures it and passes the budget in), and
 *  - detail is reached by **zooming into a source window** rather than by a bigger raster: at 8×
 *    the same cells cover 1/8 of the image, so the pixels per cell are real pixels.
 *
 * The window is computed here and rendered by the host (`CoreEnv.imageToText({ region })`), because
 * only the host decodes — asking it for the whole image at 8× and cropping client-side would mean
 * megabytes of ANSI instead of one screenful.
 */

import { Box, Text } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";

import { useCoreEnv } from "../context/core-env-context.js";
import { useWorkspacePanel } from "../hooks/use-workspace-panel.js";
import { COLORS } from "../theme/colors.js";
import { loadImagePreview } from "../utils/image-preview-cache.js";
import { imagePreviewBudget, imageViewRegion } from "../utils/image-viewport.js";

const IMAGE_PREVIEW_MESSAGE = "Image — preview not available for this file.";

type PreviewState =
  | { status: "loading" }
  | { status: "error" }
  // The path is part of the state: rows and the source size belong to ONE picture. Without it, a
  // file switch kept the previous rows under the new name, and a zoom pressed before the new file
  // landed computed its window from the OLD image's dimensions.
  | { status: "ready"; path: string; rows: string[]; imageWidth: number; imageHeight: number };

/**
 * How long a pan waits for the next keypress before decoding.
 *
 * Each window is a separate decode (and, over a remote env, a separate upload), so holding an arrow
 * key would otherwise queue one full decode per repeat. Zoom is deliberately NOT delayed: it is a
 * discrete action where the keypress IS the answer.
 */
const PAN_SETTLE_MS = 80;

export interface WorkspaceImagePreviewProps {
  filePath: string;
  /** Pane width in cells, minus the pane's own chrome. */
  width: number;
  /** Pane height in rows, including this component's title row. */
  height?: number;
  /** 24-bit color (false under `NO_COLOR` / a screen reader). */
  color: boolean;
}

export const WorkspaceImagePreview = ({ filePath, width, height, color }: WorkspaceImagePreviewProps) => {
  const env = useCoreEnv();
  const zoom = useWorkspacePanel((state) => state.imageZoom);
  const panX = useWorkspacePanel((state) => state.imagePanX);
  const panY = useWorkspacePanel((state) => state.imagePanY);
  const { setImageGeometry } = useWorkspacePanel.getActions();
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const fileName = useMemo(() => filePath.split("/").pop() || filePath, [filePath]);
  const previousZoom = useRef(zoom);

  const { maxCols, maxRows } = imagePreviewBudget(width, height);
  // The window is computed from the size a previous render reported: at 1× there is no window at all,
  // which is also what teaches us the size in the first place. Kept as two numbers (not the result
  // object) so the effect's dependency list is primitive — an object would be new on every render and
  // re-run the decode on its own answer.
  const shown = state.status === "ready" && state.path === filePath ? state : null;
  const imageWidth = shown?.imageWidth ?? 0;
  const imageHeight = shown?.imageHeight ?? 0;

  useEffect(() => {
    let cancelled = false;
    // Wait for a real width before sampling: the first paint reports 0 columns, and decoding at the
    // 8-cell floor would cache a preview nobody sees.
    if (width <= 0) return;

    // Keep the previous picture on screen while the next window decodes: zoom is a sequence of
    // keypresses, and flashing back to "Loading" on each one makes the pane strobe. Only for the
    // SAME file — a different picture is not "the previous window".
    setState((previous) =>
      previous.status === "ready" && previous.path === filePath ? previous : { status: "loading" }
    );

    const region = imageViewRegion({ imageWidth, imageHeight, maxCols, maxRows, zoom, panX, panY });
    const zoomChanged = previousZoom.current !== zoom;
    previousZoom.current = zoom;
    // Coalesce a held arrow key into one decode; a zoom step (or the first load of a file) runs now.
    const delay = imageWidth > 0 && !zoomChanged ? PAN_SETTLE_MS : 0;
    const timer = setTimeout(() => {
      loadImagePreview({
        env,
        path: filePath,
        maxCols,
        maxRows,
        color,
        ...(region ? { region } : {}),
      }).then((result) => {
        if (cancelled) return;
        // Publish what a pan step needs to be sized against. The image size only arrives with a
        // result, so this is also the first moment panning could be made proportional to the window.
        if (result) {
          setImageGeometry({
            imageWidth: result.imageWidth,
            imageHeight: result.imageHeight,
            maxCols,
            maxRows,
          });
        }
        // `loadImagePreview` never rejects — "no decoder", "unreadable bytes" and "gone since stat"
        // all arrive as `null`, which is what the placeholder is for.
        setState(
          result && result.rows.length > 0
            ? {
                status: "ready",
                path: filePath,
                rows: result.rows,
                imageWidth: result.imageWidth,
                imageHeight: result.imageHeight,
              }
            : { status: "error" }
        );
      });
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `imageWidth`/`imageHeight` arrive from a result, so they add exactly one re-run (the first
    // one that learns the size) and then settle: the re-run requests the same window and hits the
    // cache. Without them, a zoom request made before any render would carry no window at all.
  }, [env, filePath, maxCols, maxRows, color, zoom, panX, panY, width, imageWidth, imageHeight, setImageGeometry]);

  if (state.status === "error") {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text bold color={COLORS.danger}>
          Cannot preview
        </Text>
        <Text color={COLORS.danger}>{IMAGE_PREVIEW_MESSAGE}</Text>
      </Box>
    );
  }

  if (!shown) {
    // Loading, or a file switch whose rows are still the previous picture's — never the latter under
    // the new name, which is what the `path` in the state is for.
    return (
      <Box paddingY={1}>
        <Text color={COLORS.muted}>Loading image...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexShrink={0} borderBottom>
        <Text bold color={COLORS.primary}>
          {fileName}
        </Text>
        {/* Truncated, never wrapped: a second line here would push a raster row out of the pane. */}
        <Text color={COLORS.muted} dimColor wrap="truncate-end">
          {" "}
          — image
          {zoom > 1 ? ` ${formatZoom(zoom)}×` : ""}
          {" · +/- zoom · arrows pan · 0 fit"}
        </Text>
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {shown.rows.map((line, index) => (
          // Keyed by position: the rows are a rendered raster, they never reorder. Each row is one
          // `Text` truncated (not wrapped) — a wrapped row would silently double the block's height.
          <Text key={index} wrap="truncate-end">
            {line || " "}
          </Text>
        ))}
      </Box>
    </Box>
  );
};

function formatZoom(zoom: number): string {
  return Number.isInteger(zoom) ? String(zoom) : zoom.toFixed(1);
}
