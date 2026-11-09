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
  /**
   * Optional: resolve the destination through symlinks before the rename.
   *
   * `rename(2)` replaces the destination DIRECTORY ENTRY, so swapping the temp over a symlink
   * replaces the link itself and leaves its target untouched — an edit that reports success while
   * the file the user (and the build) actually reads keeps the old content. Hosts without it keep
   * the lexical behaviour.
   */
  realpath?(path: string): Promise<string>;
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

  // Follow a symlink to its target: the rename must swap the file the link points at, not the
  // link. A missing target (a new file, or a dangling link) has nothing to resolve — the lexical
  // path is already the right destination in that case.
  let target = path;
  if (fs.realpath) {
    try {
      target = await fs.realpath(path);
    } catch {
      target = path;
    }
  }

  const attempt = async (destination: string): Promise<void> => {
    // Unique per attempt: two concurrent writers to the same target (models.json is not
    // serialized) must not share one temp file and rename each other's body.
    const tmpPath = `${destination}.tmp-${processTag()}-${Date.now().toString(36)}-${++tempSequence}.tmp`;
    try {
      await fs.writeFile(tmpPath, content);
      if (options.mode !== undefined && fs.chmod) await fs.chmod(tmpPath, options.mode);
      await fs.rename!(tmpPath, destination);
    } catch (error) {
      try {
        await fs.remove(tmpPath);
      } catch {
        // The temp file may not exist if the initial write failed.
      }
      throw error;
    }
  };

  try {
    await attempt(target);
    return;
  } catch (error) {
    // A resolved target is not always reachable through the fs layer: a host may reject the real
    // path when the WORKSPACE ROOT itself sits under a symlink (macOS `/tmp` → `/private/tmp`),
    // even though it accepts the lexical spelling. Fall back to the lexical destination ONLY for
    // that containment refusal.
    //
    // Not for every failure: if the symlink's TARGET directory is not writable (EACCES, or the
    // server's mapped `permission_denied`) but the link's directory is, retrying the lexical path
    // would rename the temp over the LINK — the link is destroyed, the real file untouched, and
    // the tool reports success.
    let failure: unknown = error;
    if (target !== path && isContainmentRefusal(error)) {
      try {
        await attempt(path);
        return;
      } catch (lexicalError) {
        // Both spellings failed; the lexical error is the one the caller can act on.
        failure = lexicalError;
      }
    }
    if (options.onError === "throw") throw failure;
  }
  // Best-effort document save: fall back to an in-place write rather than dropping it; the OS
  // follows a symlink on `writeFile`, so this writes THROUGH the link instead of replacing it.
  await fs.writeFile(path, content);
}

/**
 * Whether an fs error is a lexical containment refusal rather than an OS write failure.
 *
 * The ERROR CODE ALONE IS NOT ENOUGH: the server maps a genuine `EACCES`/`EPERM` to
 * `permission_denied` too (`server/src/routes/fs.ts`), so a read-only target directory would look
 * identical to "the workspace root is a symlink". Retrying the lexical spelling in that case
 * renames the temp over the link — the corruption this function exists to prevent. Only the
 * containment message (raised by `resolvePath` in the native/remote env) identifies it.
 */
function isContainmentRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "permission_denied" && typeof message === "string" && /path traversal/i.test(message);
}
