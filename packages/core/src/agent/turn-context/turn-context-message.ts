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

import { extractTextFromContent } from "../../utils/message-content.js";
import { isCompactionSummaryText } from "../compaction/summary-marker.js";

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
   * Subagent step-budget warning (once, at 80% of the run's iteration budget).
   * Its own kind so it is never confused with a hash-admitted section that should update.
   */
  stepBudget: "step_budget",
  /**
   * Background-result push: a completed background command job's notification.
   * Appended once per completion (not hash-admitted); background *tasks* use the
   * same class when they land.
   */
  backgroundNotification: "background_notification",
  /**
   * Wire-only repair instruction for a `max_tokens` truncation (never persisted).
   *
   * It is a synthetic user message, not a prompt the user wrote: wrapping it in the shell is
   * what keeps the repeat scan from treating it as a turn boundary and switching the loop
   * detector off for the rest of the run.
   */
  continuationPrompt: "continuation_prompt",
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
  /**
   * Set when this section supersedes an earlier block, with the name printed in the notice.
   *
   * The notice tells the model to ignore earlier blocks of that name. A hash-admitted
   * section names its kind (the middleware passes the flag instead); a counter reminder
   * names its **inner tag**, because the two reminders share one kind and a nag must never
   * tell the model to ignore a loop nudge.
   *
   * Presence means "an earlier block of this slot exists"; `formatContextSectionUserContent`
   * uses it as the default for `isUpdate`.
   */
  supersedes?: string;
}

/**
 * Inner tag names for the shared `reminder` kind.
 *
 * The `<ctx kind=...>` envelope identifies the admission class; the inner tag names the
 * section itself. The two condition+counter reminders share one kind, so this tag is what
 * tells them apart — both for admission and for counter recovery.
 */
export const REMINDER_TAGS = {
  todo: "todo-reminder",
  repeat: "repeat-reminder",
} as const;

/**
 * Render a section body inside its own semantic tag (`<current_date>…</current_date>`).
 *
 * One renderer for every section: the inner tag is the section's identity, so a hand-written
 * `<foo>` in a builder is a bug (it would not match what recovery reads back).
 */
export function formatSectionTag(tag: string, body: string | readonly string[]): string {
  const lines = typeof body === "string" ? [body] : body;
  return [`<${tag}>`, ...lines, `</${tag}>`].join("\n");
}

/** The first semantic tag of a rendered section body (`<todo-reminder …>` → `todo-reminder`). */
export function sectionTagOf(content: string): string | undefined {
  const match = /^<([A-Za-z][\w-]*)(?:\s[^>]*)?>/.exec(content.trimStart());
  return match?.[1];
}

/** The notice text: ignore earlier blocks of the same slot, this one is authoritative. */
function supersedeNotice(name: string): string {
  return `If earlier <${name}> blocks appear above in this conversation, ignore them and treat this block as authoritative.`;
}

/**
 * The notice this module writes, as a prefix stripper.
 *
 * Generic on purpose: the name is the section's own slot (`<ctx kind=current_date>` for a
 * hash-admitted section, `<todo-reminder>` for a counter reminder), so recovery must strip
 * whatever was rendered without knowing which one it was.
 */
const SUPERSEDE_PREFIX =
  /^If earlier <[^>]+> blocks appear above in this conversation, ignore them and treat this block as authoritative\.\n\n/;

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
export function formatContextSectionUserContent(
  section: TurnContextSection,
  options?: { isUpdate?: boolean; supersedes?: string }
): string {
  const isUpdate = options?.isUpdate ?? section.supersedes !== undefined;
  // The notice names the slot the model should supersede. A hash-admitted section passes
  // `isUpdate` and names its kind; a reminder names its inner tag, so a nag can never point
  // at a repeat nudge that shares the `reminder` kind.
  const name = options?.supersedes ?? section.supersedes ?? section.key;
  const body = isUpdate ? `${supersedeNotice(name)}\n\n${section.content.trim()}` : section.content.trim();
  return `${CONTEXT_OPEN_PREFIX}${section.key}${renderContextAttributes(section.attrs)}>\n${body}\n${CONTEXT_CLOSE}`;
}

/**
 * Recover the synthetic kind from a stable id.
 *
 * Kind names are arbitrary strings (extension ids can contain `-`), so a
 * `^ctx-([^-]+)-` split is not sufficient. Ids are `ctx-<kind>-<8hex>[-<nonce>]`
 * (`syntheticMessageId`), and nothing else is recognized: an id this does not match was not
 * written by the current shell and carries no kind.
 */
export function syntheticKindFromId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const match = /^ctx-(.+)-([0-9a-f]{8})(?:-\d+)?$/.exec(id);
  return match?.[1];
}

export function isContextText(text: string | undefined | null): boolean {
  if (!text) return false;
  return text.trimStart().startsWith(CONTEXT_OPEN_PREFIX);
}

/** Parsed `<ctx kind=… attr="…">body</ctx>` shell. `body` is absent when the close tag is missing. */
interface ParsedContextShell {
  kind: string;
  attrs: Record<string, string>;
  body?: string;
}

