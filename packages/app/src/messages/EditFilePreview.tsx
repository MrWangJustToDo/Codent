import { Box, Text } from "ink";
import { Fragment, memo } from "react";

import { usePreviewEdit, useSize } from "../hooks";
import { COLORS } from "../theme/colors.js";

import { MessageDiffView } from "./MessageDiffView.js";

/**
 * Renders the edit_file tool's input as a diff preview.
 *
 * Shows two layers:
 *  1. A full-file diff (original file → file after all edits applied).
 *  2. The per-edit fragment diffs (oldString → newString for each edit),
 *     which give a focused view of each individual change.
 *
 * The full-file content is sourced from two places depending on lifecycle:
 *  - After the tool executed (output-available): read `oldFile`/`newFile`
 *    directly from the tool output. This is authoritative and stays correct
 *    even if the file is later modified by other edits.
 *  - Before execution (approval phase): compute on the fly via `previewEdit`,
 *    which reads the current file and applies the edits in memory.
 *
 * When the full-file preview is unavailable (file not found, read error, etc.),
 * falls back to rendering each per-edit fragment as its own diff, using
 * oldString → newString as the before/after content with `startLine` for
 * proper line number alignment.
 */
export const EditFilePreview = memo(function EditFilePreview({
  toolCallId,
  path,
  edits,
  output,
}: {
  toolCallId: string;
  path: string;
  edits: Array<{ oldString: string; newString: string; startLine?: number; replaceAll?: boolean }>;
  bodyWidth: number;
  output?: { oldFile?: string; newFile?: string };
}) {
  const width = useSize((s) => s.state.screenWidth) - 4;

  // Authoritative source once the tool has run: prefer output over preview.
  const hasOutput = output && typeof output.oldFile === "string" && typeof output.newFile === "string";
  const preview = usePreviewEdit(
    hasOutput ? undefined : toolCallId,
    hasOutput ? undefined : path,
    hasOutput ? undefined : edits
  );

  const oldFile = hasOutput ? output!.oldFile! : preview?.oldFile;
  const newFile = hasOutput ? output!.newFile! : preview?.newFile;
  const hasFullPreview = oldFile !== undefined && newFile !== undefined;

  return (
    <Box flexDirection="column">
      {preview?.error ? (
        /* The tool would refuse this set, so nothing will be written: an empty diff here is the
           truth, and the reason is what makes it readable instead of confusing. */
        <Text color={COLORS.warning} wrap="wrap">
          ⚠ edit_file will refuse this: {preview.error}
        </Text>
      ) : null}
      {hasFullPreview ? (
        /* Full-file diff: original file → file after all edits applied */
        <MessageDiffView width={width} oldPath={path} oldFile={oldFile} newPath={path} newFile={newFile} />
      ) : (
        /* Fallback: per-edit fragment diffs when full-file preview is unavailable */
        edits.map((edit, i) => (
          <Fragment key={i}>
            {edit.oldString !== edit.newString && (
              <MessageDiffView
                width={width}
                oldPath={path}
                oldFile={edit.oldString}
                newPath={path}
                newFile={edit.newString}
                startLine={edit.startLine}
              />
            )}
          </Fragment>
        ))
      )}
    </Box>
  );
});
