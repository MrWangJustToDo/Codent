import { isEmptyAssistantShell } from "../stream/empty-assistant-shell.js";
import { isToolCallPart } from "../stream/message-parts.js";

import type { ToolCallPart, UIMessage } from "@tanstack/ai";

// ToolCallPart["approval"] doesn't include `reason`, but
// applyToolDenialReason dynamically adds it at runtime.
type ToolCallApproval = ToolCallPart["approval"] & { reason?: string };

// ============================================================================
// Types
// ============================================================================

/**
 * Explicit UIMessage persist triggers (no streaming/status heuristics).
 *
 * - `user-message` — user text entered the channel (send / drained steer|follow-up)
 * - `pump-complete` — chat pump idle (finished, waiting, error, or abort cleanup)
 * - `force` — slash commands (`/new`, etc.)
 */
export type SessionSaveReason = "user-message" | "pump-complete" | "force";

export interface SessionSyncSnapshot {
  messageCount: number;
  fingerprints: string[];
}

const STABLE_TOOL_CALL_STATES = new Set<ToolCallPart["state"]>([
  "input-complete",
  "approval-requested",
  "approval-responded",
  "complete",
  "error",
]);

// ============================================================================
// Fingerprint & stability
// ============================================================================

/**
 * Stable summary of a media source value for fingerprinting.
 * Uses the first 64 chars + total length as a deterministic hash.
 * This avoids embedding full base64 in the fingerprint string while
 * still detecting changes: if the content changes, one of these will differ.
 * Fast and synchronous — no SHA-256 computation on every shouldPersist check.
 */
function stableMediaSummary(value: string): string {
  if (value.length <= 64) return value;
  return `${value.slice(0, 64)}...${value.length}`;
}

function fingerprintPart(part: UIMessage["parts"][number]): string {
  switch (part.type) {
    case "text":
      return `text:${part.content}`;
    case "tool-call":
      return [
        "tool-call",
        part.id,
        part.name,
        part.arguments,
        part.state,
        // The core-rendered display payload is attached *after* the tool part
        // settles (`attachToolDisplay`) and the message body never changes again —
        // so without it here the fingerprint matches, `shouldPersist` says no-op,
        // and the display never reaches disk. A restored transcript then renders
        // the raw output instead of the folded row.
        (part as { display?: unknown }).display ? "display" : "",
        (part.approval as ToolCallApproval | undefined)?.id ?? "",
        (part.approval as ToolCallApproval | undefined)?.approved === true
          ? "1"
          : (part.approval as ToolCallApproval | undefined)?.approved === false
            ? "0"
            : "",
        (part.approval as ToolCallApproval | undefined)?.reason ?? "",
        // Decision time: a freshly decided approval carries it on the part, and a
        // legacy one is stamped with the save time — either way the fingerprint
        // moves when the decision time appears.
        (part.approval as { updatedAt?: number } | undefined)?.updatedAt ? "stamped" : "",
        part.output !== undefined ? "out" : "",
      ].join(":");
    case "tool-result":
      return [
        "tool-result",
        part.toolCallId,
        part.state,
        typeof part.content === "string" ? part.content : JSON.stringify(part.content),
        part.error ?? "",
      ].join(":");
    case "thinking":
      return `thinking:${part.content}:${part.signature ?? ""}`;
    case "structured-output":
      return `structured:${part.status}:${part.raw}`;
    case "image":
    case "audio":
    case "video":
    case "document": {
      const source = part.source;
      const metadata = part.metadata as { mediaRef?: { hash?: string } } | undefined;
      const mediaRef = metadata?.mediaRef;
      const value = source.value;
      // Use the mediaRef hash when available (dehydrated on disk), otherwise a
      // stable short summary of the value to avoid embedding full base64 in the
      // fingerprint string.
      const fingerprint = mediaRef?.hash ?? stableMediaSummary(value);
      return `${part.type}:${source.type}:${fingerprint}`;
    }
    default:
      // An unhandled part type must still be content-sensitive: returning just the
      // type name made every content change to a part this switch does not know
      // (a future `file` / `source-url`) look like "no change", so it was never
      // written. Serialize defensively — a non-serializable part degrades to a
      // type-only marker rather than throwing inside a persist check.
      try {
        return `${part.type}:${JSON.stringify(part)}`;
      } catch {
        return part.type;
      }
  }
}

