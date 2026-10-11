/**
 * Instruction-file discovery and `@` import expansion.
 *
 * This is the single source of truth for **which** instruction file wins and
 * **what it expands to**, shared by the two paths that must agree:
 *
 * - `agent/prompt/agent-doc-loader.ts` — loads the doc into `<project_instructions>`
 *   in the system prompt at agent creation.
 * - `agent/turn-context/instruction-context.ts` — detects edits to that doc and
 *   re-injects the latest content into the turn context.
 *
 * They used to carry parallel copies of the filename list, the byte budget, the
 * discovery loop, and the override-filename rule, kept in sync by comments. They
 * must not drift: change detection digests what this module resolves, so an edit
 * to an *imported* file is only visible if both paths expand identically. Hashing
 * raw bytes instead would miss it entirely and leave the stale
 * `<project_instructions>` in place forever.
 *
 * @see https://agents.md/ — the cross-tool standard for AGENTS.md
 */

import { getEnv } from "../../env";
import { toPosixPathKey } from "../../utils/posix-path.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Instruction filenames in discovery priority order — first existing file wins.
 *
 * - `CLAUDE.md` first: Claude Code's native format
 * - `AGENTS.md` second: the cross-tool standard
 *
 * Composition between them is explicit, via `@` imports (see
 * {@link expandInstructionImports}), not implicit fallback: a project that keeps
 * `CLAUDE.md` as a thin pointer at `AGENTS.md` writes `@AGENTS.md` in it.
 */
export const INSTRUCTION_FILENAMES = ["CLAUDE.md", "AGENTS.md"];

/**
 * Maximum bytes read from an instruction file after import expansion.
 * Matches Codex CLI's `project_doc_max_bytes` default (65536 = 64 KiB).
 */
export const INSTRUCTION_MAX_BYTES = 65536;

/**
 * Maximum `@` import nesting depth.
 *
 * Matches Claude Code's documented limit (5 hops) and the equivalent guard in
 * Gemini CLI's `memoryImportProcessor`. Depth alone is not enough to stop a
 * cycle — {@link expandInstructionImports} also tracks visited paths per chain.
 */
export const MAX_INSTRUCTION_IMPORT_DEPTH = 5;

// ============================================================================
// Types
// ============================================================================

/** An instruction file resolved to its final, expanded, budgeted content. */
export interface ResolvedInstructionFile {
  /** Absolute path to the file. */
  path: string;
  /** Base filename (e.g. `CLAUDE.md`). */
  name: string;
  /** Expanded content, already truncated to the byte budget. */
  content: string;
  /** Whether the byte budget cut the content. */
  truncated: boolean;
  /**
   * Diagnostics from import expansion (missing target, cycle, depth/budget stop).
   * Empty when the file had no imports or all of them expanded cleanly.
   */
  importNotices: string[];
}

