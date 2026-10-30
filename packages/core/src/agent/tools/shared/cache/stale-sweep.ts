/**
 * Shared age-based file sweep for the workspace cache directories.
 *
 * Every cache under `.agents/cache/` stays bounded the same way: readdir → suffix filter → mtime
 * check → best-effort remove, at most once per workspace root per process, never throwing. Only the
 * directory, suffix and threshold differ, so the walk lives here once and the *table* of those
 * three values lives in `workspace-cache.ts` (`WORKSPACE_CACHE_RETENTION`).
 *
 * Age-based on purpose: the reference-based collector (`cleanupOrphanedToolCache`) can only ever see
 * files a *compacting* session referenced, so a session that never compacted — and any file no
 * session ever referenced — leaks without a blanket age rule.
 *
 * The suffix filter is the isolation guard between artifacts: a `.log` sweep can never eat a spill
 * file, and vice versa, even if the directories are ever merged.
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
  /**
   * One subdirectory to leave alone (workspace-relative), typically the one a live sink is
   * appending to. Nested sweeps only: the session log directory being written must not be reaped
   * just because its earlier entries are old.
   */
  keepDir?: string;
}

export interface StaleFileSweepSpec {
  /** Workspace-relative directory to scan. */
  dir: string;
  /** Only entries with this suffix are candidates. */
  suffix: string;
  /**
   * Override the suffix test for artifacts whose rotated segments do not end with it
   * (`agent.log.1` vs `agent.log`). Defaults to {@link suffix}.
   */
  match?: (name: string) => boolean;
  /** Entries whose mtime is older than this are removed. */
  maxAgeMs: number;
  /**
   * Scan one level of subdirectories as well (one directory per session). Session logs live in
   * `.agents/logs/<sessionId>/`, so a flat scan never reaches them.
   *
   * Directories are deliberately NOT removed when they empty out: `remove` is recursive, so a
   * directory that gained a file between the emptiness check and the delete would lose it. An
   * empty session directory costs one inode and is otherwise inert.
   */
  nested?: boolean;
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
  /** One running pass per root: parallel first writes share it instead of walking the dir N times. */
  const inFlight = new Map<string, Promise<number>>();

  return {
    reset(): void {
      sweptRoots.clear();
    },

    async sweep(env: ResolvedCoreEnv, options?: StaleSweepOptions): Promise<number> {
      const rootKey = env?.rootPath ?? "";
      if (sweptRoots.has(rootKey) && !options?.force) return 0;

      // Concurrent first writes (parallel tool calls) share one pass. Registering the root only
      // after success is what keeps a transient failure retryable; this slot is what keeps that
      // from turning into N parallel directory walks (each `stat` is an HTTP round-trip remotely).
      if (!options?.force) {
        const running = inFlight.get(rootKey);
        if (running) return running;
      }

      const run = (async (): Promise<number> => {
        const now = options?.now ?? Date.now();
        let removed = 0;
        try {
          const fs = env.fs;
          if (!(await fs.exists(spec.dir))) {
            // Do NOT mark the root as swept: a long-lived process (server, TUI) creates the
            // directory later, and marking it here disabled retention for its whole lifetime.
            // The cost is one `exists` per sweep trigger until the directory appears.
            return 0;
          }

          /** Age-sweep one directory's files. */
          const sweepFiles = async (dir: string): Promise<number> => {
            let count = 0;
            const entries = await fs.readdir(dir);
            for (const entry of entries) {
              if (!matches(entry.name)) continue;
              const path = `${dir}/${entry.name}`;
              try {
                const stat = await fs.stat(path);
                if (now - stat.mtime.getTime() <= spec.maxAgeMs) continue;
                await fs.remove(path);
                count++;
              } catch {
                // Raced with another sweep / removal — ignore.
              }
            }
            return count;
          };

          const matches = spec.match ?? ((name: string) => name.endsWith(spec.suffix));

          const entries = await fs.readdir(spec.dir);
          if (spec.nested) {
            for (const entry of entries) {
              const path = `${spec.dir}/${entry.name}`;
              // The directory a live sink is appending to: the caller owns its lifetime.
              if (options?.keepDir === path) continue;
              if (entry.type === "directory") {
                removed += await sweepFiles(path);
              } else if (matches(entry.name)) {
                try {
                  const stat = await fs.stat(path);
                  if (now - stat.mtime.getTime() <= spec.maxAgeMs) continue;
                  await fs.remove(path);
                  removed++;
                } catch {
                  // Raced — ignore.
                }
              }
            }
          } else {
            removed = await sweepFiles(spec.dir);
          }
          // Mark only a COMPLETED pass. The guard is per process, so registering before the I/O
          // meant one transient `exists`/`readdir` failure (a remote env hiccup) disabled the sweep
          // for this workspace until the process restarted — and the age sweep is the only fallback
          // for sessions that never compact.
          sweptRoots.add(rootKey);
        } catch {
          // Non-fatal — the sweep is a safety net, never a source of failure. Unmarked, so the next
          // write retries.
        }
        return removed;
      })();

      if (options?.force) return run;
      inFlight.set(rootKey, run);
      try {
        return await run;
      } finally {
        inFlight.delete(rootKey);
      }
    },
  };
}
