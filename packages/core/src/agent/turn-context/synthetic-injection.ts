/**
 * Shared synthetic-message injection used by context middleware (turn-context)
 * and background. One code path for: channel persistence (dedup by
 * stable content-hash id) + wire-message injection (appended to the tail so the
 * wire payload stays byte-identical to the next channel projection — prefix-cache
 * stability).
 *
 * Channel writes delegate to {@link appendChannelMessages} (agent/ui/channel-write.ts)
 * — the single safe channel-append entry shared with compaction. This module only
 * adds the wire-side mirror + stable content-hash id derivation.
 */

import { appendChannelMessages } from "../ui/channel-write.js";

import {
  findLatestContextSectionsFromWire,
  hashTurnContextSection,
  hashTurnContextPayload,
  syntheticKindFromId,
} from "./turn-context-message.js";

import type { TurnContextSection } from "./turn-context-message.js";
import type { AgentUIChannel } from "../ui/ui-channel.js";
import type { ModelMessage, UIMessage } from "@tanstack/ai";

export interface SyntheticMessageEntry {
  /** Stable category key (also encoded in the message id for readability). */
  kind: string;
  /** Fully rendered message content (including the `<ctx kind=...>` shell). */
  content: string;
  /** Optional admission episode. When set, the id becomes `ctx-<kind>-<hash>-<nonce>`
   *  so recurring / cyclic state (mode re-entry, nag reminders) re-injects even
   *  when the content is byte-identical to a historical message. */
  nonce?: number;
}

export interface SyntheticInjectionDeps {
  ui: AgentUIChannel;
  /** Persist the updated UI messages (no-op for subagents without a session store). */
  persist: (next: UIMessage[]) => void;
}

export interface SyntheticInjectionResult {
  /** Contents actually injected this call (empty when nothing changed). */
  injected: string[];
  /** The wire to use — a new array when anything was injected, else the input. */
  messages: ModelMessage[];
}

/** Stable id for a synthetic context message (content-hash dedupe across restores). */
export function syntheticMessageId(entry: SyntheticMessageEntry): string {
  const hash = hashTurnContextPayload(entry.content);
  return entry.nonce === undefined ? `ctx-${entry.kind}-${hash}` : `ctx-${entry.kind}-${hash}-${entry.nonce}`;
}

/**
 * Next admission episode per synthetic kind, in one pass over the channel.
 *
 * Counting the ids already on the channel makes every admission's id unique even when its
 * content repeats (a reminder re-admitted after a compaction cut, a state cycle back to the
 * same text), so the content-hash dedupe cannot swallow a legitimate re-injection.
 */
export function nextSyntheticNonces(messages: readonly UIMessage[], kinds: Iterable<string>): Map<string, number> {
  const wanted = new Set(kinds);
  const counts = new Map<string, number>();
  for (const message of messages) {
    const kind = syntheticKindFromId(message.id);
    if (kind !== undefined && wanted.has(kind)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  for (const kind of wanted) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return counts;
}

/** Next admission episode for a single kind. */
export function nextSyntheticNonce(messages: readonly UIMessage[], kind: string): number {
  return nextSyntheticNonces(messages, [kind]).get(kind)!;
}

/** A section the wire does not already carry, with the notice it needs. */
export interface AdmittedSection {
  section: TurnContextSection;
  /** Render with the supersede notice (an earlier block of the same kind exists). */
  isUpdate: boolean;
}

/**
 * The hash-admission rule, in one place: a section is due when the wire has no block of its
 * kind, or the newest one differs.
 *
 * Both the turn-context middleware (a batch of sections) and the background middleware (its
 * `<background_jobs>` pointer) call this — the rule must not be written twice, or a change to
 * the notice/identity comparison lands on one side only.
 */
export function selectChangedSections(
  messages: readonly ModelMessage[],
  sections: readonly TurnContextSection[]
): AdmittedSection[] {
  if (sections.length === 0) return [];
  const latest = findLatestContextSectionsFromWire(messages, new Set(sections.map((section) => section.key)));
  const changed: AdmittedSection[] = [];
  for (const section of sections) {
    const prior = latest.get(section.key);
    if (prior && hashTurnContextSection(prior) === hashTurnContextSection(section)) continue;
    changed.push({ section, isUpdate: prior !== undefined });
  }
  return changed;
}

/**
 * Inject synthetic user messages into the wire payload AND the UI channel.
 *
 * Entries whose stable id already exists in the channel are skipped (dedupe),
 * so re-running onConfig mid-loop or across restores never duplicates. Returns
 * the contents that were actually injected (empty when nothing changed).
 *
 * Both channel and wire APPEND to the end. Appending keeps per-turn injection
 * order = time order (so later re-injections never jump ahead of earlier ones)
 * and only grows the message tail — preserving the prompt-cache prefix.
 *
 * **Returns a new wire array; never edits the one it is handed.** That array may be
 * the projection `WireProjectionCache` retains and returns by reference, so pushing
 * into it would (a) leak the synthetic message into every later call of the run even
 * after it is no longer admitted, and (b) duplicate it on the next channel projection,
 * which appends the same message by id. Callers must use the return value.
 *
 * @returns `{ injected, messages }` — the injected contents, and the wire to use.
 */
export function injectSyntheticMessages(
  messages: ModelMessage[],
  entries: SyntheticMessageEntry[],
  deps: SyntheticInjectionDeps
): SyntheticInjectionResult {
  if (entries.length === 0) return { injected: [], messages };

  const existingIds = new Set(deps.ui.getMessages().map((message) => message.id));
  const fresh = entries.filter((entry) => !existingIds.has(syntheticMessageId(entry)));
  if (fresh.length === 0) return { injected: [], messages };

  // --- Channel: append (time order) via the shared safe entry, then persist. ---
  const inserted: UIMessage[] = fresh.map((entry) => ({
    id: syntheticMessageId(entry),
    role: "user",
    parts: [{ type: "text", content: entry.content }],
  }));
  // --- Channel: append (time order) via the shared safe entry, then persist. ---
  appendChannelMessages(deps.ui, inserted, { existingIds, persist: deps.persist });

  // --- Wire: new array, appended at the tail so this call's payload matches what
  // the next channel projection produces (cross-turn prefix stability). ---
  const next = [...messages, ...fresh.map((entry) => ({ role: "user" as const, content: entry.content }))];

  return { injected: fresh.map((entry) => entry.content), messages: next };
}
