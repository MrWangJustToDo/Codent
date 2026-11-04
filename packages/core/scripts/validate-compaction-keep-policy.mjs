/**
 * Validates token-budget keep policy: cut-point selection, pairing-safe
 * boundaries, split-turn detection, wire projection consistency, and the
 * default-window fallback when no context window is known (always token-based).
 *
 * Requires a prior package build (`pnpm run build`) so imports resolve from `dist/dev.mjs`.
 *
 * Run: pnpm --filter @codent/core run validate:compaction-keep-policy
 */

import { convertMessagesToModelMessages } from "@tanstack/ai";
import assert from "node:assert/strict";

import {
  createCompactionConfig,
  deriveKeepRecentTokens,
  findCutPointByBudget,
  getModelVisibleMessages,
  keepPolicyProjectionOptions,
  resolveAutoCompactTrigger,
  resolveKeepPolicy,
  createCompactionSummaryUIMessage,
} from "../dist/dev.mjs";

// ============================================================================
// Helpers — build TanStack model messages with realistic sizes
// ============================================================================

let seq = 0;
const text = (t) => ({ type: "text", content: t });
const user = (t) => ({ role: "user", id: `u${seq++}`, content: t });
const assistant = (t, toolCalls) => ({
  role: "assistant",
  id: `a${seq++}`,
  content: [text(t)],
  ...(toolCalls ? { toolCalls } : {}),
});
const toolMsg = (id, output) => ({
  role: "tool",
  toolCallId: id,
  content: [{ type: "text", content: `result:${output}` }],
});
const toolCall = (id, name = "run_command") => ({
  id,
  type: "function",
  function: { name, arguments: "{}" },
});

/** Rough token estimate mirroring chars/4 for assertions. */
const tokensOf = (messages) =>
  messages.reduce((acc, m) => {
    const parts = typeof m.content === "string" ? [text(m.content)] : (m.content ?? []);
    const chars =
      (parts ?? []).reduce((n, p) => n + (p?.type === "text" ? p.content.length : 0), 0) +
      (m.toolCalls ?? []).reduce((n, tc) => n + tc.function.arguments.length + tc.function.name.length, 0);
    return acc + Math.ceil(chars / 4);
  }, 0);

// ============================================================================
// resolveKeepPolicy
// ============================================================================

// Explicit budget wins.
assert.deepEqual(resolveKeepPolicy({ keepRecentTokens: 10_000 }, 200_000), {
  kind: "tokens",
  keepRecentTokens: 10_000,
});

// Derived from context window when unset.
{
  const policy = resolveKeepPolicy({}, 128_000);
  assert.equal(policy.kind, "tokens");
  // min((128k - 16.4k) * 0.25, 32k) ≈ 27.9k
  assert.equal(policy.keepRecentTokens, deriveKeepRecentTokens(128_000));
  assert.ok(policy.keepRecentTokens > 20_000 && policy.keepRecentTokens <= 32_000);
}

// Small windows clamp to a usable minimum.
assert.ok(deriveKeepRecentTokens(8_000) >= 4_000);

// Unknown context window always falls back to a token budget derived from the
// shared default window — never legacy turn counting (so a conversation with
// few but large turns can always be cut).
assert.deepEqual(resolveKeepPolicy({}, undefined), {
  kind: "tokens",
  keepRecentTokens: deriveKeepRecentTokens(128_000),
});
assert.equal(resolveKeepPolicy({}, undefined).kind, "tokens");

// Projection options payload.
assert.deepEqual(keepPolicyProjectionOptions({ kind: "tokens", keepRecentTokens: 5_000 }), {
  keepRecentTokens: 5_000,
});

// ============================================================================
// Trigger base — working budget (tokenThreshold), clamped to the real window
// ============================================================================

