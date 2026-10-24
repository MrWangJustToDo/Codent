/**
 * Synthetic context user messages (epoch-style dynamic context).
 *
 * Persisted in UIMessage history for stability; hidden in the transcript UI.
 * Never chosen as a compaction cut boundary (it is counted in the token budget, but
 * `findCutPointByBudget` will not start the kept window on a synthetic block).
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
 *
 * Admission is **stateless**: the latest block of each kind is read back from the
 * model-visible wire (see {@link findLatestContextSectionsFromWire}) on every check, so
 * compaction, restore and session switches need no remembered hash table or reset path.
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
  /**
   * Condition + counter reminder (todo nag, repeat-call nudge).
   *
   * Both use this ONE kind: the counter state and its scope live in shell attrs, so a
   * block is identified by `(kind, scope)` rather than by a distinct tag. The todo nag
   * writes `cycle`/`rounds`, the repeat nudge writes `chain`/`count`; `episode` counts
   * admissions within the scope.
   */
  reminder: "reminder",
  mode: "mode",
  instructionContext: "instruction_context",
  sessionRetrieval: "session_retrieval",
  backgroundJobs: "background_jobs",
  projectInstructions: "project_instructions",
  /**
   * Background-result push: a completed background command job's notification.
   * Appended once per completion (not hash-admitted); background *tasks* use the
   * same class when they land.
   */
  backgroundNotification: "background_notification",
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
  /**
   * Optional machine-readable state rendered on the `<ctx ...>` shell.
   *
   * This is how a counter-based section (nag rounds, repeat counts) stays
   * recoverable from the message itself: the admission comparison hashes
   * {@link content} only, while the attrs carry the state a later `onConfig`
   * reads back to decide whether to re-inject.
   *
   * Convention: the scope attrs (`cycle`, `chain`, …) identify which counter the block
   * belongs to, and `episode` counts admissions within that scope. Two different
   * reminders therefore share a kind without colliding — each recovery filters by its own
   * scope attr, and a supersede notice is only added when the prior block matches.
   */
  attrs?: Record<string, string>;
}

function supersedeNotice(kind: string): string {
  return `If earlier <ctx kind=${kind}> blocks appear above in this conversation, ignore them and treat this block as authoritative.`;
}

/** Render `attrs` as `name="value"` on the `<ctx ...>` open tag. */
function renderContextAttributes(attrs: Record<string, string> | undefined): string {
  if (!attrs) return "";
  const rendered: string[] = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (!name || value === undefined || value === null || value === "") continue;
    rendered.push(`${name}="${String(value).replace(/"/g, "&quot;")}"`);
  }
  return rendered.length > 0 ? ` ${rendered.join(" ")}` : "";
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
  return `${CONTEXT_OPEN_PREFIX}${section.key}${renderContextAttributes(section.attrs)}>\n${body}\n${CONTEXT_CLOSE}`;
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
  // The open tag is `<ctx kind=<kind>[ attr="value" ...]>`: the kind is the first
  // whitespace-delimited token, so shell attrs never leak into the identity.
  const rest = trimmed.slice(CONTEXT_OPEN_PREFIX.length, openEnd).trim();
  return rest.split(/\s+/)[0] || undefined;
}

/**
 * Read the machine-readable attrs from a synthetic context message's `<ctx ...>` shell.
 *
 * {@link TurnContextSection.attrs} is state a counter-based section writes for its own
 * later recovery (nag rounds, repeat count). A malformed / attr-less shell yields `{}`.
 */
export function contextAttributesFromText(text: string | undefined | null): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!text) return attrs;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(CONTEXT_OPEN_PREFIX)) return attrs;
  const openEnd = trimmed.indexOf(">");
  if (openEnd < 0) return attrs;
  const rest = trimmed.slice(CONTEXT_OPEN_PREFIX.length, openEnd);
  const attributePattern = /([A-Za-z_][\w-]*)="([^"]*)"/g;
  for (const match of rest.matchAll(attributePattern)) {
    attrs[match[1]!] = match[2]!.replace(/&quot;/g, '"');
  }
  return attrs;
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

/**
 * Recover a {@link TurnContextSection} (kind + payload + shell attrs) from rendered text.
 *
 * The body is trimmed and the optional supersede notice is stripped, so a section read back
 * from a message compares byte-identically with the section that would be built now — that
 * round-trip is what makes admission stateless (no remembered hash map).
 */
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
  if (!inner) return undefined;
  const attrs = contextAttributesFromText(trimmed);
  return Object.keys(attrs).length > 0 ? { key: kind, content: inner, attrs } : { key: kind, content: inner };
}

/**
 * Per-kind hash of a rendered section (stable across identical content).
 *
 * Hashes the canonical (trimmed) body — the same normalization
 * {@link extractContextSection} applies — so a section compared against its own
 * re-extracted copy from the wire always agrees.
 */
export function hashTurnContextSection(section: TurnContextSection): string {
  return hashTurnContextPayload(section.content.trim());
}

/**
 * Latest admitted section per kind from the **model-visible wire** — the one admission input.
 *
 * Every injecting middleware runs the same two steps: read the newest block of each kind from
 * the post-compaction window, compare it with what it would inject now, inject only the
 * difference. Nothing is remembered between calls, so compaction / restore / session switch
 * need no reset plumbing: a cut that dropped a block leaves no entry (it re-injects), and a
 * block that survived keeps suppressing it.
 *
 * Walks newest-first. `keys`, when given, stops the scan as soon as every wanted kind has been
 * found (the common case: the injected blocks sit near the tail).
 */
export function findLatestContextSectionsFromWire(
  messages: readonly ModelMessage[],
  keys?: ReadonlySet<string>
): Map<string, TurnContextSection> {
  const latest = new Map<string, TurnContextSection>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || !isContextModelMessage(message)) continue;
    const section = extractContextSection(extractTextFromContent(message.content));
    if (!section) continue;
    if (keys && !keys.has(section.key)) continue;
    if (!latest.has(section.key)) {
      latest.set(section.key, section);
      if (keys && latest.size === keys.size) break;
    }
  }
  return latest;
}

/** Latest admitted section hash per kind from the model-visible wire. */
export function findLatestTurnContextSectionHashesFromWire(
  messages: readonly ModelMessage[],
  keys?: ReadonlySet<string>
): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const [key, section] of findLatestContextSectionsFromWire(messages, keys)) {
    hashes.set(key, hashTurnContextSection(section));
  }
  return hashes;
}
