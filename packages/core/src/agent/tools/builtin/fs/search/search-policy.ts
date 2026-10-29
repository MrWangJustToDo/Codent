/**
 * The workspace's search exclusion policy — ONE resolution, consumed by every search engine.
 *
 * Two questions decide what a `grep` / `glob` call may look at, and they used to be answered
 * twice (a hand-kept directory list in the tools, and nothing at all for VCS ignores):
 *
 * 1. **What is not source?** Build trees, dependency trees, caches — and the agent's own runtime
 *    data (`.agents/`), which is derived from {@link AGENT_DATA_DIR} rather than restated here.
 *    This list must hold even when the workspace is not a git repository.
 * 2. **What does the repository itself exclude?** `.gitignore` (and `.git/info/exclude`, the
 *    global excludes) is the authority every other coding agent follows — `rg` honours it by
 *    default, and `git grep` cannot do otherwise. Maintaining a second, longer list of directory
 *    names instead is how a 524 MB `.agents/` and a `tmp/` full of cloned repositories ended up
 *    inside a "repo-wide" search: the list always lags the repository.
 *
 * The two are complementary, not alternatives: (1) is the floor for non-git workspaces, (2) makes
 * the tool agree with the repository in a git one.
 *
 * **Explicit intent wins.** A caller that names a path inside an excluded tree (`path: ".agents/
 * sessions"`, `path: "dist"`, or a `.gitignore`d directory) gets that subtree searched — see
 * {@link searchTargetBypassesIgnore}. Ignoring is a default, not a cage.
 */

import { toPosixPath } from "../../../../../utils/posix-path.js";
import { AGENT_DATA_DIR } from "../../../../../utils/workspace-paths.js";
import { execArgs } from "../../shell/exec-args.js";

import type { CoreEnv } from "../../../../../env";

/**
 * Directory names pruned from every search, whatever the workspace looks like.
 *
 * Deliberately short and boring: only trees that are generated or vendored in essentially every
 * project. Anything project-specific belongs in the repository's own ignore file, which is the
 * point of the policy — see the module doc.
 */
export const DEFAULT_EXCLUDE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".next",
  ".output",
  ".venv",
  "__pycache__",
] as const;

/** The resolved exclusion rules for one search. */
export interface SearchPolicy {
  /** Directory names pruned at any depth (and reopened when the caller targets one explicitly). */
  readonly excludeDirs: readonly string[];
  /**
   * Whether the repository's own ignore configuration applies.
   *
   * True by default, matching `rg`, `git grep`, and every other coding agent. A future workspace
   * setting (`.agents/config/search.json`) can turn it off; nothing consumes the toggle yet, and it
   * exists so the engines do not each grow their own switch.
   */
  readonly respectVcsIgnore: boolean;
}

/** The one policy every search engine consumes (the extension point for a workspace config). */
export function defaultSearchPolicy(): SearchPolicy {
  return {
    excludeDirs: [...new Set([...DEFAULT_EXCLUDE_DIRS, AGENT_DATA_DIR])],
    respectVcsIgnore: true,
  };
}

/** Path segments of a search root, POSIX-folded; `"."`, `""` and a bare root yield none. */
export function searchPathSegments(searchPath: string): string[] {
  return toPosixPath(searchPath)
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
}

/**
 * Directories still excluded for this search root.
 *
 * A directory the caller is *inside* stops being an exclusion: `path: "dist"` means files inside
 * `dist`, so excluding every `dist` at any depth would make the explicit request return nothing.
 * The rule is segment-based rather than basename-based for that reason: `path: ".agents/sessions"`
 * names a directory *inside* an excluded tree, and the old basename check could not see it.
 */
export function activeExcludeDirs(searchPath: string, policy: SearchPolicy = defaultSearchPolicy()): string[] {
  const segments = searchPathSegments(searchPath);
  return policy.excludeDirs.filter((dir) => !segments.includes(dir));
}

