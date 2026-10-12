/**
 * PendingInteractionStore — tracks interactions awaiting a user answer.
 *
 * Button payloads stay tiny (`{a,r,i}` — Telegram `callback_data` caps at 64
 * bytes); the full context (tool name, ids, chat, expiry) lives here, keyed by
 * a short request id. Records expire after a TTL with an auto-deny callback,
 * mirroring chat-bot approval conventions (60s default).
 */

import { BUILTIN_TOOL_NAMES } from "@codent/core";

import type { Button, ButtonPayload, ChatTarget, PendingInteraction } from "../types.js";

export interface PendingRecord {
  requestId: string;
  /** Session key (`platform:chatId:threadId`) the interaction belongs to. */
  chatKey: string;
  chat: ChatTarget;
  /** User id that is allowed to answer. */
  userId: string;
  pending: PendingInteraction;
  /** Message the buttons were rendered on (for post-resolution cleanup). */
  messageId: string | null;
  /**
   * Multi-select only: indices the user has toggled on so far. Persisted here
   * (not in callback_data) so a toggle can re-render the same row without
   * resolving it.
   */
  selected: Set<number>;
  /** When the row's buttons became visible — the answer TTL starts here, not at registration. */
  renderedAt: number | null;
  /** Absolute expiry (`renderedAt + ttlMs`); null until the row is rendered. */
  expiresAt: number | null;
}

export function encodeButtonPayload(payload: ButtonPayload): string {
  return JSON.stringify(payload);
}

export function decodeButtonPayload(data: string): ButtonPayload | undefined {
  try {
    const parsed = JSON.parse(data) as Partial<ButtonPayload>;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    if (parsed.a !== "y" && parsed.a !== "n" && parsed.a !== "o" && parsed.a !== "t" && parsed.a !== "s") {
      return undefined;
    }
    if (typeof parsed.r !== "string") return undefined;
    return {
      a: parsed.a,
      r: parsed.r,
      ...(typeof parsed.i === "number" ? { i: parsed.i } : {}),
    };
  } catch {
    return undefined;
  }
}

