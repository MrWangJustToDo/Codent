/**
 * Message projection: the per-MESSAGE cursors behind `agent_message_chunk` / `agent_thought_chunk`
 * (and the one user-turn report the replay owes the client).
 *
 * Two shared facts shape it:
 *
 * - **one ACP `messageId` per TURN, not per model step.** The protocol says a changed `messageId`
 *   starts a new message, while core gives each model step its own id — passing those through told a
 *   client that one turn was several messages (two reasoning-only rows, then the answer). A user
 *   message opens a turn; the turn's first assistant message names it.
 * - **ACP chunks append.** There is no retraction, so a shorter replacement (a regenerated reply, a
 *   final reasoning revision) is either re-sent under a NEW stable id or swallowed — never written
 *   over what the client already holds.
 */

import { isCompactionSummaryUIMessage, isContextUIMessage } from "@codent/core";

import { textBlock } from "../wire/content.js";

import { imagesOfParts } from "./media.js";
import { textOf, thoughtOf } from "./message-text.js";

import type { SessionUpdate } from "../wire/types.js";
import type { UIMessage } from "@tanstack/ai";

/** Core's mark for "this assistant message opens a turn with no user message" (see `markTurnStart`). */
function isTurnStartMessage(message: UIMessage): boolean {
  return (message.metadata as { turnStart?: unknown } | undefined)?.turnStart === true;
}

/**
 * Project a user message as an inter-session `session_message` instead of `user_message_chunk`.
 *
 * A subagent's first user message IS its task prompt, sent by the parent — not typed by a user of
 * that session. The conversion lives here (by message id, applied to replay and live) because a
 * post-filter would miss the retained-message delivery that `replayFrom` uses.
 */
export interface InterSessionPrompt {
  /**
   * The prompt's message id when it is already in the snapshot. Omitted for a remote child, whose
   * `connect()` returns an unhydrated shell: the first user message that arrives is the prompt, and
   * it still has to be converted (the live path used to drop user messages entirely).
   */
  messageId?: string;
  senderSessionId: string;
  recipientSessionId: string;
  acpMessageId: string;
}

export interface MessageProjectionDeps {
  publish: (update: SessionUpdate) => void;
  userMessageAsSessionMessage?: InterSessionPrompt;
  /** A stored compaction summary is a ROW, not a user turn: the caller owns that projection. */
  emitCompactionSummary: (message: UIMessage) => void;
}

/** Characters of one message already sent, per stream. */
interface MsgCursor {
  /** Characters of concatenated assistant text already sent. */
  text: number;
  /** Characters of concatenated thinking already sent. */
  thought: number;
}

export class MessageProjection {
  private readonly cursors = new Map<string, MsgCursor>();
  /**
   * User messages already reported. A user turn lands in the channel whole (it is not streamed), so
   * one emission per message id is the whole contract — and the set is what keeps a *replayed* turn
   * from being re-sent by the next live tick.
   */
  private readonly emittedUserMessages = new Set<string>();
  /** The ACP message id of the turn being emitted, and source-message → turn-id map (`syncTurnIds`). */
  private turnId: string | undefined;
  private readonly turnIds = new Map<string, string>();
  /**
   * Per-source-message override for a REGENERATED reply.
   *
   * ACP chunks append, so a shorter replacement cannot be written over what the client already has.
   * The regenerated text is re-sent under a stable new id, and every later delta for THAT message
   * must use the same id — otherwise the suffix was appended to the old turn id and the client
   * showed the tail twice.
   */
  private readonly regeneratedIds = new Map<string, string>();
  private regeneratedSeq = 0;
  /** A lazily-resolved child prompt (remote attach) has already been converted once. */
  private promptConverted = false;

  constructor(private readonly deps: MessageProjectionDeps) {}

  /**
   * Recompute the per-turn ACP ids from the full transcript.
   *
   * A user message opens a turn; the turn's first assistant message names it, and every later
   * assistant message of that turn maps onto the same id.
   */
  syncTurnIds(messages: UIMessage[]): void {
    for (const message of messages) {
      // Synthetic per-turn context is persisted as a `user` message but is not the user. Treating it
      // as a turn boundary split one model turn into several ACP messages whenever a context/reminder
      // block was injected between two assistant steps.
      if (isContextUIMessage(message)) continue;
      if (message.role === "user") {
        this.turnId = undefined;
        continue;
      }
      if (message.role !== "assistant") continue;
      // A promptless turn (a background completion waking the session) has no user message to
      // delimit it. Core marks the run's first assistant message instead; without honouring it the
      // wake's output shared the previous turn's `messageId` — appended to the answer the client had
      // already rendered, and never a new (running) turn on its side.
      if (isTurnStartMessage(message)) this.turnId = undefined;
      this.turnId ??= message.id;
      this.turnIds.set(message.id, this.turnId);
    }
  }

  /** The ACP message id this source message's chunks are tagged with. */
  acpIdOf(message: UIMessage): string {
    return this.regeneratedIds.get(message.id) ?? this.turnIds.get(message.id) ?? message.id;
  }

  /** Emit the live text and thinking deltas of one assistant message. */
  emitAssistant(message: UIMessage): void {
    this.emitAssistantText(message);
    this.emitAssistantThought(message);
  }

