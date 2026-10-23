/**
 * Shared glob pattern and search-result helpers for `glob` and `grep`.
 *
 * These used to live partly in `glob-tool.ts` and partly at the bottom of
 * `search-command.ts`. Both tools need the same brace expansion and path
 * normalization, and neither tool should own the other's implementation.
 */

import { toPosixPath } from "../../../../../utils/posix-path.js";

import type { CoreEnv } from "../../../../../env";

/**
 * Expand simple brace groups in a glob (`*.{ts,tsx}` → `*.ts`, `*.tsx`).
 *
 * Neither `fd --glob`, `find -path`, `grep --include`, nor `rg --glob` performs
 * brace expansion itself, so callers must do it before handing a pattern to the
 * command. Nested groups are resolved iteratively; malformed/unclosed braces stay literal.
 */
export function expandBraceGlobs(pattern: string): string[] {
  const groupRe = /\{([^{}]+)\}/;
  const pending = [pattern];
  const expanded: string[] = [];
  while (pending.length > 0) {
    const current = pending.shift()!;
    const match = groupRe.exec(current);
    if (!match) {
      expanded.push(current);
      continue;
    }
    const full = match[0];
    const alternatives = match[1].split(",");
    const index = current.indexOf(full);
    for (const alt of alternatives) {
      pending.push(current.slice(0, index) + alt + current.slice(index + full.length));
    }
  }
  return expanded;
}

/**
 * Convert a glob into a `find -path` pattern.
 *
 * `find -path` treats `*` as matching `/` too, so a double-star slash segment can be
 * collapsed to a single `*` instead of the old star-slash rewrite. The resulting pattern
 * is only a coarse command-side filter; {@link filterGlobOutput} applies the exact
 * segment-aware glob semantics.
 */
export function findPathPattern(pattern: string): string {
  return pattern
    .replace(/\/\*\*\//g, "/*")
    .replace(/^\*\*\//, "*")
    .replace(/\/\*\*$/g, "/*")
    .replace(/\*\*/g, "*");
}

/**
 * Convert path-separator backslashes to `/` while preserving glob escapes.
 *
 * `src\*.ts` is ambiguous: on Windows the backslash is a separator, while `a\*b.ts`
 * means a literal star. We preserve a backslash before a glob metacharacter (escape
 * semantics) and normalize every other backslash as a separator.
 */
function normalizeGlobSeparators(pattern: string, rootPath?: string): string {
  // On Windows a backslash is overwhelmingly a path separator. Treat it as such there;
  // the escape-preserving branch is for POSIX patterns.
  if (rootPath?.includes("\\")) return toPosixPath(pattern);
  return pattern.replace(/\\(?![*?[\]{}()!+@\\])/g, "/");
}

/** Escape one non-pattern character for a JavaScript regular expression. */
function escapeRegexChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * Convert the supported glob subset to a segment-aware regular expression.
 *
 * `*` must not cross `/`; only `**` may. `find -path` treats `*` as crossing `/`,
 * so it cannot be the final authority for a one-level path glob.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\") {
      // Backslash escapes the next glob metacharacter (`a\*b.ts`, `\[slug\].tsx`).
      i += 1;
      if (i < pattern.length) source += escapeRegexChar(pattern[i]!);
      else source += "\\\\";
    } else if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        source += "\\[";
      } else {
        const body = pattern.slice(i + 1, end);
        source += body.startsWith("!") ? `[^${body.slice(1)}]` : `[${body}]`;
        i = end;
      }
    } else {
      source += escapeRegexChar(char);
    }
  }
  return new RegExp(`${source}$`);
}

