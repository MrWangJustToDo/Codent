/**
 * How this host tells the user something that is neither a message chunk nor a tool row.
 *
 * A client that advertises `session.notices` gets a real `notice`; one that does not gets a single
 * agent message, because a cancelled or timed-out interaction that produced no output at all reads
 * as a hang.
 */

import type { SessionBridge } from "./session-bridge.js";
import type { SessionUpdate } from "../wire/types.js";

export type NoticeLevel = "info" | "warning" | "error";

/** Only the two fields the choice depends on, so this stays callable from outside a live bridge. */
export type NoticeTarget = Pick<SessionBridge, "acpId" | "notices">;

export function notify(
  emit: (acpId: string, update: SessionUpdate) => void,
  bridge: NoticeTarget,
  message: string,
  level: NoticeLevel
): void {
  if (bridge.notices) {
    emit(bridge.acpId, { sessionUpdate: "notice", severity: level, title: message });
    return;
  }
  emit(bridge.acpId, {
    sessionUpdate: "agent_message_chunk",
    messageId: `${bridge.acpId}-notice-${Date.now()}`,
    content: { type: "text", text: message },
  });
}
