/**
 * Crash-safe whole-file write.
 *
 * `writeFile(path, body)` truncates the destination before writing, so a crash, a power loss, or
 * a concurrent reader observes a zero-length or half-written file. For an append-only log that is
 * recoverable (a torn trailing line is skipped), but for a whole-document file (`models.json`,
 * a session log rewrite, a tool edit) it destroys the previous state. Write a sibling temp file,
 * then `rename` it into place: a reader sees either the old file or the new one.
 *
 * The fs is structural on purpose — hosts provide `rename` optionally, and a host without it
 * degrades to the in-place write rather than losing the save.
 *
 * The FAILURE POLICY is a parameter, not a second implementation: a document save inside core
 * (`models.json`, a job record) degrades to an in-place write when the atomic path fails, while
 * the mutation tools must fail loudly — silently degrading a tool's write is worse than the error.
 * Both share the unique temp name + cleanup rule here.
 */

export interface AtomicWriteFs {
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /** Optional: hosts that provide it get the atomic path. */
  rename?(oldPath: string, newPath: string): Promise<void>;
  /** Optional: lets the atomic path preserve the destination's permission bits. */
  chmod?(path: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface AtomicWriteOptions {
  /**
   * What to do when the temp write or the rename fails.
   *
   * - `"fallback"` (default): clean up and write in place — a document save is better degraded
   *   than lost.
   * - `"throw"`: rethrow after cleanup. Used by `write_file` / `edit_file`, where a silent
   *   non-atomic fallback would hide the failure from the model and the user.
   */
  onError?: "fallback" | "throw";
  /**
   * Permission bits to put on the replacement.
   *
   * A temp file is created fresh, so its mode comes from the umask: without this, replacing an
   * executable script (or any file with a non-default mode) silently drops the bit. Applied to the
   * temp BEFORE the rename, so the destination is never briefly world-writable/executable. Ignored
   * when the host has no `chmod` — the degradation every host had before.
   */
  mode?: number;
}

let tempSequence = 0;

/**
 * Per-process tag in the temp name.
 *
 * The in-process counter restarts at 1 in every process, so two processes writing the same target
 * in the same millisecond produced the SAME temp path: the second body overwrote the first, one
 * rename succeeded and the other hit ENOENT and fell back to an in-place write. A random tag costs
 * nothing and makes the name unique across writers, which is what the comment above promises.
 */
function processTag(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

export async function writeFileAtomic(
  fs: AtomicWriteFs,
  path: string,
  content: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  if (!fs.rename) {
    await fs.writeFile(path, content);
    return;
  }

  // Unique per attempt: two concurrent writers to the same target (models.json is not
  // serialized) must not share one temp file and rename each other's body.
  const tmpPath = `${path}.tmp-${processTag()}-${Date.now().toString(36)}-${++tempSequence}.tmp`;
  try {
    await fs.writeFile(tmpPath, content);
    if (options.mode !== undefined && fs.chmod) await fs.chmod(tmpPath, options.mode);
    await fs.rename(tmpPath, path);
    return;
  } catch (error) {
    try {
      await fs.remove(tmpPath);
    } catch {
      // The temp file may not exist if the initial write failed.
    }
    if (options.onError === "throw") throw error;
  }
  // Best-effort document save: fall back to an in-place write rather than dropping it; a host
  // whose `rename` fails simply stays non-atomic.
  await fs.writeFile(path, content);
}
