/**
 * Synthetic context user messages (epoch-style dynamic context).
 *
 * Persisted in UIMessage history for stability; hidden in the transcript UI.
 * Skipped by the compaction cut-point walk (budget boundaries) so synthetic
 * context never counts toward the kept window.
 *
 * Shell format (one line, then the section payload):
 *   <ctx kind=current_date>
 *   <current_date>
 *   ...
 *   </current_date>
 *   </ctx>
 *
 * Each category (kind) is admitted as its own synthetic message so only the
 * kinds that actually changed get re-injected (per-kind hash admission).
 */

import { extractTextFromContent } from "../compaction/message-utils.js";

import type { ModelMessage, UIMessage } from "@tanstack/ai";

/** Shell prefix identifying a synthetic context message. */
export const CONTEXT_OPEN_PREFIX = "<ctx kind=";
export const CONTEXT_CLOSE = "</ctx>";

// ============================================================================
// Section kinds
// ============================================================================

/**
 * Every turn-context section kind.
 *
 * The kind is a section's identity for per-kind hash admission — it decides which
 * synthetic message is replaced and which payload comparison decides re-injection.
 * It was previously written as a bare literal in three places (the builder, the
 * subagent allowlist, and `project_instructions`), so a rename would compile while
 * silently splitting a kind into two independently-admitted ones.
 *
 * Named rather than a positional array: index access (`KINDS[1]`) would read as
 * nothing and would silently reassign every kind if one were inserted.
 */
export const TURN_CONTEXT_KINDS = {
  currentDate: "current_date",
  gitStatus: "git_status",
  sessionId: "session_id",
  relevantMemories: "relevant_memories",
  reminder: "reminder",
  mode: "mode",
  instructionContext: "instruction_context",
  sessionRetrieval: "session_retrieval",
  backgroundJobs: "background_jobs",
  projectInstructions: "project_instructions",
} as const;

export type TurnContextKind = (typeof TURN_CONTEXT_KINDS)[keyof typeof TURN_CONTEXT_KINDS];

/** FNV-1a 32-bit — stable, dependency-free payload fingerprint. */
export function hashTurnContextPayload(payload: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A single turn-context category rendered with its own semantic tags (e.g.
 * `<git_status>`). Each category is admitted as its own synthetic context user
 * message so only the categories that actually changed get re-admitted.
 */
export interface TurnContextSection {
  /** Stable category key (e.g. `current_date`, `mode`, `git_status`). */
  key: string;
  /** Fully-rendered section content, including its own open/close tags. */
  content: string;
}

function supersedeNotice(kind: string): string {
  return `If earlier <ctx kind=${kind}> blocks appear above in this conversation, ignore them and treat this block as authoritative.`;
}

/**
 * Wrap a single section as its own synthetic context user message.
 *
 * @param isUpdate - When true, include per-kind supersede guidance (an earlier
 *   block of the same kind exists above).
 */
export function formatContextSectionUserContent(section: TurnContextSection, options?: { isUpdate?: boolean }): string {
  const body = options?.isUpdate
    ? `${supersedeNotice(section.key)}\n\n${section.content.trim()}`
    : section.content.trim();
  return `${CONTEXT_OPEN_PREFIX}${section.key}>\n${body}\n${CONTEXT_CLOSE}`;
}

/**
 * Recover the synthetic kind from a stable id.
 *
 * Kind names are arbitrary strings (extension ids can contain `-`), so a
 * `^ctx-([^-]+)-` split is not sufficient. Modern ids are
 * `ctx-<kind>-<8hex>[-<nonce>]`; older persisted ids used a bare numeric nonce.
 */
export function syntheticKindFromId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const modern = /^ctx-(.+)-([0-9a-f]{8})(?:-\d+)?$/.exec(id);
  if (modern) return modern[1];
  const legacy = /^ctx-(.+)-\d+$/.exec(id);
  return legacy?.[1];
}

export function isContextText(text: string | undefined | null): boolean {
  if (!text) return false;
  return text.trimStart().startsWith(CONTEXT_OPEN_PREFIX);
}

/** Extract the kind from a rendered synthetic context message text. */
export function contextKindFromText(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(CONTEXT_OPEN_PREFIX)) return undefined;
  const openEnd = trimmed.indexOf(">");
  if (openEnd < 0) return undefined;
  return trimmed.slice(CONTEXT_OPEN_PREFIX.length, openEnd).trim() || undefined;
}

export function isContextModelMessage(message: ModelMessage): boolean {
  if (message.role !== "user") return false;
  return isContextText(extractTextFromContent(message.content));
}

export function isContextUIMessage(message: UIMessage): boolean {
  if (message.role !== "user") return false;
  const textPart = message.parts.find((part) => part.type === "text");
  if (!textPart || textPart.type !== "text") return false;
  return isContextText(textPart.content);
}

/** Recover a {@link TurnContextSection} (kind + payload) from a rendered message text. */
export function extractContextSection(text: string): TurnContextSection | undefined {
  const kind = contextKindFromText(text);
  if (!kind) return undefined;
  const trimmed = text.trimStart();
  const openEnd = trimmed.indexOf(">");
  const close = trimmed.lastIndexOf(CONTEXT_CLOSE);
  if (close < openEnd) return undefined;
  let inner = trimmed.slice(openEnd + 1, close).trim();
  const notice = supersedeNotice(kind);
  if (inner.startsWith(notice)) {
    inner = inner.slice(notice.length).trim();
  }
  return inner ? { key: kind, content: inner } : undefined;
}

/** Per-kind hash of a rendered section (stable across identical content). */
export function hashTurnContextSection(section: TurnContextSection): string {
  return hashTurnContextPayload(section.content);
}

/**
 * Scan messages for the latest admitted hash per section kind (restore seeding).
 * Walks newest-first so the most recent occurrence of each kind wins.
 */
export function findLatestTurnContextSectionHashes(messages: UIMessage[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isContextUIMessage(message)) continue;
    const textPart = message.parts.find((part) => part.type === "text");
    if (!textPart || textPart.type !== "text") continue;
    const section = extractContextSection(textPart.content);
    if (!section) continue;
    if (!latest.has(section.key)) {
      latest.set(section.key, hashTurnContextSection(section));
    }
  }
  return latest;
}

/**
 * Seed the admitted hashes from the **model-visible wire**, not the durable UI channel.
 *
 * Compaction appends a SUMMARY and leaves the pre-cut channel rows intact, so seeding from the
 * channel after `resetAdmittedTurnContext()` would find the old `<ctx>` rows and suppress the
 * re-injection the reset was meant to force. The wire is the only view where a cut is real.
 */
export function findLatestTurnContextSectionHashesFromWire(messages: readonly ModelMessage[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isContextModelMessage(message)) continue;
    const section = extractContextSection(extractTextFromContent(message.content));
    if (!section) continue;
    if (!latest.has(section.key)) {
      latest.set(section.key, hashTurnContextSection(section));
    }
  }
  return latest;
}
