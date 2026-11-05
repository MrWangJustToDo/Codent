/**
 * Validates the workspace log sink lifetime:
 * - one bind per agent, to the stable `.agents/logs` directory (no session subdirectory);
 * - later binds are no-ops (session switches never re-point the file);
 * - manager attach path vs standalone fallback;
 * - destroy order: flush → release.
 *
 * Run: pnpm --filter @codent/core run validate:agent-log-binding
 */

import assert from "node:assert/strict";

import { AgentLogBinding } from "../dist/dev.mjs";

function makeLog({ hasSink = true, pending = 0, pendingDropped = 0 } = {}) {
  const calls = [];
  return {
    calls,
    attachFileSink: (options) => {
      calls.push({ op: "attach", options });
      return () => calls.push({ op: "detach" });
    },
    flushSync: () => calls.push({ op: "flush" }),
    hasSink: () => hasSink,
    getPendingEntryCount: () => pending,
    getPendingDroppedCount: () => pendingDropped,
  };
}

function makeBinding({ log, attachViaManager }) {
  return new AgentLogBinding({
    getLog: () => log,
    getCoreEnv: () => ({}),
    ...(attachViaManager ? { attachViaManager } : {}),
  });
}

// ---------------------------------------------------------------------------
// 1. Manager path: one bind, stable directory, idempotent
// ---------------------------------------------------------------------------
{
  const log = makeLog();
  const binding = makeBinding({
    log,
    attachViaManager: (_log, options) => {
      log.calls.push({ op: "manager-attach", options });
      return () => log.calls.push({ op: "manager-detach" });
    },
  });

  binding.bind();
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0].op, "manager-attach");
  assert.equal(log.calls[0].options.dir, ".agents/logs", "the timeline is workspace-scoped");

  binding.bind();
  binding.bind();
  assert.equal(log.calls.length, 1, "later binds (session changes) do not re-point the file");
}

// ---------------------------------------------------------------------------
// 2. Standalone fallback when no log extension is attached
// ---------------------------------------------------------------------------
{
  const log = makeLog();
  const binding = makeBinding({ log });
  binding.bind();
  assert.deepEqual(
    log.calls.map((call) => call.op),
    ["attach"],
    "no manager → AgentLog.attachFileSink"
  );
  assert.equal(log.calls[0].options.dir, ".agents/logs");
}

// ---------------------------------------------------------------------------
// 3. Destroy order: flush, then release; idempotent
// ---------------------------------------------------------------------------
{
  const log = makeLog();
  const binding = makeBinding({
    log,
    attachViaManager: () => {
      log.calls.push({ op: "manager-attach" });
      return () => log.calls.push({ op: "detach" });
    },
  });
  binding.bind();
  await binding.flushOnDestroy();
  assert.deepEqual(
    log.calls.map((call) => call.op),
    ["manager-attach", "flush", "detach"],
    "destroy flushes before releasing"
  );

  await binding.flushOnDestroy();
  assert.deepEqual(
    log.calls.map((call) => call.op),
    ["manager-attach", "flush", "detach", "flush"],
    "detach is idempotent"
  );
}

// ---------------------------------------------------------------------------
// 4. A build that never bound still reports its dropped bootstrap buffer
// ---------------------------------------------------------------------------
{
  const log = makeLog({ hasSink: false, pending: 2, pendingDropped: 1 });
  const binding = makeBinding({ log });
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await binding.flushOnDestroy();
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /dropping 2 buffered log entries and 1 already-overflowed/);
}

console.log("agent-log-binding validation passed");
