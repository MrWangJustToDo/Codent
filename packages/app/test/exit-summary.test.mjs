/**
 * Validates the exit summary's plain-text rendering.
 *
 * The summary is the last thing a session prints, so a formatting bug in it is unusually
 * visible — and unusually easy to ship, because a wrong number there looks like a plausible
 * number. These pin the three failure modes that matter: a session that never talked to a model
 * must not print a summary at all (a wall of zeros reads as a broken session), the token line
 * must use the *billed* prompt rather than the raw `inputTokens` field (which under an
 * exclusive-cache upstream is only the cache-miss part), and the lines must be captured from the
 * live session before the exit path destroys it.
 *
 * Run: node packages/app/test/exit-summary.test.mjs
 */
import assert from "node:assert/strict";

import { buildExitSummaryLines, formatCost, formatDuration } from "../dist/utils/exit-summary.mjs";

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------
assert.equal(formatDuration(0), "0s");
assert.equal(formatDuration(-5), "0s", "a non-positive duration is zero, not negative");
assert.equal(formatDuration(12_000), "12s");
assert.equal(formatDuration(64_000), "1m 04s", "seconds are zero-padded under a minute unit");
assert.equal(formatDuration(3_600_000 + 2 * 60_000), "1h 02m", "hours drop the seconds");
assert.equal(formatDuration(Number.NaN), "0s", "NaN must not leak into the line");

// ---------------------------------------------------------------------------
// formatCost
// ---------------------------------------------------------------------------
assert.equal(formatCost(0), "$0.00");
assert.equal(formatCost(-1), "$0.00");
assert.equal(formatCost(0.0042), "$0.0042", "sub-cent costs keep enough precision to be meaningful");
assert.equal(formatCost(1.234), "$1.23");

// ---------------------------------------------------------------------------
// buildExitSummaryLines — the empty case
// ---------------------------------------------------------------------------
const emptySession = {
  name: "local-chat",
  agentId: "agent_1",
  usage: {
    total: { inputTokens: 0, outputTokens: 0 },
    billedInputTokens: 0,
    cost: 0,
    llmDurationMs: 0,
    llmOutputTokens: 0,
  },
};

assert.equal(
  buildExitSummaryLines(emptySession),
  null,
  "a session that never talked to a model must not print a summary of zeros"
);

// ---------------------------------------------------------------------------
// buildExitSummaryLines — a real session
// ---------------------------------------------------------------------------
const session = {
  name: "local-chat",
  agentId: "agent_1",
  sessionId: "ses_abc",
  model: "deepseek/deepseek-v4.1-flash",
  usage: {
    // Exclusive-cache shape: `inputTokens` is the cache-miss part only, so the billed prompt
    // (input + cache) is the honest "in" figure.
    total: { inputTokens: 1_200, outputTokens: 4_000, cacheReadTokens: 250_000, cacheWriteTokens: 0 },
    billedInputTokens: 251_200,
    cost: 0.1234,
    llmDurationMs: 90_000,
    llmOutputTokens: 3_600,
  },
  todos: [{ status: "completed" }, { status: "completed" }, { status: "pending" }],
};

const lines = buildExitSummaryLines(session);
assert.ok(lines, "a session with model traffic gets a summary");
const text = lines.join("\n");

assert.ok(text.includes("local-chat"), "the session name is shown");
assert.ok(text.includes("ses_abc"), "the on-disk session id is shown, so the resume hint is usable");
assert.ok(text.includes("deepseek/deepseek-v4.1-flash"), "the model is shown");
assert.ok(text.includes("/resume ses_abc"), "a resume hint is offered when there is a session id");
assert.ok(text.includes("$0.12"), "cost is rendered");
assert.ok(text.includes("11m 07s") === false, "control: duration comes from the process clock, not the fixture");

// The token line must be the billed prompt, never `inputTokens`.
// Asserted as a whole line: `251.20k` *contains* `1.20k`, so a substring check for the
// cache-miss figure would pass against the correct output too. Lines are unindented —
// horizontal placement belongs to the component that frames them.
const tokensLine = lines.find((line) => line.includes("Tokens:"));
assert.equal(tokensLine, "Tokens:    251.20k in / 4.00k out", "the token line uses the billed prompt");
assert.ok(text.includes("250.00k cache read"), "cache read is broken out when present");
assert.ok(!text.includes("cache write"), "a zero cache write is omitted rather than printed as 0");
assert.ok(text.includes("2/3 completed"), "todo progress is summarized");

// A session id is optional; without one there is no resume hint to give.
const noSessionId = buildExitSummaryLines({ ...session, sessionId: undefined });
assert.ok(noSessionId.join("\n").includes("/resume") === false, "no session id means no resume hint");

// Speed needs both a duration and output tokens — a half-measured pair must not print a ratio.
const noTiming = buildExitSummaryLines({
  ...session,
  usage: { ...session.usage, llmDurationMs: 0 },
}).join("\n");
assert.ok(!noTiming.includes("tok/s"), "without measured LLM time there is no tok/s to report");

// ---------------------------------------------------------------------------
// exitWithSummary — capture before destroy
// ---------------------------------------------------------------------------
// The summary is a reading of the *live* session, and the exit path destroys the session before
// `process.exit` lands. The lines must therefore be captured first; getting that order wrong
// fails silently (an empty summary, no error).

const { useAgent } = await import("../dist/index.mjs");
const { exitWithSummary } = await import("../dist/utils/exit-with-summary.mjs");

// The store is a module singleton; start from a known state.
useAgent.getActions().beginExit(null);

// A fake live session that reports real usage only while it is alive — a destroyed session reads
// back empty, which is what makes a capture-after-destroy order observable here.
let destroyed = false;
const liveUsage = {
  total: { inputTokens: 1_200, outputTokens: 4_000, cacheReadTokens: 250_000, cacheWriteTokens: 0 },
  billedInputTokens: 251_200,
  cost: 0.1234,
  llmDurationMs: 90_000,
  llmOutputTokens: 3_600,
};
const fakeSession = {
  id: "agent_1",
  getSnapshot: () => ({
    name: "local-chat",
    agentId: "agent_1",
    sessionId: "ses_abc",
    model: "deepseek/deepseek-v4.1-flash",
    usage: destroyed
      ? {
          total: { inputTokens: 0, outputTokens: 0 },
          billedInputTokens: 0,
          cost: 0,
          llmDurationMs: 0,
          llmOutputTokens: 0,
        }
      : liveUsage,
  }),
};

const destroyedIds = [];
let adapterExited = false;
exitWithSummary({
  adapter: { exit: () => (adapterExited = true) },
  session: fakeSession,
  destroySession: (id) => {
    destroyedIds.push(id);
    destroyed = true;
  },
});

assert.deepEqual(destroyedIds, ["agent_1"], "the session is torn down on the way out");
assert.ok(adapterExited, "the host is told to exit after the summary is captured");

const captured = useAgent.getState().exitSummaryLines;
assert.ok(captured && captured.length > 0, "the summary must be captured from the live session");
assert.ok(
  captured.some((line) => line.includes("251.20k")),
  "the captured lines are the live reading, not the post-destroy empty one"
);

console.log("exit-summary tests passed");
