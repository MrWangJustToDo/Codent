/**
 * Instruction-context detection and formatting for dynamic turn context.
 *
 * The agent documentation (AGENTS.md / CLAUDE.md) is loaded once at agent
 * creation and frozen into the system prompt's `<project_instructions>`. If the
 * model edits those files via tools, the frozen prompt keeps stale instructions
 * until the session restarts. This module detects such changes so the synthetic
 * ctx messages can re-inject the latest instruction content.
 *
 * Discovery and `@` import expansion come from the shared module
 * ({@link import("../prompt/instruction-files.js")}), the same one the loader
 * uses. That matters for correctness, not just tidiness: the digest below covers
 * the **expanded** text, so editing a file pulled in through `@` is detected like
 * any other edit. Hashing raw bytes would miss it and leave the stale
 * `<project_instructions>` in place for the rest of the session.
 *
 * Cache-friendly design: we only re-inject when the instruction file digest
 * changed since the last admit (hash-driven, same epoch pattern as
 * synthetic ctx injection itself). When nothing changed, the payload is
 * byte-identical and the prompt-cache breakpoint stays stable.
 */

import { getEnv } from "../../env";
import {
  INSTRUCTION_FILENAMES,
  INSTRUCTION_MAX_BYTES,
  resolveOverrideInstruction,
  resolvePrimaryInstruction,
  type ResolvedInstructionFile,
} from "../prompt/instruction-files.js";

import { hashTurnContextPayload } from "./turn-context-message.js";

// ============================================================================
// Types
// ============================================================================

/** A discovered instruction file (primary or override). */
export interface InstructionFile {
  /** Absolute path to the instruction file. */
  path: string;
  /** Base filename (AGENTS.md, CLAUDE.md, AGENTS.override.md). */
  name: string;
  /** FNV-1a digest of the instruction content. */
  digest: string;
}

/** Latest instruction state used for change detection. */
export interface InstructionContextState {
  /** Primary instruction file (AGENTS.md / CLAUDE.md) — undefined when none. */
  primary: InstructionFile | undefined;
  /** Override instruction file (e.g. AGENTS.override.md) — undefined when none. */
  override: InstructionFile | undefined;
}

