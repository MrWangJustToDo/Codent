/**
 * Environment context utilities shared between root agent and subagents.
 *
 * Extracts date and git info — the two pieces of dynamic context that are
 * needed by both the root agent's turn context system and subagent runs.
 */

import { truncateText } from "../../utils/text-truncation.js";

import type { ResolvedCoreEnv } from "../../env";

export interface GitInfo {
  branch?: string;
  status?: string;
}

/** How many status entries a `<git_status>` block lists before summarising the rest. */
const MAX_GIT_STATUS_LINES = 10;
/** Per-entry cap, so one pathological path cannot dominate the block. */
const MAX_GIT_STATUS_LINE_CHARS = 120;

/**
 * Bound `git status --short` for turn context.
 *
 * The raw output is unbounded AND changes on every file write, so a long editing loop appended one
 * full listing per turn (200 changed files ≈ 8 KB each), all of which stay on the wire — the earlier
 * blocks are superseded, not replaced. Compaction eventually drops them, and it pays for them by
 * summarizing real history instead. A counts line plus the first few paths keeps the block small
 * (~0.5 KB) and still tells the model what changed; `run_command` is there for the full list.
 */
export function summarizeGitStatus(raw: string): string {
  const lines = raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";

  const counts = { untracked: 0, added: 0, modified: 0, deleted: 0, renamed: 0 };
  for (const line of lines) {
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    if (x === "?" && y === "?") counts.untracked += 1;
    else if (x === "R" || y === "R") counts.renamed += 1;
    else if (x === "A" || y === "A") counts.added += 1;
    else if (x === "D" || y === "D") counts.deleted += 1;
    else counts.modified += 1;
  }

  const summary = [
    counts.added > 0 ? `${counts.added} added` : "",
    counts.modified > 0 ? `${counts.modified} modified` : "",
    counts.deleted > 0 ? `${counts.deleted} deleted` : "",
    counts.renamed > 0 ? `${counts.renamed} renamed` : "",
    counts.untracked > 0 ? `${counts.untracked} untracked` : "",
  ]
    .filter(Boolean)
    .join(", ");

  const shown = lines.slice(0, MAX_GIT_STATUS_LINES).map((line) => truncateText(line, MAX_GIT_STATUS_LINE_CHARS));
  const hidden = lines.length - shown.length;
  return [summary, ...shown, ...(hidden > 0 ? [`… +${hidden} more`] : [])].join("\n");
}

/**
 * Current date formatted for `<current_date>` turn context.
 * Day granularity keeps it stable within a session day (prefix-cache friendly).
 */
export function getCurrentDate(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZoneName: "short",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Fetch git branch and status from the workspace.
 * Both calls are best-effort — failures are silently ignored.
 * Results are cached for a short TTL (git info is stable within a few
 * seconds) so repeated lookups per turn (root turn-context + subagent runs)
 * don't spawn two shell calls each time.
 */
const GIT_INFO_TTL_MS = 2000;
/**
 * Keyed by the env INSTANCE, not `rootPath`: two runtimes can report the same path string while
 * pointing at different filesystems (`/workspace` is a common container path), and the cached info
 * is injected into the prompt. Same rule as `isGitWorkTree`'s probe memo.
 */
const gitInfoCache = new WeakMap<object, { at: number; info: GitInfo }>();

export async function getGitInfo(env: ResolvedCoreEnv): Promise<GitInfo> {
  const now = Date.now();
  const cached = gitInfoCache.get(env);
  if (cached && now - cached.at < GIT_INFO_TTL_MS) {
    return { ...cached.info };
  }

  const info: GitInfo = {};

  try {
    const branchResult = await env.runCommand("git branch --show-current", {
      cwd: env.rootPath,
      timeout: 2000,
    });
    if (branchResult.exitCode === 0) {
      info.branch = branchResult.stdout.trim();
    }
  } catch {
    // Git not available or not a git repo — skip
  }

  try {
    const statusResult = await env.runCommand("git status --short", {
      cwd: env.rootPath,
      timeout: 2000,
    });
    if (statusResult.exitCode === 0 && statusResult.stdout.trim()) {
      // Bounded here, at the single producer, so the root agent and subagent runs cannot disagree
      // about how much of the listing a turn carries.
      info.status = summarizeGitStatus(statusResult.stdout);
    }
  } catch {
    // Git not available — skip
  }

  gitInfoCache.set(env, { at: now, info });
  return info;
}
