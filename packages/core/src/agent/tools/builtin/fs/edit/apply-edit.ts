/**
 * Apply an `edit_file` operation to disk.
 *
 * The whole edit pipeline lives here: read → match/apply on the original bytes → refuse if the file
 * changed in between → atomic write (preserving permission bits) → per-edit results. The tool
 * definition keeps only the schema, description and the thin `withDuration` wrapper.
 */

import { writeFileAtomic } from "../../../../../utils/atomic-write.js";
import { truncateText } from "../../../../../utils/text-truncation.js";
import { getFile } from "../../../shared/tool-result.js";

import { applyEditsToText } from "./find-edit-match.js";
import { withFileMutationQueue } from "./mutation-queue.js";

import type { EditOperation } from "./find-edit-match.js";
import type { ResolvedCoreEnv } from "../../../../../env";
import type { EditFileOutput } from "../../../shared/schemas.js";

/** The fields the tool returns; `withDuration` adds the timing/base fields. */
export type AppliedEditFile = Pick<EditFileOutput, "path" | "replacements" | "oldFile" | "newFile" | "results">;

export async function applyEditToFile(
  env: ResolvedCoreEnv,
  path: string,
  edits: readonly EditOperation[]
): Promise<AppliedEditFile> {
  return withFileMutationQueue(env, path, async () => {
    const originalContent = await getFile(env, path);

    const applied = applyEditsToText(originalContent, edits);
    if (!applied.ok) {
      throw new Error(`edit_file failed, no changes were written: edit #${applied.index + 1}: ${applied.message}`);
    }

    // An all-identical batch changes nothing; skip the re-read and the write so its mtime and line
    // endings are left alone.
    if (applied.content !== originalContent) {
      // The write must apply to the bytes that were matched. The mutation queue serializes this
      // agent's edits, but an external writer (or another process) can still change the file between
      // the read and the write; refusing is the only honest outcome.
      const currentContent = await getFile(env, path);
      if (currentContent !== originalContent) {
        throw new Error(
          "edit_file failed, no changes were written: the file changed since it was read. Re-read it and retry."
        );
      }

      // A temp file takes its mode from the umask, so replacing an existing file must carry the
      // original bits over or an executable script silently loses `+x`.
      const existingMode = env.fs.stat ? (await env.fs.stat(path).catch(() => undefined))?.mode : undefined;

      // The destination exists (it was read above), so carry its permission bits onto the temp file.
      // A crash mid-write must not truncate the file: same temp+rename path as write_file.
      await writeFileAtomic(env.fs, path, applied.content, {
        onError: "throw",
        ...(existingMode !== undefined ? { mode: existingMode } : {}),
      });
    }

    const results: EditFileOutput["results"] = edits.map((edit, index) => {
      const operation = applied.operations[index] ?? null;
      if (!operation) {
        return {
          oldString: truncateText(edit.oldString, 50),
          newString: truncateText(edit.newString, 50),
          found: true,
          replaced: false,
          count: 0,
          skipped: true,
        };
      }
      return {
        oldString: truncateText(edit.oldString, 50),
        newString: truncateText(edit.newString, 50),
        found: true,
        replaced: true,
        count: operation.count,
        actualLine: operation.firstLine,
        mode: operation.mode,
      };
    });

    return {
      path,
      replacements: results.reduce((sum, result) => sum + result.count, 0),
      oldFile: originalContent,
      newFile: applied.content,
      results,
    };
  });
}
