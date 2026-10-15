/**
 * Agent Documentation Loader (AGENTS.md / CLAUDE.md)
 *
 * Loads the project's instruction file and injects it into the agent's system
 * prompt as `<project_instructions>`.
 *
 * This follows the cross-tool standard established by AGENTS.md (stewarded by
 * the Linux Foundation's Agentic AI Foundation) and is compatible with how
 * Claude Code, Codex CLI, Cursor, Gemini CLI, and other tools discover and load
 * project instructions.
 *
 * Discovery and `@` import expansion live in
 * {@link import("./instruction-files.js")} — the same module the turn-context
 * change detector uses, so what is loaded here and what is re-injected later
 * cannot disagree.
 *
 * @see https://agents.md/
 */

import { getEnv, type ResolvedCoreEnv } from "../../env";

import {
  INSTRUCTION_FILENAMES,
  INSTRUCTION_MAX_BYTES,
  resolveOverrideInstruction,
  resolvePrimaryInstruction,
  type InstructionDiscoveryOptions,
  type ResolvedInstructionFile,
} from "./instruction-files.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Default filenames to search for, in priority order.
 *
 * Re-exported from the shared discovery module so the loader and the
 * turn-context path cannot drift apart.
 */
export const DEFAULT_AGENT_DOC_FILENAMES = INSTRUCTION_FILENAMES;

/** Default maximum bytes per file after import expansion (65536 = 64 KiB). */
export const DEFAULT_AGENT_DOC_MAX_BYTES = INSTRUCTION_MAX_BYTES;

export { INSTRUCTION_FILENAMES, INSTRUCTION_MAX_BYTES };

// ============================================================================
// Types
// ============================================================================

/** Configuration for the agent documentation loader */
export type AgentDocLoaderConfig = InstructionDiscoveryOptions & {
  /**
   * Whether to also look for a local override file.
   * For AGENTS.md, this would be AGENTS.override.md (gitignored, personal overrides).
   * Default: true
   */
  loadOverride?: boolean;
};

/** Result of loading agent documentation */
export interface AgentDocLoadResult {
  /** The loaded content (empty string if no file was found) */
  content: string;
  /** Which file was loaded (e.g., "/project/AGENTS.md") */
  source?: string;
  /** Override content if an override file was also found (e.g., AGENTS.override.md) */
  overrideContent?: string;
  /** Which override file was loaded */
  overrideSource?: string;
  /**
   * Informational notice about the loading process
   * (e.g., which files were searched, errors encountered).
   */
  notice?: string;
  /**
   * Diagnostics from `@` import expansion (missing target, circular reference,
   * depth or budget stop). Empty when no imports needed expanding.
   */
  importNotices: string[];
  /**
   * Candidates that existed but could not be read, with the error.
   *
   * Distinct from "not found": these are host failures (a refusing client, a sandbox, a broken
   * mount) and they are why a workspace with an `AGENTS.md` can still come up without
   * instructions. Callers should surface them rather than let the absence look intentional.
   */
  readErrors?: Array<{ path: string; error: unknown }>;
}

/**
 * Human-readable description of what was loaded.
 * Returns a formatted string like "Loaded instructions from AGENTS.md (2.1 KB)"
 */
export function formatAgentDocResult(result: AgentDocLoadResult, env?: ResolvedCoreEnv): string {
  const e = env ?? getEnv();
  const parts: string[] = [];

  if (result.source) {
    const sizeKB = (e.byteLength(result.content, "utf-8") / 1024).toFixed(1);
    parts.push(`Loaded instructions from ${e.path.basename(result.source)} (${sizeKB} KB)`);
  }

  if (result.overrideSource && result.overrideContent != null) {
    const sizeKB = (e.byteLength(result.overrideContent, "utf-8") / 1024).toFixed(1);
    parts.push(`Loaded override from ${e.path.basename(result.overrideSource)} (${sizeKB} KB)`);
  }

  if (result.importNotices.length > 0) {
    parts.push(`${result.importNotices.length} import notice(s)`);
  }

  return parts.join("; ") || "No agent documentation files found";
}

// ============================================================================
// Main Loader Functions
// ============================================================================

/**
 * Search for and load the project's instruction file.
 *
 * The first existing file in `filenames` order wins and is the only one loaded —
 * `AGENTS.md` is not appended as a fallback. A project that keeps `CLAUDE.md` as
 * a pointer to `AGENTS.md` writes `@AGENTS.md` in it (Claude Code's import
 * syntax), which the shared resolver inlines during the load.
 *
 * @param config - Loader configuration
 * @returns The loaded content and metadata
 *
 * @example
 * ```typescript
 * const result = await loadAgentDoc({ rootPath: "/project" });
 * // result.content contains CLAUDE.md (with imports expanded) or AGENTS.md
 * ```
 */
export async function loadAgentDoc(config: AgentDocLoaderConfig): Promise<AgentDocLoadResult> {
  const { rootPath, filenames = DEFAULT_AGENT_DOC_FILENAMES, maxBytes, loadOverride = true, env } = config;

  // Collect read failures so "the file exists but could not be read" is never reported as "there is
  // no file" — the two are indistinguishable to a user without this.
  const readErrors: Array<{ path: string; error: unknown }> = [];
  const onReadError = (path: string, error: unknown): void => {
    readErrors.push({ path, error });
    config.onReadError?.(path, error);
  };

  const primary = await resolvePrimaryInstruction({
    rootPath,
    filenames,
    maxBytes,
    ...(env ? { env } : {}),
    onReadError,
  });
  if (!primary) {
    // Say which of the two things happened. "Not found" is a fact about the project; a failed read
    // is a fact about the host (a refusing client, a sandbox, a broken mount), and reporting the
    // second as the first tells the user their project has no AGENTS.md when it plainly does.
    const notice = readErrors.length
      ? `No agent documentation could be READ (${readErrors.map((r) => r.path).join(", ")}); ` +
        `the file(s) exist but every read failed`
      : `No agent documentation file found (searched: ${filenames.join(", ")})`;
    return {
      content: "",
      notice,
      importNotices: [],
      ...(readErrors.length ? { readErrors } : {}),
    };
  }

  const result: AgentDocLoadResult = {
    content: primary.content,
    source: primary.path,
    importNotices: [...primary.importNotices],
  };

  if (loadOverride) {
    const override = await resolveOverrideInstruction(
      rootPath,
      primary.name,
      maxBytes ?? DEFAULT_AGENT_DOC_MAX_BYTES,
      env
    );
    if (override) {
      result.overrideContent = override.content;
      result.overrideSource = override.path;
      result.importNotices.push(...override.importNotices);
    }
  }

  return result;
}

/** Exposed for callers that need the resolved (rather than concatenated) shape. */
export type { ResolvedInstructionFile };
