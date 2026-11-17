/**
 * The compaction row: one `compaction_update` per compaction pass, its streamed summary, and the
 * three signals that can close it (the lifecycle event, the slash-command result, leaving
 * `compacting`).
 *
 * Its id is the protocol's upsert key, so every signal for ONE compaction must carry the same one —
 * two ids render as two rows. That is why this state lives in one object rather than in the event
 * handlers that happen to observe it.
 *
 * Two facts make it subtle:
 * - **`[CONVERSATION SUMMARY]` is a `role: "user"` message on the channel** because that is how the
 *   MODEL receives it, but it is not conversation (replaying it showed the whole summary as if the
 *   user had typed it);
 * - **a summary stream `end` closes one PASS, not the compaction.** Multi-pass auto-compaction
 *   continues with the same epoch; only `compaction:*:complete` (or a manual command result) closes
 *   the row. Finishing on `end` discarded every pass after the first.
 */

import { extractCompactionSummaryBody } from "@codent/core";

import { textBlock } from "../wire/content.js";

import { textOf } from "./message-text.js";

import type { SessionUpdate } from "../wire/types.js";
import type { AgentL1State, AgentStreamEvent } from "@codent/core";
import type { UIMessage } from "@tanstack/ai";

/**
 * One line, sent to a client that cannot render a compaction row (no `session.compaction`).
 *
 * The summary itself is model context, not conversation, so the body is not what a reader needs — the
 * position of the compaction is.
 */
const COMPACTION_NOTICE = "[Context compacted — earlier turns are summarized in the model's context.]";

type CompactionStatus = "completed" | "failed" | "cancelled";

export interface CompactionProjectionDeps {
  publish: (update: SessionUpdate) => void;
  /** The client advertises `session.compaction`, so it renders the row. */
  renders: boolean;
}

export class CompactionProjection {
  /**
   * The compaction currently on the wire, if any. Every signal for one compaction has to carry the
   * same id, or the client renders two rows.
   */
  private compaction: { id: string; key: string; summary: string } | undefined;
  /** Fallback ids, for a compaction whose summary stream was never seen (the epoch keys better). */
  private compactionSeq = 0;
  /** A manual `/compact` is in flight; its command result decides the row's outcome, not `state`. */
  private manual = false;
  /**
   * The id of the compaction just closed. An auto-compaction error can arrive after the summary
   * stream's `end` (core closes the stream in `finally`), and it must patch the SAME row rather
   * than opening a second one.
   */
  private lastCompactionId: string | undefined;

  constructor(private readonly deps: CompactionProjectionDeps) {}

  /**
   * A compaction's `[CONVERSATION SUMMARY]` row, carried by a user-role message on replay.
   *
   * The protocol has the place for it — the compaction row — and its id is the message id, which is
   * stable across reloads, so a client that already holds the row patches it rather than gaining
   * another.
   */
  emitSummaryMessage(message: UIMessage): void {
    const body = extractCompactionSummaryBody(textOf(message) ?? "");
    if (!this.deps.renders) {
      // No row for this client; the line keeps the compaction from being invisible in the transcript.
      this.deps.publish({
        sessionUpdate: "agent_message_chunk",
        messageId: `compact:${message.id}`,
        content: textBlock(COMPACTION_NOTICE),
      });
      return;
    }
    this.deps.publish({
      sessionUpdate: "compaction_update",
      compactionId: message.id,
      status: "completed",
      ...(body ? { summary: [textBlock(body)] } : {}),
    });
  }

  /**
   * The status is the only signal a compaction gets that does not depend on the summarizer producing
   * text, so it opens the row when nothing else has.
   *
   * Core deliberately keeps `compaction:auto-start` / `reactive-start` channel-less ("status covers
   * 'compacting'"), which is exactly this field — and both the automatic and the manual path go
   * through here, so a manual `/compact` is reported too.
   */
  onStatus(status: AgentL1State["status"]): void {
    if (status === "compacting") {
      if (!this.compaction) {
        this.lastCompactionId = undefined;
        this.compaction = { id: this.nextId(), key: "", summary: "" };
        this.announce();
      }
      return;
    }
    if (!this.compaction) return;
    // A manual `/compact` is closed by its own lifecycle event (`compaction:manual-*`) or by the
    // slash command's result. Wait for `finishManual`: it may restore the PREVIOUS status (often
    // `idle`) on failure, so leaving `compacting` here is not the outcome.
    if (this.manual) return;
    // Leaving `compacting` without a summary `end`: aborted mid-summary, or failed before its first
    // chunk. Neither produces an `end`, and both would otherwise leave the row open forever.
    this.finish(status === "aborted" ? "cancelled" : status === "error" ? "failed" : "completed");
  }

