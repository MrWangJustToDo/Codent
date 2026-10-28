/**
 * One projector per announced subagent, emitting under the child's own ACP session id.
 *
 * The child is an ordinary {@link AgentSession}; only three things differ from a top-level session,
 * and each is a decision from the change design:
 *
 * - **no command surface** — a subagent cannot invoke slash commands, so `commands` is always empty;
 * - **no top-level seeding** — mode/commands/title belong to sessions the client created; the child's
 *   messages are replayed explicitly, and `seedState: false` avoids advertising selectors that do not
 *   exist for it;
 * - **the task prompt is inter-session traffic** — `runSubagent` seeds the child channel with a
 *   `role: "user"` message, but it was sent by the PARENT. It is projected as `session_message`
 *   (sender = parent) instead of `user_message_chunk`, by message id so replay and live share the
 *   conversion.
 *
 * Compaction follows the client capability: subagents inherit the parent's compaction config, so a
 * long child run can compact, and its `compaction_update` belongs to the child session.
 */

import { AcpProjector } from "./projector.js";

import type { SessionUpdate } from "./types.js";
import type { AgentSession, AgentSessionChannel } from "@codent/core";

/**
 * The only channels a child needs: its transcript, tools, usage, and the compaction stream/status.
 *
 * Deliberately absent: `interaction` (a subagent has no approvals/ask_user — the spec forbids
 * subscribing), `subagents` (subagents cannot spawn), `todos`/`plan`/`mode` (top-level selectors),
 * `extensions` (no command surface), and `extension-ui` (no extensions). `state` stays for compaction
 * status, with the title suppressed (the parent's announcement is the child's label).
 */
const CHILD_CHANNELS: AgentSessionChannel[] = ["messages", "tool", "summary", "lifecycle", "state", "usage"];

/** Client capabilities a child projector needs (the `subagents` gate itself lives in the host). */
export interface ChildProjectorClient {
  compaction: boolean;
  notices: boolean;
}

export interface ChildProjectorOptions {
  childId: string;
  /** The parent's ACP session id — the sender of the task prompt. */
  parentSessionId: string;
  /** The `task` tool call that spawned this child; the prompt's stable ACP message id is derived from it. */
  parentTaskToolCallId?: string;
  /** Send one update for this child; the host adds the connection/notification envelope. */
  emit: (childId: string, update: SessionUpdate) => void;
  rootPath: string;
  client: ChildProjectorClient;
  /** The parent bridge closed (or its capability vanished); drop everything. */
  isClosed: () => boolean;
}

export interface ChildProjectorHandle {
  /**
   * Attach to the child session. `replay` sends its retained transcript (a newly announced child);
   * `false` attaches without history (a parent `load`/`resume`).
   */
  start(options: { replay: boolean }): void;
  stop(): void;
}

/** The child's first user message is its task prompt (seeded by `runSubagent`). */
function firstUserMessageId(session: AgentSession): string | undefined {
  for (const message of session.getSnapshot().messages) {
    if (message.role === "user") return message.id;
  }
  return undefined;
}

export function createChildProjector(session: AgentSession, options: ChildProjectorOptions): ChildProjectorHandle {
  const promptId = firstUserMessageId(session);
  const projector = new AcpProjector(session, {
    suppressTitle: true,
    rootPath: options.rootPath,
    emit: (update) => {
      if (options.isClosed()) return;
      options.emit(options.childId, update);
    },
    commands: () => ({ builtin: [], extension: [] }),
    client: {
      compaction: options.client.compaction,
      notices: options.client.notices,
      // A child has no children of its own (subagents cannot spawn subagents).
      subagents: false,
    },
    // `messageId` is omitted when the snapshot is not hydrated yet (remote `connect()`): the
    // projector then converts the FIRST user message that arrives, so the prompt is not lost.
    userMessageAsSessionMessage: {
      ...(promptId ? { messageId: promptId } : {}),
      senderSessionId: options.parentSessionId,
      recipientSessionId: options.childId,
      acpMessageId: options.parentTaskToolCallId ? `task:${options.parentTaskToolCallId}` : options.childId,
    },
  });

  return {
    start({ replay }) {
      // Replay BEFORE subscribing (the same ordering `attach` uses): the replay primes the cursors,
      // so the retained-message delivery a subscription triggers emits nothing twice.
      if (replay) projector.replayFrom(session.getSnapshot());
      projector.start({ primeOnly: !replay, seedState: false, channels: CHILD_CHANNELS });
    },
    stop() {
      projector.stop();
    },
  };
}