// Threshold-first: the trigger shares the UI percentage base. A huge real
// window (e.g. models.dev reports 1M) must NOT defer compaction past the
// auto-filled working budget (min(window, MAX_THRESHOLD)=200k → 80% = 160k).
assert.deepEqual(resolveAutoCompactTrigger({ tokenThreshold: 200_000, compactAtPercent: 80 }, 1_000_000), {
  triggerAt: 160_000,
});
// Oversized threshold is clamped to the real window so compaction can still fire.
assert.deepEqual(resolveAutoCompactTrigger({ tokenThreshold: 500_000, compactAtPercent: 80 }, 128_000), {
  triggerAt: Math.floor((128_000 * 80) / 100),
});
// Small window below the threshold: same clamp, 80% of the window.
assert.deepEqual(resolveAutoCompactTrigger({ compactAtPercent: 80 }, 32_000), {
  triggerAt: Math.floor((32_000 * 80) / 100),
});
// No window info: pure absolute path.
{
  const r = resolveAutoCompactTrigger({ tokenThreshold: 100_000, compactAtPercent: 50 });
  assert.equal(r.triggerAt, 50_000);
}

// ============================================================================
// Budget walk: single oversized turn still yields a cut (the core bug fix)
// ============================================================================

{
  const big = "x".repeat(40_000); // ~10k tokens per message
  // One turn: user + many assistant/tool exchanges. No second user turn exists.
  const messages = [
    user("please refactor everything"),
    ...Array.from({ length: 6 }, (_, i) => [
      assistant(`step ${i}`, [toolCall(`call-${i}`)]),
      toolMsg(`call-${i}`, big),
    ]).flat(),
    assistant("done"),
  ];

  // A single turn (no second user turn) still yields a cut under the token
  // budget, so a few-but-large-turn conversation can never get stuck.
  const cut = findCutPointByBudget(messages, 24_000);
  assert.ok(cut.cutIndex > 1, `expected mid-turn cut, got ${cut.cutIndex}`);
  assert.equal(cut.isSplitTurn, true);
  assert.equal(cut.turnStartIndex, 0);

  // Cut boundary is never a tool result and never orphans pairs.
  const cutMessage = messages[cut.cutIndex];
  assert.notEqual(cutMessage.role, "tool");

  // Kept region tokens are bounded (within slack of the budget).
  assert.ok(tokensOf(messages.slice(cut.cutIndex)) <= 24_000 + 11_000);

  // Summarized side is non-empty → compaction makes progress.
  assert.ok(tokensOf(messages.slice(0, cut.cutIndex)) > 0);
}

// ============================================================================
// Pairing safety across random-ish budgets
// ============================================================================

{
  const messages = [];
  let callId = 0;
  for (let turn = 0; turn < 4; turn++) {
    messages.push(user(`task ${turn} — ${"y".repeat(5_000)}`));
    for (let i = 0; i < 3; i++) {
      messages.push(assistant(`working ${i}`, [toolCall(`c${callId}`)]));
      messages.push(toolMsg(`c${callId}`, "z".repeat(8_000)));
      callId++;
    }
    messages.push(assistant(`turn ${turn} complete`));
  }

  for (const budget of [4_000, 12_000, 30_000, 60_000]) {
    const cut = findCutPointByBudget(messages, budget);
    if (cut.cutIndex === 0) continue;
    const kept = messages.slice(cut.cutIndex);
    // Every kept tool result has its call in the kept region.
    const keptCallIds = new Set(kept.flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.id)));
    for (const m of kept) {
      if (m.role === "tool") {
        assert.ok(keptCallIds.has(m.toolCallId), `orphaned tool result at budget ${budget}`);
      }
    }
    // Never cut on a tool message.
    assert.notEqual(kept[0].role, "tool");
  }
}

// ============================================================================
// Wire projection: deterministic recovery with token budget
// ============================================================================