/** Discovery configuration shared by the loader and turn-context paths. */
export interface InstructionDiscoveryOptions {
  rootPath: string;
  /** Filenames in priority order. Defaults to {@link INSTRUCTION_FILENAMES}. */
  filenames?: string[];
  /** Byte budget for the expanded content. Defaults to {@link INSTRUCTION_MAX_BYTES}. */
  maxBytes?: number;
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Resolve the highest-priority instruction file under `rootPath`.
 *
 * Mirrors cross-tool conventions: the first existing file in `filenames` order
 * wins, and it is the only one loaded — `AGENTS.md` is not appended as a
 * fallback, because composition is expressed with `@` imports instead.
 *
 * @returns The resolved file, or `undefined` when none exists.
 */
export async function resolvePrimaryInstruction(
  options: InstructionDiscoveryOptions
): Promise<ResolvedInstructionFile | undefined> {
  const env = getEnv();
  const { rootPath, filenames = INSTRUCTION_FILENAMES, maxBytes = INSTRUCTION_MAX_BYTES } = options;

  for (const filename of filenames) {
    const filePath = env.path.join(rootPath, filename);
    try {
      if (!(await env.fs.exists(filePath))) continue;
      return await resolveFile(filePath, filename, rootPath, maxBytes);
    } catch {
      // Unreadable candidate — fall through to the next one.
      continue;
    }
  }

  return undefined;
}

/**
 * Resolve the sibling override file for a primary instruction file
 * (`AGENTS.md` → `AGENTS.override.md`).
 *
 * Override files are meant to be gitignored personal overrides. Returns
 * `undefined` when absent or unreadable.
 */
export async function resolveOverrideInstruction(
  rootPath: string,
  primaryFilename: string,
  maxBytes: number = INSTRUCTION_MAX_BYTES
): Promise<ResolvedInstructionFile | undefined> {
  const env = getEnv();
  const overrideFilename = overrideFilenameFor(primaryFilename);
  if (overrideFilename === primaryFilename) return undefined;

  const overridePath = env.path.join(rootPath, overrideFilename);
  try {
    if (!(await env.fs.exists(overridePath))) return undefined;
    return await resolveFile(overridePath, overrideFilename, rootPath, maxBytes);
  } catch {
    return undefined;
  }
}

/** Derive the override filename for a primary filename (`AGENTS.md` → `AGENTS.override.md`). */
export function overrideFilenameFor(primaryFilename: string): string {
  const parsed = getEnv().path.parse(primaryFilename);
  return `${parsed.name}.override${parsed.ext}`;
}

/** Read, expand imports in, and truncate a single instruction file. */
async function resolveFile(
  filePath: string,
  name: string,
  rootPath: string,
  maxBytes: number
): Promise<ResolvedInstructionFile> {
  const env = getEnv();
  const raw = await env.fs.readFile(filePath);

  const expanded = await expandInstructionImports(raw, {
    baseDir: env.path.dirname(filePath),
    rootPath,
    maxBytes,
  });

  const truncated = truncateToBudget(expanded.content, maxBytes);
  return {
    path: filePath,
    name,
    content: truncated.content,
    truncated: truncated.truncated,
    importNotices: expanded.notices,
  };
}

/**
 * Truncate to the byte budget, cutting on a line boundary when possible.
 *
 * The budget is in **bytes**, not characters, and the two diverge sharply for
 * non-ASCII text (a Chinese character is 3 bytes, an emoji 4). Slicing at
 * `maxBytes` characters therefore overshoots the budget by up to ~4x, so the
 * largest fitting character prefix is found by binary search instead.
 */
export function truncateToBudget(content: string, maxBytes: number): { content: string; truncated: boolean } {
  const env = getEnv();
  if (env.byteLength(content, "utf-8") <= maxBytes) {
    return { content, truncated: false };
  }

  // Byte length is >= character length, so `maxBytes` characters is an upper bound.
  let low = 0;
  let high = Math.min(maxBytes, content.length);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (env.byteLength(content.slice(0, mid), "utf-8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const lineBreak = content.lastIndexOf("\n", low);
  return { content: content.slice(0, lineBreak > 0 ? lineBreak : low), truncated: true };
}

// ============================================================================
// `@` import expansion
// ============================================================================

/** Options for {@link expandInstructionImports}. */
export interface ExpandImportsOptions {
  /** Directory that relative references resolve against. */
  baseDir: string;
  /** Import targets must resolve inside this directory tree. */
  rootPath: string;
  /** Byte budget used to bound runaway expansion. Defaults to {@link INSTRUCTION_MAX_BYTES}. */
  maxBytes?: number;
  /** Max nesting depth. Defaults to {@link MAX_INSTRUCTION_IMPORT_DEPTH}. */
  maxDepth?: number;
}

/** Mutable per-chain expansion state. */
interface ImportState {
  /** Absolute paths already expanded **on this chain** — the cycle guard. */
  visited: Set<string>;
  depth: number;
  maxDepth: number;
  maxBytes: number;
  /** Bytes accumulated by inlined imports, bounded by `maxBytes`. */
  expandedBytes: number;
  notices: string[];
}

/** Matches an `@`-prefixed, whitespace-delimited token. */
const IMPORT_TOKEN_RE = /@([^\s@]+)/g;

/** A token only counts as an import candidate when it ends in a file extension. */
const FILE_EXTENSION_RE = /\.[A-Za-z0-9]{1,5}$/;

/** Trailing punctuation to peel off a token before treating it as a path. */
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}'"`]+$/;

/**
 * Expand `@path/to/file.md` references into the referenced file's contents.
 *
 * Claude Code semantics, with the guards that keep a recursive reference from
 * running away:
 *
 * - A reference is `@` at the start of a line or after whitespace, followed by a
 *   path. Relative paths resolve against the file that contains the reference,
 *   so a doc can be composed from files beside it or in subdirectories.
 * - References inside fenced code blocks and inline code spans are **not**
 *   expanded — they are usually prose about a file, not a request to inline it.
 * - A token is only a candidate when it ends in a file extension. This is what
 *   keeps npm-style prose (`@codent/app`, `@tanstack/ai`) inert.
 * - A candidate whose target does not exist, escapes `rootPath`, or is a
 *   directory is **not** inlined: the original text is left untouched and a
 *   notice is recorded, so a typo is visible instead of silently dropped.
 * - Expansion stops at `maxDepth` or when the byte budget is exhausted. Both
 *   are reported as notices rather than silently truncated.
 * - A path already expanded on this chain is skipped with a notice. `visited` is
 *   copied per branch, so a file referenced twice in different branches expands
 *   in both, while a genuine cycle (`a.md` → `b.md` → `a.md`) is cut.
 *
 * @returns The expanded content plus diagnostics for anything skipped.
 */
export async function expandInstructionImports(
  content: string,
  options: ExpandImportsOptions
): Promise<{ content: string; notices: string[] }> {
  const state: ImportState = {
    visited: new Set(),
    depth: 0,
    maxDepth: options.maxDepth ?? MAX_INSTRUCTION_IMPORT_DEPTH,
    maxBytes: options.maxBytes ?? INSTRUCTION_MAX_BYTES,
    expandedBytes: 0,
    notices: [],
  };
  return expandWithState(content, options.baseDir, options.rootPath, state);
}

async function expandWithState(
  content: string,
  baseDir: string,
  rootPath: string,
  state: ImportState
): Promise<{ content: string; notices: string[] }> {
  const codeRegions = findCodeRegions(content);
  const parts: string[] = [];
  let cursor = 0;

  IMPORT_TOKEN_RE.lastIndex = 0;
  for (const match of content.matchAll(IMPORT_TOKEN_RE)) {
    const start = match.index;
    const preceding = start === 0 ? "" : content[start - 1];
    if (preceding !== "" && !/\s/.test(preceding)) continue;
    if (isInsideCodeRegion(codeRegions, start)) continue;

    const rawToken = match[1];
    const reference = rawToken.replace(TRAILING_PUNCTUATION_RE, "");
    if (!FILE_EXTENSION_RE.test(reference)) continue;

    const target = await resolveImportTarget(reference, baseDir, rootPath, state);
    if (!target) continue;

    const nested = await readAndExpand(target, rootPath, state);
    if (nested === undefined) continue;

    parts.push(content.slice(cursor, start), nested);
    cursor = start + 1 + reference.length;
  }

  parts.push(content.slice(cursor));
  return { content: parts.join(""), notices: state.notices };
}

/**
 * Resolve, validate, and read an import target, updating expansion state.
 *
 * Returns `undefined` when the reference must stay literal (missing, outside the
 * workspace, a directory, or cut off by a guard) — every such case records a
 * notice except a missing file, which is reported too so typos surface.
 */
async function resolveImportTarget(
  reference: string,
  baseDir: string,
  rootPath: string,
  state: ImportState
): Promise<string | undefined> {
  const env = getEnv();
  const resolved = env.path.resolve(resolveReference(reference, baseDir, rootPath));

  if (!isInside(rootPath, resolved)) {
    state.notices.push(`@${reference} is outside the workspace root and was not imported.`);
    return undefined;
  }

  if (state.visited.has(resolved)) {
    state.notices.push(`@${reference} was already imported on this chain (circular reference) — skipped.`);
    return undefined;
  }

  if (state.depth >= state.maxDepth) {
    state.notices.push(`@${reference} exceeds the maximum import depth (${state.maxDepth}) — not imported.`);
    return undefined;
  }

  if (state.expandedBytes >= state.maxBytes) {
    state.notices.push(
      `@${reference} was not imported: the instruction budget (${state.maxBytes} bytes) is already exhausted.`
    );
    return undefined;
  }

  let stat: { isDirectory: boolean; isFile: boolean };
  try {
    if (!(await env.fs.exists(resolved))) {
      state.notices.push(`@${reference} was not found — left as written.`);
      return undefined;
    }
    stat = await env.fs.stat(resolved);
  } catch {
    state.notices.push(`@${reference} was not found — left as written.`);
    return undefined;
  }

  if (stat.isDirectory) {
    state.notices.push(`@${reference} is a directory, not a file — left as written.`);
    return undefined;
  }

  return resolved;
}

/**
 * Read an import target and expand its own imports, one level deeper.
 *
 * `visited` and `depth` are copied per branch; `expandedBytes` is shared so the
 * budget bounds the whole expansion rather than each branch separately.
 */
async function readAndExpand(target: string, rootPath: string, state: ImportState): Promise<string | undefined> {
  const env = getEnv();
  try {
    const content = await env.fs.readFile(target);
    state.expandedBytes += env.byteLength(content, "utf-8");

    const nested = await expandWithState(content, env.path.dirname(target), rootPath, {
      ...state,
      visited: new Set([...state.visited, target]),
      depth: state.depth + 1,
    });

    const label = env.path.basename(target);
    return `<!-- import: ${label} -->\n${nested.content}\n<!-- end import: ${label} -->`;
  } catch {
    state.notices.push(`@${env.path.basename(target)} could not be read — left as written.`);
    return undefined;
  }
}

/**
 * Resolve a reference to an absolute path.
 *
 * A leading `/` means **project-root-relative**, not filesystem-absolute — the
 * same reading Claude Code gives `@/path`, and the idiom this repo's own
 * `AGENTS.md` uses (`@/openspec/AGENTS.md`). Without this, every such reference
 * would be rejected as outside the workspace.
 */
function resolveReference(reference: string, baseDir: string, rootPath: string): string {
  const env = getEnv();
  if (reference.startsWith("/")) return env.path.join(rootPath, reference.replace(/^\/+/, ""));
  return env.path.isAbsolute(reference) ? reference : env.path.join(baseDir, reference);
}

/** Whether `candidate` is `rootPath` itself or lives beneath it. */
function isInside(rootPath: string, candidate: string): boolean {
  const env = getEnv();
  // Compare in one canonical forward-slash form. The host's `path.resolve` is
  // separator-flavoured — `node:path` on win32 returns `C:\repo` — so a prefix
  // built with a hardcoded `/` never matched and every `@import` was rejected as
  // outside the workspace (the same class of bug `workspaceRelativePath` and the
  // file-URI helpers in this package already normalize away). Canonicalizing is
  // immune to which flavour produced the values.
  const canonical = (p: string) => toPosixPathKey(env.path.resolve(p));
  const root = canonical(rootPath);
  const target = canonical(candidate);
  if (target === root) return true;
  return target.startsWith(`${root}/`);
}

// ============================================================================
// Code-region scanning
// ============================================================================

/**
 * Find fenced code blocks and inline code spans, as `[start, end)` ranges.
 *
 * References inside these are prose about a file rather than an import request,
 * so expansion leaves them alone. A single pass: inside a fence only the matching
 * fence character (of at least the opening length) closes it, and inside an inline
 * span only a backtick of the same length closes it, so ``` does not terminate a
 * ` span or vice versa.
 */
export function findCodeRegions(content: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const isFenceCandidate = char === "`" || char === "~";
    if (!isFenceCandidate) {
      i++;
      continue;
    }

    const runStart = i;
    while (i < content.length && content[i] === char) i++;
    const runLength = i - runStart;

    // A fence must open its own line (only whitespace before it) and be 3+ chars.
    const lineStart = content.lastIndexOf("\n", runStart - 1) + 1;
    const opensLine = content.slice(lineStart, runStart).trim() === "";

    if (runLength >= 3 && opensLine) {
      const closeStart = findClosingFence(content, i, char, runLength);
      if (closeStart === -1) {
        regions.push([runStart, content.length]);
        break;
      }
      let closeEnd = closeStart;
      while (closeEnd < content.length && content[closeEnd] === char) closeEnd++;
      regions.push([runStart, closeEnd]);
      i = closeEnd;
      continue;
    }

    if (char === "`" && !opensLine) {
      const closeAt = findClosingBackticks(content, i, runLength);
      if (closeAt === -1) {
        // Unclosed inline span — treat the rest of the line as code.
        const lineEnd = content.indexOf("\n", runStart);
        regions.push([runStart, lineEnd === -1 ? content.length : lineEnd]);
        break;
      }
      let closeEnd = closeAt;
      while (closeEnd < content.length && content[closeEnd] === "`") closeEnd++;
      regions.push([runStart, closeEnd]);
      i = closeEnd;
      continue;
    }
  }

  return regions;
}

/** Index of the next run of >= `length` fence characters, or -1. */
function findClosingFence(content: string, from: number, char: string, length: number): number {
  let i = from;
  while (i < content.length) {
    if (content[i] === char) {
      const runStart = i;
      while (i < content.length && content[i] === char) i++;
      if (i - runStart >= length) return runStart;
      continue;
    }
    i++;
  }
  return -1;
}

/** Index of the next run of exactly-length backticks, or -1. */
function findClosingBackticks(content: string, from: number, length: number): number {
  let i = from;
  while (i < content.length) {
    if (content[i] === "`") {
      const runStart = i;
      while (i < content.length && content[i] === "`") i++;
      if (i - runStart === length) return runStart;
      continue;
    }
    i++;
  }
  return -1;
}

/** Whether `index` falls inside any code region. */
function isInsideCodeRegion(regions: Array<[number, number]>, index: number): boolean {
  return regions.some(([start, end]) => index >= start && index < end);
}
