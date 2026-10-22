/**
 * Validates the multi-pass summary-stream epoch continuation contract.
 *
 * When a single compaction run has multiple summarizer passes, each pass used
 * to reset the shared `compact:<agentId>` banner — clearing and redrawing it.
 * The fix gives every pass of the same run the same stream epoch, so:
 *   - Pass 1 resets and establishes the epoch.
 *   - Later passes skip the reset and APPEND (hub.append(key, chunk, { epoch })
 *     re-opens an ended entry that shares the same epoch).
 *   - A plain append after end (no epoch) is still ignored (existing contract).
 *
 * Run: pnpm --filter @codent/core run validate:agent-stream-epoch
 */

import assert from "node:assert/strict";

import { AgentStreamHub, createAgentEventBus, agentStreamKey } from "../dist/dev.mjs";

// --- plain append after end is still ignored (existing contract) ---
{
  const hub = new AgentStreamHub();
  const key = agentStreamKey("compact", "agent_root");
  hub.reset({ source: "compact", compactId: "agent_root", label: "first", epoch: "other" });
  hub.append(key, "first line");
  hub.end(key);
  hub.append(key, "\nignored");
  assert.equal(hub.getSnapshot(key)?.pendingLine, "first line");
  assert.equal(hub.getSnapshot(key)?.status, "ended");
}

// --- multi-pass flow: pass 1 resets, later passes append contiguously ---
{
  const hub = new AgentStreamHub();
  const bus = createAgentEventBus();
  hub.setEventBus(bus);
  const key = agentStreamKey("compact", "agent_root");
  const epoch = "cmpepoch_shared";
  /** @type {import("../dist/dev.mjs").AgentStreamEvent[]} */
  const events = [];
  const unsub = bus.on("session:summary", (event) => events.push(event.payload));

  /**
   * Simulate one summarizer pass (run-subagent → runAgentOnce → consumeRun).
   * @param {string} label
   * @param {number} passIndex
   */
  function simulatePass(label, passIndex) {
    // run-subagent pre-append separator (carries epoch → re-opens ended stream)
    if (hub.getSnapshot(key)?.epoch === epoch) {
      hub.append(key, `\n\n[${label}]\n`, { epoch });
    }

    // beginSummaryStream: skip reset only when the snapshot carries our epoch.
    const continuing = hub.getSnapshot(key)?.epoch === epoch;
    if (!continuing) {
      hub.reset({ source: "compact", compactId: "agent_root", label, epoch });
    }

    // stream output (appendSummaryDelta carries epoch)
    hub.append(key, `pass ${passIndex} output line 1\n`, { epoch });
    hub.append(key, `pass ${passIndex} output line 2`, { epoch });

    // consumeRun finally → endSummaryStream
    hub.end(key);
  }

  simulatePass("Summarizing earlier conversation", 1);
  simulatePass("Summarizing discarded turn context", 2);
  simulatePass("Merging segment summaries", 3);

  const final = hub.getSnapshot(key);
  assert.ok(final);
  assert.equal(final.status, "ended", "final status ended after last pass");

  const text = [...final.lines, final.pendingLine ?? ""].join("\n");
  assert.ok(text.includes("pass 1 output line 1"), "pass1 content present");
  assert.ok(text.includes("pass 2 output line 1"), "pass2 content appended, not wiped");
  assert.ok(text.includes("pass 3 output line 2"), "pass3 content present");
  assert.ok(!text.includes("[Summarizing earlier conversation]"), "pass1 has no separator (stream start)");
  assert.ok(text.includes("[Summarizing discarded turn context]"), "separator 2 present");
  assert.ok(text.includes("[Merging segment summaries]"), "separator 3 present");

  // Only the first pass resets; later passes append onto the banner.
  const resetCount = events.filter((e) => e.type === "reset").length;
  assert.equal(resetCount, 1, `exactly one reset (first pass), got ${resetCount}`);

  unsub();
}

console.log("agent-stream epoch validation passed");