/**
 * Parse the synthetic `<ctx …>` shell once.
 *
 * The kind, the machine-readable attrs and the body were each extracted by their own scan of the
 * same envelope (three `indexOf(">")` / `matchAll` implementations in this file). Admission and
 * counter recovery both read the result back, so a shell syntax change has one parser to update.
 */
function parseContextShell(text: string | undefined | null): ParsedContextShell | undefined {
  if (!text) return undefined;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(CONTEXT_OPEN_PREFIX)) return undefined;
  const openEnd = trimmed.indexOf(">");
  if (openEnd < 0) return undefined;

  // `<ctx kind=<kind>[ attr="value" ...]>`: the kind is the first whitespace-delimited token, so
  // shell attrs never leak into the identity.
  const open = trimmed.slice(CONTEXT_OPEN_PREFIX.length, openEnd).trim();
  const kind = open.split(/\s+/)[0];
  if (!kind) return undefined;

  const attrs: Record<string, string> = {};
  const attributePattern = /([A-Za-z_][\w-]*)="([^"]*)"/g;
  for (const match of open.matchAll(attributePattern)) {
    attrs[match[1]!] = match[2]!.replace(/&quot;/g, '"');
  }

  const close = trimmed.lastIndexOf(CONTEXT_CLOSE);
  return {
    kind,
    attrs,
    ...(close >= openEnd ? { body: trimmed.slice(openEnd + 1, close).trim() } : {}),
  };
}

/** Extract the kind from a rendered synthetic context message text. */
export function contextKindFromText(text: string | undefined | null): string | undefined {
  return parseContextShell(text)?.kind;
}

/**
 * Read the machine-readable attrs from a synthetic context message's `<ctx ...>` shell.
 *
 * {@link TurnContextSection.attrs} is state a counter-based section writes for its own
 * later recovery (nag rounds, repeat count). A malformed / attr-less shell yields `{}`.
 */
export function contextAttributesFromText(text: string | undefined | null): Record<string, string> {
  return parseContextShell(text)?.attrs ?? {};
}

export function isContextModelMessage(message: ModelMessage): boolean {
  if (message.role !== "user") return false;
  return isContextText(extractTextFromContent(message.content));
}

/**
 * A real user prompt (not a synthetic `<ctx ...>` injection).
 *
 * The one classifier for "the user said something": the repeat chain ends at it and the todo
 * nag anchors its no-cycle fallback on it.
 */
export function isGenuineUserMessage(message: ModelMessage): boolean {
  return message.role === "user" && !isContextModelMessage(message);
}

export function isContextUIMessage(message: UIMessage): boolean {
  if (message.role !== "user") return false;
  const textPart = message.parts.find((part) => part.type === "text");
  if (!textPart || textPart.type !== "text") return false;
  return isContextText(textPart.content);
}

/**
 * The text of the newest real user message in a transcript, or `undefined` when there is none.
 *
 * Exists because a run started from `messages` (a resume, a queued send, a wake) has no `prompt`
 * string — and the two consumers of that string, `prompt:submit` and `before_agent_start`, were
 * handed the literal placeholder `"(structured)"`. Every recorded prompt row then claimed a 12-byte
 * prompt, and an extension hook that reads the user's ask got the placeholder instead of the ask.
 *
 * Synthetic `<ctx …>` messages are skipped: they are not the user, and reporting them as the prompt
 * would be the same misattribution one layer deeper.
 */
export function lastGenuineUserText(messages: readonly UIMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "user" || isContextUIMessage(message)) continue;
    const text = message.parts
      .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
      .map((part) => part.content)
      .join("\n")
      .trim();
    // A compaction summary is a `user` message too (`[CONVERSATION SUMMARY]`). Reporting it as the
    // prompt sent the whole summary to `before_agent_start` (and paid for a memory side query) on
    // a transcript whose newest message happens to be the summary.
    if (text && !isCompactionSummaryText(text)) return text;
  }
  return undefined;
}

/**
 * Recover a {@link TurnContextSection} (kind + payload + shell attrs) from rendered text.
 *
 * The body is trimmed and the optional supersede notice is stripped, so a section read back
 * from a message compares byte-identically with the section that would be built now — that
 * round-trip is what makes admission stateless (no remembered hash map).
 */
export function extractContextSection(text: string): TurnContextSection | undefined {
  const shell = parseContextShell(text);
  if (!shell || shell.body === undefined) return undefined;
  const inner = shell.body.replace(SUPERSEDE_PREFIX, "").trim();
  if (!inner) return undefined;
  return Object.keys(shell.attrs).length > 0
    ? { key: shell.kind, content: inner, attrs: shell.attrs }
    : { key: shell.kind, content: inner };
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
 * Keyed by section kind — the admission slot for hash-admitted sections. The two
 * condition+counter reminders share the `reminder` kind but never come through here: their
 * middlewares recover by (inner tag, scope) with `findCounterReminder`, so one reminder can
 * never mask the other.
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