/** Resolved instruction content handed to the turn-context formatter. */
export interface LoadedInstructionContent {
  primary: { name: string; content: string; truncated: boolean; importNotices: string[] } | undefined;
  override: { name: string; content: string; truncated: boolean; importNotices: string[] } | undefined;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Instruction filenames in discovery priority order.
 *
 * Re-exported from the shared discovery module so this path and the loader
 * cannot drift apart.
 */
export { INSTRUCTION_FILENAMES, INSTRUCTION_MAX_BYTES };

/** Marker describing the instruction context section. */
const INSTRUCTION_CONTEXT_OPEN = "<instruction_context>";
const INSTRUCTION_CONTEXT_CLOSE = "</instruction_context>";

// ============================================================================
// Discovery & hashing
// ============================================================================

/**
 * Read the current instruction file state (paths + digests only — content is
 * not retained in memory to avoid keeping large file bodies around).
 *
 * Discovery mirrors the agent-doc loader: the first existing file in
 * {@link INSTRUCTION_FILENAMES} order wins, and a sibling override file
 * (e.g. `AGENTS.override.md`) is loaded when present. Digests cover the
 * **import-expanded** content, so a change to an `@`-referenced file counts as a
 * change to the instruction file that references it.
 *
 * @returns The discovered instruction state (empty files when none found).
 */
export async function readInstructionContextState(): Promise<InstructionContextState> {
  const env = getEnv();
  const rootPath = env.rootPath;

  const primary = await resolvePrimaryInstruction({ rootPath });
  if (!primary) return { primary: undefined, override: undefined };

  const override = await resolveOverrideInstruction(rootPath, primary.name);

  return {
    primary: { path: primary.path, name: primary.name, digest: digestResolved(primary) },
    override: override ? { path: override.path, name: override.name, digest: digestResolved(override) } : undefined,
  };
}

/** Hash an instruction file's expanded content. */
function digestResolved(file: ResolvedInstructionFile): string {
  // The notices are part of what the model sees, so they must be part of what
  // we compare: a target that appears (or a cycle that is broken) is a change.
  const shape = [file.content, ...file.importNotices].join("\n--notice--\n");
  return hashTurnContextPayload(`instruction\n${shape}`);
}

// ============================================================================
// Comparison
// ============================================================================

/** Compare two instruction states and report which files changed. */
export function diffInstructionStates(
  before: InstructionContextState | undefined,
  after: InstructionContextState
): { primaryChanged: boolean; overrideChanged: boolean } {
  const primaryChanged = before?.primary?.digest !== after.primary?.digest;
  const overrideChanged = before?.override?.digest !== after.override?.digest;
  return { primaryChanged, overrideChanged };
}

/** Whether any instruction file digest differs between two states. */
export function instructionStateChanged(
  before: InstructionContextState | undefined,
  after: InstructionContextState
): boolean {
  const diff = diffInstructionStates(before, after);
  return diff.primaryChanged || diff.overrideChanged;
}

// ============================================================================
// Content loading & formatting
// ============================================================================

/**
 * Load the latest instruction content (full text) for re-injection.
 *
 * Called only when a change was detected — re-reads the primary (and override)
 * file and returns their current, import-expanded text. Content is intentionally
 * not retained on the state object; it is fetched on demand at injection time.
 */
export async function loadLatestInstructionContent(): Promise<LoadedInstructionContent> {
  const env = getEnv();
  const rootPath = env.rootPath;

  const primary = await resolvePrimaryInstruction({ rootPath });
  if (!primary) return { primary: undefined, override: undefined };

  const override = await resolveOverrideInstruction(rootPath, primary.name);

  return {
    primary: toLoaded(primary, primary.name),
    override: override ? toLoaded(override, override.name) : undefined,
  };
}

function toLoaded(
  file: ResolvedInstructionFile,
  name: string
): { name: string; content: string; truncated: boolean; importNotices: string[] } {
  return { name, content: file.content, truncated: file.truncated, importNotices: file.importNotices };
}

/**
 * Render the `<instruction_context>` section with the latest instruction
 * content and a supersede notice that replaces any stale `<project_instructions>`.
 *
 * @param loaded - Latest instruction content (from {@link loadLatestInstructionContent}).
 * @returns The rendered section, or undefined when no instruction files exist.
 */
export function formatInstructionContextSection(loaded: LoadedInstructionContent): string | undefined {
  if (!loaded.primary) return undefined;

  const parts: string[] = [];
  parts.push(
    "The project instruction files below changed since they were loaded into " +
      "<project_instructions> in the system prompt. Treat this block as authoritative " +
      "and ignore the older <project_instructions> content."
  );

  if (loaded.primary.truncated) {
    parts.push(
      `NOTE: ${loaded.primary.name} exceeds the ${INSTRUCTION_MAX_BYTES}-byte instruction budget and was truncated.`
    );
  }
  parts.push(...formatImportNotices(loaded.primary.name, loaded.primary.importNotices));
  parts.push(`# ${loaded.primary.name}`);
  parts.push(loaded.primary.content);

  if (loaded.override) {
    if (loaded.override.truncated) {
      parts.push(
        `NOTE: ${loaded.override.name} exceeds the ${INSTRUCTION_MAX_BYTES}-byte instruction budget and was truncated.`
      );
    }
    parts.push(...formatImportNotices(loaded.override.name, loaded.override.importNotices));
    parts.push(`## Local Override (${loaded.override.name})`);
    parts.push(loaded.override.content);
  }

  return [INSTRUCTION_CONTEXT_OPEN, ...parts, INSTRUCTION_CONTEXT_CLOSE].join("\n");
}

/** Render `@` import diagnostics so a broken reference is visible, not silent. */
function formatImportNotices(name: string, notices: string[] | undefined): string[] {
  if (!notices || notices.length === 0) return [];
  return [`NOTE: ${name} has unresolved @ imports:`, ...notices.map((notice) => `- ${notice}`)];
}
