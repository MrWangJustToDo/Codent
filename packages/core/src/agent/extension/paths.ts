/**
 * Extension discovery paths — project and user defaults under `.agents/`.
 */

import { getEnv, type ResolvedCoreEnv } from "../../env";
import { toPosixPath } from "../../utils/posix-path.js";
import { AGENT_DATA_DIR } from "../../utils/workspace-paths.js";

/** Project-local extension directory (relative to CoreEnv rootPath). */
export const DEFAULT_EXTENSION_DIR = `${AGENT_DATA_DIR}/extension`;

/** Environment variable for additional extension directories (comma-separated). */
export const EXTENSION_DIRS_ENV_VAR = "AGENT_EXTENSION_DIRS";

/**
 * Default extension directories to discover.
 *
 * Load order (later registrations with the same id win):
 * 1. User home: `~/.agents/extension`
 * 2. Project: `.agents/extension`
 * 3. `AGENT_EXTENSION_DIRS` (comma-separated env via CoreEnv)
 * 4. `extraDirs` (caller / `ManagedAgentConfig.extensionDirs` / CLI `--extension-dirs`)
 *
 * Project beats user: the directory a repository carries is the one that describes that project,
 * while the global copy is usually an older install. Explicit directories beat both — the caller
 * asked for them by name. (Skills resolve the same precedence; only their tie-break is first-wins.)
 *
 * Project-specific demo dirs (e.g. `examples/extensions`) are **not** included —
 * pass them via `extraDirs`, CLI `--extension-dirs`, or `AGENT_EXTENSION_DIRS`.
 */
export async function getDefaultExtensionDirs(extraDirs?: readonly string[], env?: ResolvedCoreEnv): Promise<string[]> {
  const e = env ?? getEnv();
  const dirs: string[] = [];

  // Lowest priority first: discovery keeps the LAST file seen for a duplicate id.
  dirs.push(e.path.join(await e.homedir(), AGENT_DATA_DIR, "extension"));
  dirs.push(DEFAULT_EXTENSION_DIR);

  const runEnv = await e.getEnv();
  const home = await e.homedir();
  /** `~` is a shell affordance, not a path segment: resolving it against rootPath produced
   * `<root>/~/.agents/extension`, which does not exist, so the directory was skipped in silence. */
  const expandHome = (dir: string): string =>
    dir === "~" || dir.startsWith("~/") ? e.path.join(home, dir.slice(1)) : dir;

  const envDirs = runEnv[EXTENSION_DIRS_ENV_VAR];
  if (envDirs) {
    const parsedDirs = envDirs
      .split(",")
      .map((d) => expandHome(d.trim()))
      .filter((d) => d.length > 0);
    dirs.push(...parsedDirs);
  }

  if (extraDirs) {
    for (const dir of extraDirs) {
      const trimmed = dir.trim();
      if (trimmed) dirs.push(expandHome(trimmed));
    }
  }

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