/** Normalize a command-output path to the part relative to the search root. */
function relativeToSearchPath(file: string, searchPath: string, rootPath?: string): string {
  let normalized = toPosixPath(file).replace(/\/+$/, "").replace(/^\.\//, "");
  let root = toPosixPath(searchPath).replace(/\/+$/, "").replace(/^\.\//, "");
  if (rootPath) {
    const workspaceRoot = toPosixPath(rootPath).replace(/\/+$/, "").replace(/^\.\//, "");
    if (normalized.startsWith(`${workspaceRoot}/`)) normalized = normalized.slice(workspaceRoot.length + 1);
    else if (normalized === workspaceRoot) normalized = ".";
    if (root.startsWith(`${workspaceRoot}/`)) root = root.slice(workspaceRoot.length + 1);
    else if (root === workspaceRoot) root = ".";
  }
  if (root && root !== ".") {
    if (normalized === root) return "";
    if (normalized.startsWith(`${root}/`)) normalized = normalized.slice(root.length + 1);
  }
  return normalized;
}

/**
 * Test one command-result path against a caller-defined glob.
 *
 * `rootPath` converts an absolute `searchPath` (and an absolute result) to workspace-relative
 * form before comparing; callers that already normalize result paths pass {@link CoreEnv.rootPath}.
 */
export function matchesGlobPath(file: string, searchPath: string, pattern: string, rootPath?: string): boolean {
  const raw = normalizeGlobSeparators(pattern, rootPath);
  const rootAnchored = raw.startsWith("./");
  const normalizedPattern = rootAnchored ? raw.slice(2) : raw;
  const relative = relativeToSearchPath(file, searchPath, rootPath);
  if (relative === "." || relative === "") return false;
  const candidate =
    !rootAnchored && !normalizedPattern.includes("/") ? (relative.split("/").pop() ?? relative) : relative;
  return globToRegExp(normalizedPattern).test(candidate);
}

/** Normalize a caller's `exclude` value for both command-side and JS-side filtering. */
export function normalizeExcludePattern(exclude: string): string {
  return toPosixPath(exclude).replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Whether a result path is covered by an `exclude` value.
 *
 * A bare name (`vendor`, `*.log`) matches any path segment; a path pattern is relative to the
 * search root, but also matches at any depth so fd/find cannot disagree with the JS filter.
 */
export function matchesExcludePath(file: string, searchPath: string, exclude: string, rootPath?: string): boolean {
  if (!exclude) return false;
  const relative = relativeToSearchPath(file, searchPath, rootPath);
  if (!relative || relative === ".") return false;
  const pattern = normalizeExcludePattern(exclude);
  if (!pattern) return false;
  const direct = globToRegExp(pattern);
  if (direct.test(relative)) return true;
  if (!pattern.includes("/") && relative.split("/").some((segment) => direct.test(segment))) return true;
  const depthTolerant = pattern.startsWith("**/") ? pattern : `**/${pattern}`;
  return globToRegExp(depthTolerant).test(relative);
}

/**
 * Normalize a search-tool result path to a workspace-relative POSIX path without `./`.
 * Both `find`/`fd` and `grep`/`rg` emit different prefixes for the same file depending
 * on the search root; the model and UI should see one form.
 */
export function normalizeSearchPath(file: string, env: CoreEnv): string {
  let normalized = toPosixPath(file).replace(/\/+$/, "");
  const root = toPosixPath(env.rootPath).replace(/\/+$/, "");
  if (root && normalized.startsWith(`${root}/`)) normalized = normalized.slice(root.length + 1);
  else if (root && normalized === root) normalized = ".";
  return normalized.replace(/^\.\//, "");
}

/** Filter command output down to the requested glob (and apply the output cap). */
export function filterGlobOutput(
  output: string,
  pattern: string,
  searchPath: string,
  count: number,
  env: CoreEnv,
  exclude?: string
): string {
  return output
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0)
    .filter((file) => matchesGlobPath(file, searchPath, pattern, env.rootPath))
    .filter((file) => !exclude || !matchesExcludePath(file, searchPath, exclude, env.rootPath))
    .slice(0, count)
    .map((file) => normalizeSearchPath(file, env))
    .join("\n");
}
