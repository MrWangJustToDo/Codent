/**
 * Extension discovery paths — project and user defaults under `.agents/`.
 */

import { getEnv, type ResolvedCoreEnv } from "../../env";
import { toPosixPath } from "../../utils/posix-path.js";

/** Project-local extension directory (relative to CoreEnv rootPath). */
export const DEFAULT_EXTENSION_DIR = ".agents/extension";

/** Environment variable for additional extension directories (comma-separated). */
export const EXTENSION_DIRS_ENV_VAR = "AGENT_EXTENSION_DIRS";

/**
 * Default extension directories to discover.
 *
 * Load order (later registrations with the same id win):
 * 1. `extraDirs` (caller / `ManagedAgentConfig.extensionDirs` / CLI `--extension-dirs`)
 * 2. `AGENT_EXTENSION_DIRS` (comma-separated env via CoreEnv)
 * 3. Project: `.agents/extension`
 * 4. User home: `~/.agents/extension`
 *
 * Project-specific demo dirs (e.g. `examples/extensions`) are **not** included —
 * pass them via `extraDirs`, CLI `--extension-dirs`, or `AGENT_EXTENSION_DIRS`.
 */
export async function getDefaultExtensionDirs(extraDirs?: readonly string[], env?: ResolvedCoreEnv): Promise<string[]> {
  const e = env ?? getEnv();
  const dirs: string[] = [];

  if (extraDirs) {
    for (const dir of extraDirs) {
      const trimmed = dir.trim();
      if (trimmed) dirs.push(trimmed);
    }
  }

  const runEnv = await e.getEnv();
  const envDirs = runEnv[EXTENSION_DIRS_ENV_VAR];
  if (envDirs) {
    const parsedDirs = envDirs
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    dirs.push(...parsedDirs);
  }

  dirs.push(DEFAULT_EXTENSION_DIR);
  dirs.push(e.path.join(await e.homedir(), ".agents", "extension"));

  return dirs;
}

/** Resolve a search dir against CoreEnv rootPath when relative. */
export function resolveExtensionDir(dir: string, env?: ResolvedCoreEnv): string {
  const e = env ?? getEnv();
  return e.path.isAbsolute(dir) ? e.path.normalize(dir) : e.path.join(e.rootPath, dir);
}

/** True for loadable extension entry files (not tests / declarations). */
export function isExtensionModuleFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith(".d.ts")) return false;
  if (/\.(test|spec)\.(m?[jt]s)$/i.test(lower)) return false;
  return /\.(mjs|cjs|js|ts)$/i.test(lower);
}

/** Build a `file://` URL for dynamic import without depending on `node:url`. */
export function pathToFileUrl(absPath: string): string {
  const normalized = toPosixPath(absPath);
  if (normalized.startsWith("/")) {
    return `file://${normalized}`;
  }
  return `file:///${normalized}`;
}