  /** One stored text/thinking part, replayed verbatim (the replay has no cursor to advance). */
  emitStored(message: UIMessage, kind: "text" | "thinking", content: string): void {
    this.deps.publish({
      sessionUpdate: kind === "text" ? "agent_message_chunk" : "agent_thought_chunk",
      messageId: this.acpIdOf(message),
      content: textBlock(content),
    });
  }

  /**
   * Report one user turn, once — used by replay.
   *
   * NOT the live path: a client that submits a prompt renders it itself, so echoing it live is a
   * duplicated turn (reported as after a cancel: `1` → `11`, because the client's own optimistic row
   * stops being deduplicated once the turn it belonged to is gone). The replay is the half that needs
   * this: there the client has nothing, and the user side is what keeps two consecutive assistant
   * replies from reading as one run of text.
   */
  emitUserMessage(message: UIMessage): void {
    if (isContextUIMessage(message)) return;
    if (isCompactionSummaryUIMessage(message)) {
      this.deps.emitCompactionSummary(message);
      return;
    }
    if (this.emittedUserMessages.has(message.id)) return;

    // A subagent's prompt is a parent→child message, not a user turn of the child session.
    const interSession = this.deps.userMessageAsSessionMessage;
    if (interSession) {
      // A fixed id (local attach) OR the first user message (remote attach, snapshot not hydrated
      // yet). Once converted, a later user message in a child is not a user-typed turn.
      const isPrompt =
        interSession.messageId === undefined ? !this.promptConverted : message.id === interSession.messageId;
      if (!isPrompt) return;
      this.promptConverted = true;
      this.emittedUserMessages.add(message.id);
      const text = textOf(message);
      const images = imagesOfParts(message.parts);
      this.deps.publish({
        sessionUpdate: "session_message",
        messageId: interSession.acpMessageId,
        senderSessionId: interSession.senderSessionId,
        recipientSessionId: interSession.recipientSessionId,
        ...(text || images.length > 0 ? { content: [...(text ? [textBlock(text)] : []), ...images] } : {}),
      });
      return;
    }

    const text = textOf(message);
    const images = imagesOfParts(message.parts);
    if (!text && images.length === 0) return;
    this.emittedUserMessages.add(message.id);
    if (text) {
      this.deps.publish({
        sessionUpdate: "user_message_chunk",
        messageId: message.id,
        content: textBlock(text),
      });
    }
    // An attachment is part of the turn: without this the client loses the image from history on
    // `session/load` (its own live row is the client's, so only the replay can carry it back).
    for (const image of images) {
      this.deps.publish({ sessionUpdate: "user_message_chunk", messageId: message.id, content: image });
    }
  }

  /** A user turn the client already has (resume): remember it so the next tick does not re-send it. */
  primeUserMessage(message: UIMessage): void {
    this.emittedUserMessages.add(message.id);
  }

  /** Cursor an assistant message to its end, so the first live tick emits only what is new. */
  primeAssistant(message: UIMessage): void {
    this.cursors.set(message.id, { text: textOf(message).length, thought: thoughtOf(message).length });
  }

  private emitAssistantText(message: UIMessage): void {
    const text = textOf(message);
    const cursor = this.cursors.get(message.id) ?? { text: 0, thought: 0 };
    if (text.length < cursor.text) {
      // Regenerated reply: ACP chunks append, so the shorter text cannot replace what the client
      // holds. Re-send it under a stable per-message id and route this message's later deltas to
      // that id (`acpIdOf`), so the suffix is not appended to the old turn id.
      cursor.text = text.length;
      if (text) {
        this.regeneratedSeq += 1;
        const regeneratedId = `${this.acpIdOf(message)}-r${this.regeneratedSeq}`;
        this.regeneratedIds.set(message.id, regeneratedId);
        this.deps.publish({
          sessionUpdate: "agent_message_chunk",
          messageId: regeneratedId,
          content: textBlock(text),
        });
      }
      this.cursors.set(message.id, cursor);
      return;
    }
    if (text.length > cursor.text) {
      this.deps.publish({
        sessionUpdate: "agent_message_chunk",
        messageId: this.acpIdOf(message),
        content: textBlock(text.slice(cursor.text)),
      });
      cursor.text = text.length;
    }
    this.cursors.set(message.id, cursor);
  }

  private emitAssistantThought(message: UIMessage): void {
    const thought = thoughtOf(message);
    const cursor = this.cursors.get(message.id) ?? { text: 0, thought: 0 };
    if (thought.length < cursor.thought) {
      // The engine replaced the reasoning with a shorter (final) version. ACP chunks are APPEND-ONLY —
      // there is no retraction — so re-sending it under this message's id appends the whole text a
      // second time, which a client renders as duplicated thinking the moment the thinking phase ends
      // (reported exactly that way). Replacing is not expressible, so the client keeps what it already
      // has and the cursor catches up in silence.
      cursor.thought = thought.length;
      this.cursors.set(message.id, cursor);
      return;
    }
    if (thought.length > cursor.thought) {
      this.deps.publish({
        sessionUpdate: "agent_thought_chunk",
        messageId: this.acpIdOf(message),
        content: textBlock(thought.slice(cursor.thought)),
      });
      cursor.thought = thought.length;
    }
    this.cursors.set(message.id, cursor);
  }
}
