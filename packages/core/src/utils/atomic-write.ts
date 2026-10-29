/**
 * Crash-safe whole-file write for best-effort document saves.
 *
 * `write-file-tool` keeps its own variant on purpose: it must FAIL LOUDLY when the rename fails,
 * while a document save here degrades to an in-place write instead of losing the save. The shared
 * rule is the unique temp name + cleanup, not the failure policy.
 *
 * `writeFile(path, body)` truncates the destination before writing, so a crash, a power loss, or
 * a concurrent reader observes a zero-length or half-written file. For an append-only log that is
 * recoverable (a torn trailing line is skipped), but for a whole-document file (`models.json`,
 * a session log rewrite) it destroys the previous state. Write a sibling temp file, then `rename`
 * it into place: a reader sees either the old file or the new one.
 *
 * The fs is structural on purpose — hosts provide `rename` optionally, and a host without it
 * degrades to the in-place write rather than losing the save.
 */

export interface AtomicWriteFs {
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /** Optional: hosts that provide it get the atomic path. */
  rename?(oldPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
}

let tempSequence = 0;

export async function writeFileAtomic(fs: AtomicWriteFs, path: string, content: string): Promise<void> {
  if (!fs.rename) {
    await fs.writeFile(path, content);
    return;
  }

  // Unique per attempt: two concurrent writers to the same target (models.json is not
  // serialized) must not share one temp file and rename each other's body.
  const tmpPath = `${path}.${Date.now().toString(36)}-${++tempSequence}.tmp`;
  try {
    await fs.writeFile(tmpPath, content);
    await fs.rename(tmpPath, path);
    return;
  } catch {
    // Best-effort cleanup, then fall back to an in-place write rather than dropping the save; a
    // host whose `rename` fails simply stays non-atomic.
    try {
      await fs.remove(tmpPath);
    } catch {
      // The temp file may not exist if the initial write failed.
    }
  }
  await fs.writeFile(path, content);
}