export class PendingInteractionStore {
  private readonly records = new Map<string, PendingRecord>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private counter = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly onExpire: (record: PendingRecord) => void | Promise<void>
  ) {}

  /**
   * Build the button row for a pending interaction, reflecting the record's
   * current multi-select state. An ask_user without options renders NO buttons
   * (the user answers by replying with text) — the row still counts as an
   * interaction so its TTL is armed and it can be settled.
   */
  buttonsFor(record: PendingRecord): Button[] {
    const { pending, requestId } = record;
    if (pending.kind === "approval") {
      return [
        { label: "✅ Approve", data: encodeButtonPayload({ a: "y", r: requestId }) },
        { label: "❌ Deny", data: encodeButtonPayload({ a: "n", r: requestId }) },
      ];
    }
    if (pending.options.length === 0) return [];
    if (!pending.multiSelect) {
      return pending.options.map((option, index) => ({
        // Long option text must stay a usable label (platform button caps ~64 chars).
        label: option.length > 60 ? `${option.slice(0, 59)}…` : option,
        data: encodeButtonPayload({ a: "o", r: requestId, i: index }),
      }));
    }
    // Multi-select: toggle each option, then a submit button commits the set.
    const toggles = pending.options.map((option, index) => {
      const mark = record.selected.has(index) ? "✅" : "⬜";
      const label = `${mark} ${option}`;
      return {
        label: label.length > 60 ? `${label.slice(0, 59)}…` : label,
        data: encodeButtonPayload({ a: "t", r: requestId, i: index }),
      };
    });
    toggles.push({ label: "✔ Submit", data: encodeButtonPayload({ a: "s", r: requestId }) });
    return toggles;
  }

  /** Flip a multi-select option's checked state (no resolution). */
  toggleOption(record: PendingRecord, index: number | undefined): void {
    if (index === undefined || record.pending.kind !== BUILTIN_TOOL_NAMES.askUser) return;
    if (index < 0 || index >= record.pending.options.length) return;
    if (record.selected.has(index)) record.selected.delete(index);
    else record.selected.add(index);
  }

  /** Selected option labels for a multi-select record, in option order. */
  selectedOptions(record: PendingRecord): string[] {
    const { pending } = record;
    if (pending.kind !== BUILTIN_TOOL_NAMES.askUser) return [];
    return [...record.selected].sort((a, b) => a - b).map((index) => pending.options[index] as string);
  }

  /** Next short request id for a button payload (pre-reserve before sending buttons). */
  nextRequestId(): string {
    return `r${++this.counter}`;
  }

  register(
    pending: PendingInteraction,
    context: { chatKey: string; chat: ChatTarget; userId: string; messageId: string | null },
    requestId: string = this.nextRequestId()
  ): PendingRecord {
    const record: PendingRecord = {
      requestId,
      chatKey: context.chatKey,
      chat: context.chat,
      userId: context.userId,
      pending,
      messageId: context.messageId,
      selected: new Set<number>(),
      renderedAt: null,
      expiresAt: null,
    };
    this.records.set(requestId, record);
    // The TTL is NOT armed here: a long run can post dozens of tool lines before
    // this interaction's row is even visible, and expiring an unseen row is
    // exactly the "stuck" bug. {@link markRendered} arms it from the render.
    return record;
  }

  /**
   * Arm the answer TTL once the row's buttons are visible on the platform.
   * Idempotent — only the first call (per record) starts the timer.
   * Returns whether the timer was armed.
   */
  markRendered(requestId: string): boolean {
    const record = this.records.get(requestId);
    if (!record || record.renderedAt !== null) return false;
    record.renderedAt = Date.now();
    record.expiresAt = record.renderedAt + this.ttlMs;
    const timer = setTimeout(
      () => {
        this.records.delete(requestId);
        this.timers.delete(requestId);
        void this.onExpire(record);
      },
      Math.max(this.ttlMs, 1)
    );
    this.timers.set(requestId, timer);
    return true;
  }

  /** Look up a pending record by its renderer segment key and arm its TTL. */
  markRenderedBySegment(segmentKey: string): string | undefined {
    for (const record of this.records.values()) {
      if (record.pending.segmentKey !== segmentKey) continue;
      this.markRendered(record.requestId);
      return record.requestId;
    }
    return undefined;
  }

  /** Resolve a callback; undefined when the request is unknown or already answered. */
  resolve(payload: ButtonPayload): PendingRecord | undefined {
    return this.resolveById(payload.r);
  }

  /** Resolve by request id (button click, free-text answer, …). */
  resolveById(requestId: string): PendingRecord | undefined {
    const record = this.records.get(requestId);
    if (!record) return undefined;
    this.records.delete(requestId);
    const timer = this.timers.get(requestId);
    if (timer) clearTimeout(timer);
    this.timers.delete(requestId);
    return record;
  }

  /** Look up a record WITHOUT resolving it (multi-select toggle inspection). */
  peek(requestId: string): PendingRecord | undefined {
    return this.records.get(requestId);
  }

  /**
   * Oldest unanswered ask_user record for a chat — a plain text message while
   * one is pending is that interaction's free-form answer.
   */
  findPendingAskUser(chatKey: string): PendingRecord | undefined {
    for (const record of this.records.values()) {
      if (record.chatKey === chatKey && record.pending.kind === BUILTIN_TOOL_NAMES.askUser) return record;
    }
    return undefined;
  }

  /** Whether the row's buttons have been rendered (TTL armed). */
  isRendered(requestId: string): boolean {
    return this.records.get(requestId)?.renderedAt != null;
  }

  /** Whether the given user may answer this record. */
  canAnswer(record: PendingRecord, userId: string): boolean {
    return record.userId === userId;
  }

  pendingCount(): number {
    return this.records.size;
  }

  /** Cancel all pending records (bridge shutdown / session reset). */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.records.clear();
  }
}
