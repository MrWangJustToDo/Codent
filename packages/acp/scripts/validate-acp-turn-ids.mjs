/**
 * One ACP `messageId` per TURN — the grouping a client renders as one assistant message.
 *
 * The protocol says "a changed `messageId` indicates a new message", and core gives every model step its
 * own message id (`chat-completions-…`, `anthropic-…`). Passing those through told a client that one turn
 * was several messages: two reasoning-only rows, then the answer — which a reader reports as duplicated
 * thinking, and which is what arrives split/out of order on a replay. The adapters Zed ships never send an
 * id at all (every chunk lands on the current message); a per-turn id is that same grouping with an
 * explicit key, so a replay can patch a message instead of appending blind.
 *
 * Run: node scripts/validate-acp-turn-ids.mjs
 */

import { createChecker, finish } from "./acp-report.mjs";
import { capture } from "./acp-scenario.mjs";

const checker = createChecker();
const check = checker.check;

const messages = [
  { id: "u-1", role: "user", parts: [{ type: "text", content: "first" }] },
  { id: "s-1", role: "assistant", parts: [{ type: "thinking", content: "step one" }] },
  {
    id: "s-2",
    role: "assistant",
    parts: [
      { type: "thinking", content: "step two" },
      { type: "text", content: "answer" },
    ],
  },
  { id: "u-2", role: "user", parts: [{ type: "text", content: "second" }] },
  { id: "s-3", role: "assistant", parts: [{ type: "text", content: "second answer" }] },
];
const snapshot = () => ({ todos: [], mode: "normal", usage: undefined, name: "probe", messages });
const chunksOf = (c) =>
  c.emitted
    .filter((u) => u.sessionUpdate === "agent_thought_chunk" || u.sessionUpdate === "agent_message_chunk")
    .map((u) => [u.sessionUpdate, u.messageId, u.content.text]);

// --- live: the channel re-reports the whole array on every change -------------
{
  const c = capture();
  c.push("messages", messages);
  const chunks = chunksOf(c);
  check(
    "a turn's two steps and its answer share ONE messageId",
    chunks.slice(0, 3).length === 3 && chunks.slice(0, 3).every(([, id]) => id === "s-1"),
    JSON.stringify(chunks.map(([, id, text]) => [id, text]))
  );
  check(
    "…carrying both steps and the answer, nothing dropped",
    chunks
      .slice(0, 3)
      .map(([, , text]) => text)
      .join("|") === "step one|answer|step two",
    JSON.stringify(chunks.map(([, , text]) => text))
  );
  check(
    "…and the next turn gets its own id (`s-3`), not the first turn's",
    chunks.at(-1)?.[1] === "s-3",
    JSON.stringify(chunks.map(([, id]) => id))
  );
  // Re-reporting the same array is idempotent: the grouping must not drift or re-emit.
  c.push("messages", messages);
  check("re-reporting the same turn adds nothing", chunksOf(c).length === chunks.length);
  c.stop();
}

// --- replay: the same mapping, or a reload would split the turn differently ---
{
  const c = capture();
  c.projector.replayFrom(snapshot());
  const chunks = chunksOf(c);
  check(
    "a replay groups a turn the same way live does",
    chunks.slice(0, 3).every(([, id]) => id === "s-1") && chunks.at(-1)?.[1] === "s-3",
    JSON.stringify(chunks.map(([, id, text]) => [id, text]))
  );
  check(
    "…in part order (thinking, thinking, answer)",
    chunks
      .slice(0, 3)
      .map(([kind]) => kind)
      .join(",") === "agent_thought_chunk,agent_thought_chunk,agent_message_chunk",
    JSON.stringify(chunks.map(([kind]) => kind))
  );
  c.stop();
}

finish(checker.failures);
