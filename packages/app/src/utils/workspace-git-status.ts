import { parseGitStatusZ } from "./workspace-git-paths.js";

import type { CoreEnv } from "@codent/core";

// ============================================================================
// Git Status
// ============================================================================

/**
 * Parse a `git status --porcelain -z` payload into `path → status`.
 *
 * The parsing itself lives in `workspace-git-paths`, shared with the diff-stats parse —
 * both consumers had independently taken git's *quoted* line-oriented output literally,
 * which produced paths that do not exist for any path containing a space, a quote, or
 * (with git's default `core.quotePath`) a non-ASCII byte. Keeping the rule in one place is
 * what stops the next consumer from re-deriving it wrongly.
 *
 * @example
 * parseGitStatus("M  src/a.ts\0") // Map { "src/a.ts" => "M" }
 */
export function parseGitStatus(raw: string): Map<string, string> {
  return parseGitStatusZ(raw);
}

let gitStatusCache: { rootPath: string; status: Map<string, string> } | null = null;

export function clearGitStatusCache(): void {
  gitStatusCache = null;
}

export async function fetchGitStatus(env: CoreEnv, rootPath: string): Promise<Map<string, string>> {
  if (gitStatusCache && gitStatusCache.rootPath === rootPath) {
    return gitStatusCache.status;
  }
  try {
    // `-z` (NUL-delimited, never quoted) and `--untracked-files=all` (expand untracked
    // directories into their files). Without `-uall` git reports one record for a wholly
    // untracked directory, which has no file behind it and no name of its own — the
    // nameless row this parsing exists to avoid.
    const result = await env.runCommand("git status --porcelain -z --untracked-files=all", {
      cwd: rootPath,
    });
    const status = parseGitStatus(result.stdout);
    gitStatusCache = { rootPath, status };
    return status;
  } catch {
    return new Map();
  }
}
