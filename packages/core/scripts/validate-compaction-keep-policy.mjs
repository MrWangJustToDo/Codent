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
  applyCompactionResult,
  createCompactionConfig,
  UsageTracker,
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

// The clamp only removes room that does not exist — it must never DISABLE compaction.
//
// `keepRecentTokens < triggerAt` is true for every clamp value, including a degenerate 1, so the
// relationship alone is not evidence. The reachable bad shape is a `tokenThreshold` smaller than the
// reserve: the keep budget collapses toward 0, and a cut at index 0 is a no-op that reports `skipped`
// on every model call forever. Asserted on a real chain, because the boundary walk is what turns a
// tiny budget into a usable cut.
{
  const policy = resolveKeepPolicy({ tokenThreshold: 8_000 }, 128_000);
  assert.ok(policy.keepRecentTokens >= 1, "the clamp always returns a positive budget");
  assert.ok(
    policy.keepRecentTokens < resolveAutoCompactTrigger({ tokenThreshold: 8_000 }, 128_000).triggerAt,
    "…below the trigger, which is the whole point of the clamp"
  );
  const chain = [
    user("first question"),
    assistant("first answer"),
    user("second question"),
    assistant("second answer"),
  ];
  const { cutIndex } = findCutPointByBudget(chain, policy.keepRecentTokens);
  assert.ok(cutIndex > 0, `a degenerate keep budget must still cut (got cutIndex ${cutIndex})`);
  assert.ok(chain.length - cutIndex >= 1, "…and keep at least the newest message");
}

// An explicit budget that fits under the trigger is NOT lowered: the clamp is a ceiling, not a
// normalisation, and silently shrinking a working config is the other half of this rule.
assert.equal(
  resolveKeepPolicy({ keepRecentTokens: 10_000, tokenThreshold: 200_000 }, 200_000).keepRecentTokens,
  10_000,
  "a budget with room is preserved verbatim"
);

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
// The CHECKPOINT's recorded budget wins over the current policy
//
// Everything before a checkpoint is frozen, so re-walking with the budget that compaction used
// reproduces its cut. Re-deriving from the CURRENT policy is what let a `/models` switch to a larger
// window (or a late models.dev read) widen the kept window on the next projection — pulling
// already-summarized messages back onto the wire, so the prompt became "summary + originals".
// ============================================================================
{
  const old = Array.from({ length: 6 }, (_, i) => user(`old-${i} ${"y".repeat(8_000)}`));
  const kept = Array.from({ length: 3 }, (_, i) => user(`kept-${i} ${"x".repeat(200)}`));
  const anchored = createCompactionSummaryUIMessage("ANCHORED\n[END SUMMARY]", undefined, {
    keepRecentTokens: 300,
  });
  const chronologic = convertMessagesToModelMessages([...old, ...kept, anchored]);

  // A policy that would keep EVERYTHING (a bigger model window) must not undo the recorded cut.
  const wire = getModelVisibleMessages(chronologic, { keepRecentTokens: 200_000 });
  assert.equal(wire[0].role, "user");
  assert.ok(JSON.stringify(wire[0]).includes("ANCHORED"), "the checkpoint heads the wire");
  // The exact kept count is the cut helper's business (it may widen by one to keep a turn intact);
  // the invariant is that NOTHING summarized comes back.
  assert.ok(wire.length <= 1 + kept.length + 1, `the wire stays at the recorded tail (got ${wire.length})`);
  assert.equal(JSON.stringify(wire).includes("old-0"), false, "summarized history does not come back");

  // A checkpoint written before the anchor existed carries none → the caller's policy applies, which
  // is the pre-fix behaviour (those sessions keep working, they just keep the old semantics).
  const legacy = createCompactionSummaryUIMessage("LEGACY\n[END SUMMARY]");
  const legacyWire = getModelVisibleMessages(convertMessagesToModelMessages([...old, ...kept, legacy]), {
    keepRecentTokens: 200_000,
  });
  assert.equal(
    JSON.stringify(legacyWire).includes("old-0"),
    true,
    "an unanchored checkpoint keeps the pre-fix behaviour (the caller's larger policy applies)"
  );
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
// Apply transports the producer's budget onto the checkpoint
//
// The projection can only read what was written, so the writer is asserted too: `applyCompactionResult`
// prefers `result.keepRecentTokens` over the policy resolved at the call site (they differ on the
// reactive path by design).
// ============================================================================
{
  const written = [];
  const channel = {
    getMessages: () => written,
    setMessages: (next) => {
      written.splice(0, written.length, ...next);
    },
  };
  const applied = applyCompactionResult({}, [], channel, new UsageTracker(), {
    compacted: true,
    tokensBefore: 10,
    tokensAfter: 5,
    type: "auto",
    summary: "APPLIED BODY",
    keepRecentTokens: 1_234,
  });
  assert.equal(applied, true, "the checkpoint is applied");
  const summary = written.at(-1);
  assert.equal(
    summary?.metadata?.compaction?.keepRecentTokens,
    1_234,
    "the checkpoint carries the budget the producer cut with"
  );
}

// The anchor survives the SESSION LOG, not just the in-memory object.
//
// This is the load-bearing link of the whole fix: if `metadata.compaction` did not survive
// `dehydrateUIMessages` → JSONL → `hydrateUIMessages` → `convertMessagesToModelMessages`, every
// restored session would silently fall back to the current policy and re-widen the kept window —
// "summary + originals", which is exactly what the anchor exists to prevent. The dehydrate/hydrate
// pair is a JSON round trip, so the round trip is what this asserts.
{
  const summaryUI = createCompactionSummaryUIMessage("ROUND TRIP BODY", undefined, { keepRecentTokens: 4_321 });
  const persisted = JSON.parse(JSON.stringify([summaryUI]));
  const wire = convertMessagesToModelMessages(persisted);
  assert.equal(
    wire[0]?.metadata?.compaction?.keepRecentTokens,
    4_321,
    "the compaction anchor is still readable after a JSON round trip (session log)"
  );
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

// --- the keep budget can never reach the trigger point ----------------------
//
// The trigger comes from `tokenThreshold`, the keep budget from the CONTEXT WINDOW. With the
// defaults unconstrained, `{ tokenThreshold: 30_000 }` on a 200k window derived a 46k keep: the cut
// had no room, `findCutPointByBudget` returned 0 on every call, and auto-compaction reported
// `skipped` forever — silently disabled, while the UI still showed a percentage that never moved.
{
  const window = 200_000;
  for (const config of [
    { tokenThreshold: 30_000 },
    { tokenThreshold: 30_000, keepRecentTokens: 90_000 },
    { tokenThreshold: 8_000 },
  ]) {
    const policy = resolveKeepPolicy(config, window);
    const { triggerAt } = resolveAutoCompactTrigger(createCompactionConfig(config), window);
    assert.ok(
      policy.keepRecentTokens < triggerAt,
      `keep (${policy.keepRecentTokens}) must leave room below the trigger (${triggerAt}) for ${JSON.stringify(config)}`
    );
  }
  // A normal config is untouched: the derived keep already sits well below the trigger.
  assert.equal(
    resolveKeepPolicy({ tokenThreshold: 100_000 }, window).keepRecentTokens,
    deriveKeepRecentTokens(window, createCompactionConfig().reserveTokens ?? 16_384),
    "the clamp does not move a keep budget that already fits"
  );
}

console.log("compaction-keep-policy validation passed");
