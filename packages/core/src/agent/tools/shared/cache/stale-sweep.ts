/**
 * Shared age-based file sweep for the workspace cache directories.
 *
 * Two caches under `.agents/cache/` stay bounded by deleting entries past an age
 * threshold — background job logs and spilled tool output. The policy is
 * identical in both (readdir → suffix filter → mtime check → best-effort remove,
 * at most once per workspace root per process, never throwing); only the directory, suffix and
 * threshold differ, so the walk lives here once.
 *
 * Age-based on purpose in both cases: the reference-based collector
 * (`cleanupOrphanedToolCache`) can only ever see files a *compacting* session
 * referenced, so a session that never compacted — and any file no session ever
 * referenced — leaks without a blanket age rule.
 *
 * The suffix filter is the isolation guard between the two caches: a `.log`
 * sweep can never eat a spill file, and vice versa, even if the directories are
 * ever merged.
 */

import type { ResolvedCoreEnv } from "../../../../env";

// ============================================================================
// Types
// ============================================================================

export interface StaleSweepOptions {
  /** Re-arm the once-per-process guard. */
  force?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: number;
}

export interface StaleFileSweepSpec {
  /** Workspace-relative directory to scan. */
  dir: string;
  /** Only entries with this suffix are candidates. */
  suffix: string;
  /** Entries whose mtime is older than this are removed. */
  maxAgeMs: number;
}

export interface StaleFileSweeper {
  /**
   * Remove entries older than `maxAgeMs`. Runs at most once per process unless
   * forced. Best-effort: a missing CoreEnv, an unreadable directory, or a racing
   * delete is swallowed and never fails the caller.
   */
  sweep(env: ResolvedCoreEnv, options?: StaleSweepOptions): Promise<number>;
  /** Test-only escape hatch for the once-per-process guard. */
  reset(): void;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a sweeper for one cache directory. Each sweeper owns its own guard, and the guard is
 * keyed by workspace root: the process may host several runtimes (different roots), and a single
 * process-wide boolean made the *first* workspace's write suppress every other workspace's sweep
 * for the life of the process.
 */
export function createStaleFileSweeper(spec: StaleFileSweepSpec): StaleFileSweeper {
  const sweptRoots = new Set<string>();

  return {
    reset(): void {
      sweptRoots.clear();
    },

    async sweep(env: ResolvedCoreEnv, options?: StaleSweepOptions): Promise<number> {
      const rootKey = env?.rootPath ?? "";
      if (sweptRoots.has(rootKey) && !options?.force) return 0;
      sweptRoots.add(rootKey);

      const now = options?.now ?? Date.now();
      let removed = 0;
      try {
        const fs = env.fs;
        if (!(await fs.exists(spec.dir))) return 0;
        const entries = await fs.readdir(spec.dir);
        for (const entry of entries) {
          if (!entry.name.endsWith(spec.suffix)) continue;
          const path = `${spec.dir}/${entry.name}`;
          try {
            const stat = await fs.stat(path);
            if (now - stat.mtime.getTime() <= spec.maxAgeMs) continue;
            await fs.remove(path);
            removed++;
          } catch {
            // Raced with another sweep / removal — ignore.
          }
        }
      } catch {
        // Non-fatal — the sweep is a safety net, never a source of failure.
      }
      return removed;
    },
  };
}