  /** `compaction:*` lifecycle events → the row's terminal update. */
  onLifecycle(event: {
    type: string;
    payload?: { payload?: { error?: unknown }; error?: unknown };
    error?: unknown;
  }): void {
    // The channel carries the `AgentEvent` envelope (`payload.payload` holds the event's data);
    // projectors driven directly by validators pass the data payload itself. Read both.
    const data = (event.payload?.payload ?? event.payload ?? event) as { error?: unknown };
    const type = event.type;
    if (type === "compaction:auto-complete" || type === "compaction:reactive-complete") {
      this.finish("completed");
    } else if (type === "compaction:auto-error" || type === "compaction:reactive-error") {
      this.finish("failed", errorText(data.error));
    } else if (type === "compaction:manual-complete") {
      // A manual `/compact` has been reported here since the manual event names were split out of
      // `auto`. Without this, a manual compaction driven outside the slash-command path (another
      // host/plane on the same agent) left `manual` latched true forever, so `onStatus` then ignored
      // the end of every following AUTO compaction and the client kept a stale row.
      this.finishManual("completed");
    } else if (type === "compaction:manual-error") {
      this.finishManual("failed", errorText(data.error));
    }
  }

  /**
   * The `summary` channel's COMPACT half.
   *
   * `reset` opens the row, `append` streams it, `end` closes nothing (see the header) — which is the
   * protocol's `compaction_summary_chunk` contract verbatim ("a first-seen id creates an in-progress
   * compaction"). A task summary never reaches here (its row is the `task` tool call).
   */
  onSummary(event: AgentStreamEvent): void {
    if (event.type === "reset") {
      if (event.source !== "compact") return;
      if (this.compaction) {
        // Opened already from the status (`compacting` fires first): the same compaction, one row.
        this.compaction.key = event.key;
        return;
      }
      this.compaction = {
        id: event.epoch ?? event.compactId ?? this.nextId(),
        key: event.key,
        summary: "",
      };
      this.lastCompactionId = undefined;
      this.announce();
      return;
    }

    const active = this.compaction;
    if (!active || event.key !== active.key) return;
    if (event.type !== "append") return;
    active.summary += event.chunk;
    // Chunks are only for a client that renders the row; the text is accumulated either way, because
    // the closing update (and the notice a non-rendering client gets) needs it.
    if (!this.deps.renders) return;
    this.deps.publish({
      sessionUpdate: "compaction_summary_chunk",
      compactionId: active.id,
      content: textBlock(event.chunk),
    });
  }

  /** Mark the start of a manual `/compact`; its command result closes the row. */
  beginManual(): void {
    this.manual = true;
  }

  /** Close a manual compaction from the command's own result (`ok`/`error`). */
  finishManual(status: CompactionStatus, error?: string): void {
    const wasManual = this.manual;
    this.manual = false;
    // Already closed by the summary stream's `end`: do not re-emit a completed row.
    if (!this.compaction && status === "completed") return;
    // A duplicate signal (the lifecycle event and the slash-command result both close the row) has
    // nothing left to close: without this, a failed manual compaction emitted a SECOND failed row
    // under a fresh id.
    if (!wasManual && !this.compaction) return;
    this.finish(status, error);
  }

  /** An id is only required to be unique within the session, so a counter satisfies it. */
  private nextId(): string {
    this.compactionSeq += 1;
    return `compact-${this.compactionSeq}`;
  }

  private announce(): void {
    this.emitUpdate("in_progress");
  }

  /** The one line a client without the compaction capability gets, instead of an open row. */
  private emitNotice(id: string): void {
    this.deps.publish({
      sessionUpdate: "agent_message_chunk",
      messageId: `compact:${id}`,
      content: textBlock(COMPACTION_NOTICE),
    });
  }

  private emitUpdate(status: "in_progress" | CompactionStatus): void {
    if (!this.deps.renders || !this.compaction) return;
    this.deps.publish({
      sessionUpdate: "compaction_update",
      compactionId: this.compaction.id,
      status,
    });
  }

  /**
   * Close the open compaction.
   *
   * The accumulated summary is patched in once, at the end — the chunks already streamed it, and
   * `summary` has replace semantics, so sending it again is what makes the row readable for a client
   * that dropped the chunks.
   */
  private finish(status: CompactionStatus, error?: string): void {
    const summary = this.compaction?.summary.trim();
    // The id survives the row: a completion whose own summary stream was never seen still has to be
    // reported, and reporting it is also what creates the row on the client's side. If the summary
    // stream already closed the row, a late error (`compaction:*:error` is emitted after the stream's
    // `finally end`) patches the SAME id instead of opening a second row.
    const id = this.compaction?.id ?? this.lastCompactionId ?? this.nextId();
    this.compaction = undefined;
    this.lastCompactionId = status === "completed" ? id : undefined;

    if (!this.deps.renders) {
      // Nothing to close for this client. One line at most, so a compaction is not invisible — and only
      // for a success: a failure is reported by the run that failed, and a cancelled one by the abort.
      if (status === "completed") this.emitNotice(id);
      return;
    }
    this.deps.publish({
      sessionUpdate: "compaction_update",
      compactionId: id,
      status,
      ...(status === "completed" && summary ? { summary: [textBlock(summary)] } : {}),
      ...(error ? { error } : {}),
    });
  }
}

/** The failure text of a compaction event, from either shape core emits it in. */
function errorText(error: unknown): string | undefined {
  return typeof error === "string" ? error : ((error as { message?: string } | undefined)?.message ?? undefined);
}
