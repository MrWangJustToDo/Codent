import type { QueuedMessageContent, QueuedMessagesSnapshot } from "@codent/core";

/**
 * The queued messages a footer line can name.
 *
 * Mid-run input is held in two queues and the footer used to show only their counts, even though the
 * snapshot already carries the content — so "2" was all a user could see of something they had just
 * typed. These helpers turn that into one recognizable line.
 */

/** Text of one queued message: its string, its text parts, or a chip when it is attachments only. */
function textOf(content: QueuedMessageContent): string {
  if (typeof content === "string") return content;

  const text = content
    .map((part) => (part.type === "text" ? part.content : undefined))
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .trim();
  if (text) return text;

  const attachments = content.filter((part) => part.type !== "text").length;
  return attachments > 0 ? `[${attachments} attachment${attachments === 1 ? "" : "s"}]` : "";
}

/**
 * Whether the tail — what {@link module:queue.pop} takes back — can go into the input box.
 *
 * The queue holds `string | ContentPart[]`; the input holds text plus its own attachment state, and the
 * two are not the same shape. Callers check this BEFORE popping, so a message that cannot be restored is
 * never left in limbo.
 */
export function queuedTailIsText(queued: QueuedMessagesSnapshot | undefined): boolean {
  const tail = queued?.followUp.at(-1) ?? queued?.steer.at(-1);
  return typeof tail === "string";
}

/** Everything queued for delivery after the current run. */
export function queuedTotal(queued: QueuedMessagesSnapshot | undefined): number {
  return (queued?.steer.length ?? 0) + (queued?.followUp.length ?? 0);
}

/**
 * One line naming the message that will be delivered NEXT, or `null` when nothing is queued.
 *
 * Steer drains before follow-up (`prepareContinuationPhase` drains steer into the channel first), so the
 * head of the queue is a steer whenever there is one. Collapsed to a single line and ellipsised: the
 * footer is one row, and the job here is recognizing what you typed, not re-reading it.
 */
export function nextQueuedPreview(queued: QueuedMessagesSnapshot | undefined, max = 28): string | null {
  const next = queued?.steer[0] ?? queued?.followUp[0];
  if (next === undefined) return null;

  const line = textOf(next).replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
