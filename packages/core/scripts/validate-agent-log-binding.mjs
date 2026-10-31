/**
 * Validates the session log sink lifetime:
 * - root-only binding, session-id override, no re-attach for the same directory;
 * - re-pointing releases the previous handle;
 * - manager attach path vs standalone fallback;
 * - external detach (subagent) and destroy order: flush → detach.
 *
 * Run: pnpm --filter @codent/core run validate:agent-log-binding
 */

import assert from "node:assert/strict";

import { AgentLogBinding } from "../dist/dev.mjs";

function makeLog({ hasSink = true, pending = 0 } = {}) {
  const calls = [];
  let dir = "";
  return {
    calls,
    getFileSinkDir: () => dir,
    setFileSinkDir: (next) => {
      dir = next;
    },
    attachFileSink: (options) => {
      calls.push({ op: "attach", options });
      dir = options.dir;
      return () => calls.push({ op: "detach" });
    },
    flushSync: () => calls.push({ op: "flush" }),
    // The destroy path reads these to report a bootstrap that never bound a sink.
    hasSink: () => hasSink,
    getPendingEntryCount: () => pending,
  };
}

function makeBinding({ log, parentId, sessionId, attachViaManager }) {
  return new AgentLogBinding({
    getLog: () => log,
    getParentId: () => parentId(),
    getSessionId: () => sessionId(),
    getAgentId: () => "agent_fallback",
    getCoreEnv: () => ({}),
    ...(attachViaManager ? { attachViaManager } : {}),
  });
}

// ---------------------------------------------------------------------------
// 1. Subagents never bind a session sink
// ---------------------------------------------------------------------------
{
  const log = makeLog();
  const binding = makeBinding({
    log,
    parentId: () => "parent",
    sessionId: () => "ses_child",
    attachViaManager: () => {
      throw new Error("subagent must not attach");
    },
  });
  binding.bind();
  assert.equal(log.calls.length, 0);
}

// ---------------------------------------------------------------------------
// 2. Root bind: session id, manager path, same-dir no-op, re-point detaches
// ---------------------------------------------------------------------------
{
  const log = makeLog();
  let session = "ses_a";
  const binding = makeBinding({
    log,
    parentId: () => undefined,
    sessionId: () => session,
    attachViaManager: (_log, options) => {
      log.calls.push({ op: "manager-attach", options });
      log.setFileSinkDir(options.dir);
      return () => log.calls.push({ op: "manager-detach" });
    },
  });

  binding.bind();
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0].op, "manager-attach");
  assert.equal(log.calls[0].options.dir, ".agents/logs/ses_a");

  binding.bind();
  assert.equal(log.calls.length, 1, "same directory is a no-op");

  session = "ses_b";
  binding.bind();
  assert.deepEqual(
    log.calls.map((call) => call.op),
    ["manager-attach", "manager-detach", "manager-attach"],
    "re-point releases the previous sink first"
  );
  assert.equal(log.calls[2].options.dir, ".agents/logs/ses_b");

  // Explicit target wins over the live session id (restore binds ahead of the swap).
  binding.bind("ses_c");
  assert.equal(log.calls[3].op, "manager-detach");
  assert.equal(log.calls[4].options.dir, ".agents/logs/ses_c");

  // A resume re-points its sink twice (departure line, then the target again); the option must
  // reach the sink so the second attach of the same directory writes no second boundary.
  binding.bind("ses_d", { sessionBoundary: false });
  assert.equal(log.calls.at(-1).options.dir, ".agents/logs/ses_d");
  assert.equal(log.calls.at(-1).options.sessionBoundary, false, "a re-attach can skip the boundary");
}

// ---------------------------------------------------------------------------
// 3. Standalone fallback when no log extension is attached
// ---------------------------------------------------------------------------
{
  const log = makeLog();
  const binding = makeBinding({
    log,
    parentId: () => undefined,
    sessionId: () => "ses_solo",
  });
  binding.bind();
  assert.deepEqual(
    log.calls.map((call) => call.op),
    ["attach"],
    "no manager → AgentLog.attachFileSink"
  );
  assert.equal(log.calls[0].options.dir, ".agents/logs/ses_solo");
}

// ---------------------------------------------------------------------------
// 4. External detach (subagent) + destroy order
// ---------------------------------------------------------------------------
{
  const log = makeLog();
  const binding = makeBinding({
    log,
    parentId: () => undefined,
    sessionId: () => "ses_external",
  });
  binding.setExternalDetach(() => log.calls.push({ op: "external-1" }));
  binding.setExternalDetach(() => log.calls.push({ op: "external-2" }));
  assert.deepEqual(
    log.calls.map((call) => call.op),
    ["external-1"],
    "a second external handle releases the first"
  );

  binding.flushOnDestroy();
  assert.deepEqual(
    log.calls.map((call) => call.op),
    ["external-1", "flush", "external-2"],
    "destroy flushes before releasing the sink"
  );

  binding.flushOnDestroy();
  assert.deepEqual(
    log.calls.map((call) => call.op),
    ["external-1", "flush", "external-2", "flush"],
    "detach is idempotent (no second external release)"
  );
}

// ---------------------------------------------------------------------------
// 5. A destroy that never bound a sink reports the dropped bootstrap entries
// ---------------------------------------------------------------------------
{
  const log = makeLog({ hasSink: false, pending: 2 });
  const binding = makeBinding({
    log,
    parentId: () => undefined,
    sessionId: () => "ses_boot",
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await binding.flushOnDestroy();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1, "the loss is reported once, not silently dropped");
  assert.match(warnings[0], /2 buffered log entries/, "…with the count that was lost");
}

// A bound-then-detached binding must not report entries logged in between as dropped.
{
  const log = makeLog();
  const binding = makeBinding({
    log,
    parentId: () => undefined,
    sessionId: () => "ses_bound",
  });
  binding.bind();
  await binding.flushOnDestroy();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await binding.flushOnDestroy();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 0, "an idempotent second destroy stays silent");
}

console.log("agent-log-binding validation passed");
