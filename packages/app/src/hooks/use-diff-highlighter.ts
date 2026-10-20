/**
 * Load the shared Shiki adapter for `@git-diff-view`.
 *
 * Hosts await `initHighlighter()` before mounting the UI, so the common path is synchronous: the
 * first render already has the adapter and the diff/code view never paints through lowlight first.
 * The async fallback exists for callers that render before initialization; a load failure must not
 * blank a diff or a file preview, so it keeps the built-in lowlight highlighter.
 */

import { useEffect, useState } from "react";

import {
  getDiffViewHighlighterSync,
  loadDiffViewHighlighter,
  type DiffViewHighlighter,
} from "../utils/diff-highlighter.js";

export function useDiffHighlighter(): DiffViewHighlighter | undefined {
  const [highlighter, setHighlighter] = useState<DiffViewHighlighter | undefined>(() => getDiffViewHighlighterSync());

  useEffect(() => {
    if (highlighter) return;

    let cancelled = false;
    void loadDiffViewHighlighter()
      .then((next) => {
        if (!cancelled) setHighlighter(next);
      })
      .catch(() => {
        // Keep the built-in lowlight highlighter; a syntax upgrade is not worth failing a view.
      });
    return () => {
      cancelled = true;
    };
  }, [highlighter]);

  return highlighter;
}