{
  const history = [
    user("old task"),
    assistant("working", [toolCall("old-call")]),
    toolMsg("old-call", "w".repeat(9_000)),
  ];
  const after = [user("new task"), assistant("ok")];
  const summaryUIMessage = createCompactionSummaryUIMessage("SUMMARY BODY\n[END SUMMARY]");
  const chronologic = convertMessagesToModelMessages([...history, summaryUIMessage, ...after]);

  const opts = keepPolicyProjectionOptions(resolveKeepPolicy({ keepRecentTokens: 1_000 }, undefined));
  const wireA = getModelVisibleMessages(chronologic, opts);
  const wireB = getModelVisibleMessages(chronologic, opts);
  assert.deepEqual(wireA, wireB, "projection must be deterministic over frozen input");

  // Summary first, kept slice follows, newer messages last.
  assert.equal(wireA[0].role, "user");
  assert.ok(JSON.stringify(wireA[0]).includes("SUMMARY BODY"));
  assert.equal(wireA[wireA.length - 1].role, "assistant");

  // Token-budget projection keeps less than a generous legacy budget would here.
  const legacyWire = getModelVisibleMessages(chronologic, { keepRecentTokens: 24_000 });
  assert.ok(wireA.length <= legacyWire.length);
}

// ============================================================================
// A summary must not consume the keep budget (second-compaction regression)
// ============================================================================
//
// The channel is append-only, so a second compaction re-projects from
// `[...history, S1, new, S2]`. If S1's tokens count toward the keep budget, the backward walk
// reaches the budget AT S1, cuts on the first message after it, and drops the whole previously
// kept window — which the new summary never covered. A summary is structural (always at the wire
// head), so both walks must measure the same non-summary sequence.
{
  const uiText = (id, role, content) => ({ id, role, parts: [{ type: "text", content }] });
  const uiHistory = [
    uiText("p1", "user", `p1 ${"a".repeat(4_000)}`),
    uiText("p2", "assistant", `p2 ${"b".repeat(4_000)}`),
  ];
  const uiAfter = [uiText("n1", "user", "n1"), uiText("n2", "assistant", "n2")];
  const summaryUI = createCompactionSummaryUIMessage(`OLD SUMMARY ${"s".repeat(4_000)}`);
  const chronologic = convertMessagesToModelMessages([...uiHistory, summaryUI, ...uiAfter]);
  const summaryIndex = 2;
  const budget = 500;

  const cut = findCutPointByBudget(chronologic, budget);
  assert.ok(
    cut.cutIndex < summaryIndex,
    `the cut must land in the pre-summary history, not on the first message after it (got ${cut.cutIndex})`
  );
  assert.ok(
    chronologic.slice(cut.cutIndex).some((message) => JSON.stringify(message).includes("p2")),
    "the kept window still contains pre-summary history"
  );

  const secondSummaryUI = createCompactionSummaryUIMessage("NEW SUMMARY");
  const afterSecond = convertMessagesToModelMessages([...uiHistory, summaryUI, ...uiAfter, secondSummaryUI]);
  const wire = getModelVisibleMessages(afterSecond, { keepRecentTokens: budget });
  assert.ok(
    JSON.stringify(wire).includes("p2"),
    "a second compaction must not drop the previously kept window (the new summary never covered it)"
  );
  assert.equal(
    wire.filter((message) => JSON.stringify(message).includes("SUMMARY")).length,
    1,
    "only the latest checkpoint is on the wire; older summaries are already folded into it"
  );
}

// ============================================================================
// Single default source: both createCompactionConfig paths resolve to 80%
// ============================================================================
assert.equal(createCompactionConfig({}).compactAtPercent, 80, "explicit-empty path → schema default 80");
assert.equal(createCompactionConfig().compactAtPercent, 80, "undefined path → schema default 80");
assert.deepEqual(
  {
    tokenThreshold: createCompactionConfig().tokenThreshold,
    keepRecentTokens: createCompactionConfig().keepRecentTokens,
  },
  { tokenThreshold: 100_000, keepRecentTokens: undefined }
);

console.log("compaction-keep-policy validation passed");