/**
 * Memo of "is this workspace inside a git work tree" (one spawn, then free).
 *
 * Keyed by `rootPath`, not by the env object: ambient tool calls receive one shared Proxy whose
 * identity never changes, so an object-keyed memo answered for the wrong workspace the moment a
 * second one was registered in the same process (a validator's fixture, a host with two runtimes).
 * The answer is a property of the directory.
 *
 * Entries expire: a workspace can BECOME a repository during a session (`git init`), and a
 * permanent memo meant `grep`/`glob` ignored `.gitignore` for the rest of the process. A TTL keeps
 * the spawn cost amortized without making a stale "not a repo" a fact of the runtime.
 */
const GIT_WORK_TREE_TTL_MS = 30_000;
const gitWorkTreeCache = new Map<
  string,
  { probe: Promise<{ decided: boolean; isRepo: boolean }>; expiresAt: number }
>();

/**
 * Whether the workspace is inside a git work tree — the gate for every VCS-aware rung.
 *
 * Asks git for a *string* (`true` / `false`), not an exit status: a probe whose answer is "silent
 * and zero" cannot be told apart from a host stub that answers zero to everything, and reading
 * that as "this path is ignored" silently disabled the fallback rung.
 *
 * Only a *decided* answer is memoized: a probe cut short by the run's signal (Esc) learned
 * nothing, and caching that would report "no repo" for the rest of the session.
 */
export function isGitWorkTree(env: CoreEnv, signal?: AbortSignal): Promise<boolean> {
  const key = env.rootPath;
  const now = Date.now();
  const cached = gitWorkTreeCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.probe.then((result) => {
      if (!result.decided) gitWorkTreeCache.delete(key);
      return result.isRepo;
    });
  }
  const probe = (async () => {
    try {
      const result = await execArgs(env, "git", ["-P", "rev-parse", "--is-inside-work-tree"], {
        cwd: env.rootPath,
        timeout: 10_000,
        ...(signal ? { signal } : {}),
      });
      if (result.missing) return { decided: true, isRepo: false };
      return { decided: true, isRepo: result.code === 0 && result.stdout.trim() === "true" };
    } catch {
      // Aborted with the run: the answer is unknown, not "no".
      return { decided: false, isRepo: false };
    }
  })();
  gitWorkTreeCache.set(key, { probe, expiresAt: now + GIT_WORK_TREE_TTL_MS });
  return probe.then((result) => {
    if (!result.decided) gitWorkTreeCache.delete(key);
    return result.isRepo;
  });
}

/**
 * Whether git's ignore rules would skip this path.
 *
 * One `git check-ignore -q`: exit 0 = ignored, 1 = tracked/not ignored. Re-implementing
 * `.gitignore` parsing would disagree with git on negation, anchoring, nested files and global
 * excludes, so the authority stays git's. Callers gate this on {@link isGitWorkTree}, and an
 * aborted probe reports "not ignored" so the run's own cancellation is what surfaces.
 */
export async function isVcsIgnored(env: CoreEnv, searchPath: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await execArgs(env, "git", ["-P", "check-ignore", "-q", "--", searchPath], {
      cwd: env.rootPath,
      timeout: 10_000,
      ...(signal ? { signal } : {}),
    });
    if (result.missing || result.stdout.trim() !== "") return false;
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Whether this search must bypass the ignore rules.
 *
 * Only an *explicit* target can: the workspace root itself never does (that is the case the ignore
 * rules exist for), and neither does a single file (the engines search an explicitly named file
 * directly, so there is nothing to bypass). A target inside a policy directory is decided without
 * spawning git; anything else asks git once.
 */
export async function searchTargetBypassesIgnore(
  env: CoreEnv,
  policy: SearchPolicy,
  searchPath: string,
  options: { isFile: boolean; signal?: AbortSignal }
): Promise<boolean> {
  const segments = searchPathSegments(searchPath);
  if (segments.length === 0 || options.isFile) return false;
  if (segments.some((segment) => policy.excludeDirs.includes(segment))) return true;
  if (!policy.respectVcsIgnore) return false;
  if (!(await isGitWorkTree(env, options.signal))) return false;
  return isVcsIgnored(env, searchPath, options.signal);
}
