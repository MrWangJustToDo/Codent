/**
 * One size gate for the edit pipeline.
 *
 * `read_file` refuses to materialise a file above {@link OUTPUT_LIMITS.MAX_FILE_READ_BYTES}. The
 * edit tools read the WHOLE file to match and splice (and the approval preview reads it again), so
 * one `edit_file` against a multi-hundred-MB log materialised it in the process and persisted the
 * before/after text in the tool output. Same boundary, same message shape as the read tool.
 */

import { formatByteSize } from "../../../../../utils/byte-size.js";
import { OUTPUT_LIMITS } from "../../../shared/output-limits.js";

import type { CoreEnv } from "../../../../../env";

export async function assertEditableFileSize(env: Pick<CoreEnv, "fs">, path: string): Promise<void> {
  const stat = env.fs.stat ? await env.fs.stat(path).catch(() => undefined) : undefined;
  if (stat && stat.size > OUTPUT_LIMITS.MAX_FILE_READ_BYTES) {
    throw new Error(
      `File too large to edit: ${formatByteSize(stat.size)} (max ${formatByteSize(OUTPUT_LIMITS.MAX_FILE_READ_BYTES)}). ` +
        `Split the change or target a smaller file.`
    );
  }
}
