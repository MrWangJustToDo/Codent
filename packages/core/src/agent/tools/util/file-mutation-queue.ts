/**
 * Per-file mutation queue — serializes operations on the same file.
 *
 * Inspired by pi's approach: each file has a promise chain. Operations on the
 * same file are queued (serialized); operations on different files run in
 * parallel. Uses `path.resolve` to normalize paths so that the same file
 * accessed via different relative paths shares the same queue.
 *
 * There is no external-concurrent-modification detection (no mtime, no content
 * hash). If the file is modified outside the agent session, the oldString
 * won't match, and the tool will error naturally — the LLM re-reads and retries.
 */

import type { ResolvedCoreEnv } from "../../../env";

// ============================================================================
// Queue State
// ============================================================================

const fileMutationQueues = new Map<string, Promise<void>>();

/**
 * Resolve a file path to a canonical queue key.
 * Uses `path.resolve` to normalize relative paths, symlinks, etc.
 * Falls back to the raw path if resolution fails.
 */
function getQueueKey(env: ResolvedCoreEnv, filePath: string): string {
  try {
    // Key includes the workspace root so two runtimes with the same relative path do not
    // share (and serialize against each other's) mutation queue.
    return `${env.rootPath}::${env.path.resolve(filePath)}`;
  } catch {
    return `${env.rootPath}::${filePath}`;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Run `fn` under the mutation queue for `filePath`.
 *
 * Operations on the same file are serialized (one after another), while
 * operations on different files run concurrently. This prevents race
 * conditions when the LLM issues multiple edit_file calls for the same file
 * in parallel.
 *
 * @param filePath - Path to the file (relative or absolute).
 * @param fn       - Async function that reads, modifies, and writes the file.
 * @returns The return value of `fn`.
 */
export async function withFileMutationQueue<T>(
  env: ResolvedCoreEnv,
  filePath: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = getQueueKey(env, filePath);

  // Chain the new operation after the current one for this file.
  const previous = fileMutationQueues.get(key) ?? Promise.resolve();
  let releaseNext!: () => void;
  const next = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  fileMutationQueues.set(key, next);

  // Wait for the previous operation to complete, then run ours.
  await previous;
  try {
    return await fn();
  } finally {
    // Signal the next queued operation to proceed.
    releaseNext();
    // ...and drop our entry once we are the tail of the chain.
    //
    // A chain nobody is waiting on has nothing to serialize against: the next operation on this file
    // creates its own. Keeping it would grow the map for the life of the process — one stale promise
    // (and its closure) per distinct file ever mutated — for a session that edits thousands of files.
    //
    // The identity check is what makes this safe: if another operation queued behind us, the map now
    // holds ITS promise, and this is not ours to remove.
    if (fileMutationQueues.get(key) === next) {
      fileMutationQueues.delete(key);
    }
  }
}

/**
 * How many files currently hold a queue entry.
 *
 * Exists so `validate:file-mutation-queue` can assert the map drains instead of growing with every
 * file a session touches; not used by production paths.
 */
export function fileMutationQueueSize(): number {
  return fileMutationQueues.size;
}
