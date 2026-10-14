import { previewEdit, type PreviewEditResult } from "@codent/core";
import { useEffect, useState } from "react";

import { useCoreEnv } from "../context/core-env-context.js";

/**
 * Cache of preview results keyed by toolCallId, so re-renders of the same
 * edit_file tool call don't re-read the file and re-apply edits.
 */
const previewCache = new Map<string, PreviewEditResult>();

/**
 * Compute the full before/after file content for an edit_file tool call.
 *
 * Runs `previewEdit` asynchronously (it reads the file via CoreEnv) and
 * caches the result by `toolCallId`. Returns `null` while loading or when
 * the input is incomplete (e.g. still streaming).
 *
 * @param toolCallId - Stable id for this tool call (used as cache key).
 * @param path       - File path relative to the project root.
 * @param edits      - Edit operations to preview.
 * @returns The preview result, or `null` while loading.
 */
export function usePreviewEdit(
  toolCallId: string | undefined,
  path: string | undefined,
  edits: Array<{ oldString: string; newString: string; replaceAll?: boolean; startLine?: number }> | undefined
): PreviewEditResult | null {
  const env = useCoreEnv();
  // When toolCallId is undefined the caller has opted out of previewing
  // (e.g. the tool output already carries oldFile/newFile). Skip all work.
  const [result, setResult] = useState<PreviewEditResult | null>(() =>
    toolCallId ? (previewCache.get(toolCallId) ?? null) : null
  );

  useEffect(() => {
    if (!toolCallId || !path || !edits || edits.length === 0) {
      return;
    }

    // Already computed for this tool call — reuse cached value.
    if (previewCache.has(toolCallId)) {
      setResult(previewCache.get(toolCallId) ?? null);
      return;
    }

    let cancelled = false;
    setResult(null);

    previewEdit({ path, edits }, env)
      .then((res) => {
        if (cancelled) return;
        previewCache.set(toolCallId, res);
        setResult(res);
      })
      .catch(() => {
        // Preview is best-effort; on failure leave result null so the UI
        // falls back to the per-edit fragment diff.
        if (!cancelled) setResult(null);
      });

    return () => {
      cancelled = true;
    };
  }, [env, toolCallId, path, edits]);

  return result;
}