/** Lightweight per-message fingerprint for change detection. */
export function fingerprintUIMessage(message: UIMessage): string {
  if (isEmptyAssistantShell(message)) return `${message.id}:empty`;
  const parts = message.parts.map(fingerprintPart).join("|");
  return `${message.id}:${message.role}:${parts}`;
}

export function computeSessionSyncSnapshot(messages: UIMessage[]): SessionSyncSnapshot {
  return {
    messageCount: messages.length,
    fingerprints: messages.map(fingerprintUIMessage),
  };
}

/** Whether a UIMessage is free of mid-stream tool/structured parts (debug / tests). */
export function isUIMessageStable(message: UIMessage): boolean {
  if (message.role === "user") return true;
  if (isEmptyAssistantShell(message)) return false;

  for (const part of message.parts) {
    if (part.type === "text") continue;

    if (isToolCallPart(part)) {
      if (!STABLE_TOOL_CALL_STATES.has(part.state)) return false;
      continue;
    }

    if (part.type === "tool-result") {
      if (part.state !== "complete" && part.state !== "error") return false;
      continue;
    }

    if (part.type === "thinking") continue;

    if (part.type === "structured-output") {
      if (part.status === "streaming") return false;
    }
  }

  return true;
}

export function areAllUIMessagesStable(messages: UIMessage[]): boolean {
  return messages.every(isUIMessageStable);
}

function snapshotsEqual(a: SessionSyncSnapshot | null, b: SessionSyncSnapshot): boolean {
  if (!a) return false;
  if (a.messageCount !== b.messageCount) return false;
  if (a.fingerprints.length !== b.fingerprints.length) return false;
  for (let i = 0; i < a.fingerprints.length; i++) {
    if (a.fingerprints[i] !== b.fingerprints[i]) return false;
  }
  return true;
}

// ============================================================================
// Persist decision
// ============================================================================

export interface ShouldPersistUIMessagesOptions {
  reason: SessionSaveReason;
}

/**
 * Decide whether to flush {@link UIMessage} history to session storage.
 *
 * All reasons persist when messages are non-empty and the fingerprint changed
 * since the last successful write. Streaming chunks never call this path.
 */
export function shouldPersistUIMessages(
  messages: UIMessage[],
  previous: SessionSyncSnapshot | null,
  options: ShouldPersistUIMessagesOptions
): boolean {
  void options;
  if (messages.length === 0) return false;

  const snapshot = computeSessionSyncSnapshot(messages);
  return !snapshotsEqual(previous, snapshot);
}

// ============================================================================
// Tracker instance
// ============================================================================

export interface SessionSyncTracker {
  getSnapshot(): SessionSyncSnapshot | null;
  markPersisted(messages: UIMessage[]): void;
  reset(messages?: UIMessage[]): void;
  shouldPersist(messages: UIMessage[], options: ShouldPersistUIMessagesOptions): boolean;
}

export function createSessionSyncTracker(): SessionSyncTracker {
  let lastPersisted: SessionSyncSnapshot | null = null;

  return {
    getSnapshot() {
      return lastPersisted;
    },
    markPersisted(messages) {
      lastPersisted = computeSessionSyncSnapshot(messages);
    },
    reset(messages) {
      lastPersisted = messages?.length ? computeSessionSyncSnapshot(messages) : null;
    },
    shouldPersist(messages, options) {
      return shouldPersistUIMessages(messages, lastPersisted, options);
    },
  };
}
