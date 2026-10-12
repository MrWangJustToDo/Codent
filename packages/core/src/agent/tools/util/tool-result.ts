import type { ResolvedCoreEnv } from "../../../env";

/** Read a file through the registered `CoreEnv` (no host-specific fs import). */
export async function getFile(env: ResolvedCoreEnv, path: string): Promise<string> {
  return env.fs.readFile(path);
}

/**
 * Wrap a tool's execute result with its wall-clock duration, and normalise
 * `cachedOutputPath` to a `null` default when the tool did not cache its output.
 *
 * Errors are **not** caught here — a tool throws on failure and the adapter surfaces it as
 * the `output-error` tool state. Tools that produce large output override `cachedOutputPath`
 * via `maybeCacheOutput`.
 */
export async function withDuration<T extends Record<string, unknown>>(
  fn: () => Promise<T>
): Promise<T & { durationMs: number; cachedOutputPath: string | null }> {
  const startTime = performance.now();
  const result = await fn();
  const durationMs = Math.round(performance.now() - startTime);
  return {
    ...result,
    durationMs,
    cachedOutputPath: (result.cachedOutputPath as string | null | undefined) ?? null,
  };
}
