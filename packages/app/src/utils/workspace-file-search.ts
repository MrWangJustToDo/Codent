import { AGENT_DATA_DIR } from "@codent/core";

import { parseGitPathList } from "./workspace-git-paths.js";
import { joinWorkspacePath } from "./workspace-path.js";

import type { CoreEnv } from "@codent/core";

// ============================================================================
// Quick-open file search
//
// File list comes from `git ls-files -z` (tracked + untracked, respects
// .gitignore) — instant even on huge repos. Non-git workspaces fall back to a
// bounded fs walk. Matching is a lightweight fzf-style subsequence scorer.
//
// The list is parsed from NUL records, not lines: `ls-files` output is consumed as a name,
// so a git-quoted or octal-escaped path is a file the picker cannot find by its own name.
// ============================================================================

export interface FuzzyFileResult {
  path: string;
  score: number;
  /** Indices of the query characters inside `path` (for match highlighting). */
  indices: number[];
}

function isUpper(c: string): boolean {
  return c >= "A" && c <= "Z";
}

function isLower(c: string): boolean {
  return c >= "a" && c <= "z";
}

interface FuzzyMatchDetail {
  score: number;
  indices: number[];
}

/**
 * Subsequence fuzzy-match of `query` inside `text` (case-insensitive),
 * returning the score plus the matched character indices. Scoring:
 * +1 per matched char, +2 for consecutive runs, +3 for boundary starts
 * (path segment start / separator / camelCase), +2 when the match reaches the
 * basename.
 */
function fuzzyMatchDetail(query: string, text: string): FuzzyMatchDetail | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return { score: 0, indices: [] };
  if (q.length > t.length) return null;

  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  let lastMatch = -1;
  const indices: number[] = [];
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    score += 1;
    if (i === prevMatch + 1) score += 2;
    if (i === 0 || /[/._\\ -]/.test(text[i - 1]!) || (isUpper(text[i - 1]!) && isLower(text[i]!))) {
      score += 3;
    }
    prevMatch = i;
    lastMatch = i;
    indices.push(i);
    qi += 1;
  }
  if (qi < q.length) return null;

  const basenameStart = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1;
  if (lastMatch >= basenameStart) score += 2;
  return { score, indices };
}

/**
 * Subsequence fuzzy-match score of `query` inside `text` (case-insensitive).
 * Returns null when the query chars do not appear in order. See
 * `fuzzyMatchDetail` for the scoring rules.
 */
export function fuzzyMatch(query: string, text: string): number | null {
  const detail = fuzzyMatchDetail(query, text);
  return detail ? detail.score : null;
}

/** Rank paths by fuzzy score (then name) and cap the result list. */
export function fuzzyFilterFiles(query: string, paths: readonly string[], limit = 50): FuzzyFileResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return paths.slice(0, limit).map((path) => ({ path, score: 0, indices: [] }));

  const results: FuzzyFileResult[] = [];
  for (const path of paths) {
    const detail = fuzzyMatchDetail(q, path);
    if (detail) results.push({ path, score: detail.score, indices: detail.indices });
  }
  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
  return results.slice(0, limit);
}

let fileListCache: { rootPath: string; files: string[] } | null = null;

export function clearWorkspaceFileListCache(): void {
  fileListCache = null;
}

/** Directories skipped by the non-git fs-walk fallback. */
const SKIP_FS_DIRS = new Set([
  ".git",
  "node_modules",
  AGENT_DATA_DIR,
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  ".cache",
  ".turbo",
  ".pnpm-store",
  "target",
]);

export async function fetchWorkspaceFileList(env: CoreEnv, rootPath: string): Promise<string[]> {
  if (fileListCache && fileListCache.rootPath === rootPath) return fileListCache.files;

  const files = new Set<string>();
  try {
    const tracked = await env.runCommand("git ls-files -z", { cwd: rootPath });
    if (tracked.exitCode === 0) {
      for (const p of parseGitPathList(tracked.stdout)) files.add(p);
    }
    const untracked = await env.runCommand("git ls-files -z --others --exclude-standard", { cwd: rootPath });
    if (untracked.exitCode === 0) {
      for (const p of parseGitPathList(untracked.stdout)) files.add(p);
    }
  } catch {
    // Fall through to the fs walk below.
  }

  let result: string[];
  if (files.size > 0) {
    result = [...files];
  } else {
    result = await walkWorkspaceFiles(env, rootPath);
  }
  result.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  fileListCache = { rootPath, files: result };
  return result;
}

/** Bounded recursive fs walk (non-git fallback). */
async function walkWorkspaceFiles(env: CoreEnv, rootPath: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const absDir = relDir ? joinWorkspacePath(env, rootPath, relDir) : rootPath;
    let entries;
    try {
      entries = await env.fs.readdir(absDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.type === "directory") {
        if (SKIP_FS_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        stack.push(relDir ? `${relDir}/${entry.name}` : entry.name);
      } else {
        out.push(relDir ? `${relDir}/${entry.name}` : entry.name);
      }
    }
  }
  return out;
}
