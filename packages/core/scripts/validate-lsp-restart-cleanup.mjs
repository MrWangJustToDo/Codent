/**
 * Validation: a scheduled LSP auto-restart does not outlive `shutdownAll`.
 *
 * Run: pnpm --filter @codent/core run validate:lsp-restart-cleanup
 *
 * `handleUnexpectedExit` restarts a crashed server after a backoff. The timer's callback checks
 * `shuttingDown`, which is not enough on its own: `shutdownAll` clears that flag before it returns, so
 * a timer that fires afterwards walks straight through the check and spawns a server into a session
 * the host has already put away — a child process nobody owns, after a `session:shutdown`.
 *
 * Two further properties of the same timer: it is owned per language (two crash reports must not
 * stack two restarts), and a full shutdown ends the crash history (a manager that is started again
 * must get its whole restart budget back).
 *
 * The connection is injected, so no real language server and no child process is involved: the test
 * drives `onUnexpectedExit` itself, which is exactly what the transport forwards when a server dies.
 */

import assert from "node:assert/strict";

import { LspManager, RESTART_INITIAL_BACKOFF_MS } from "../dist/dev.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BACKOFF_SLACK_MS = 1000;

/**
 * A manager whose connections are fakes this test can crash on demand.
 *
 * `path`/`fs` helpers carry only what a non-Java start touches (nothing — `buildConnectionConfig`
 * returns command/args verbatim), and the probe is left out so `probeCommand` reports "unavailable"
 * rather than spawning anything.
 */
function harness() {
  const starts = [];
  const crashes = [];
  const connections = [];

  const makeConnection = () => {
    const connection = {
      languageId: "typescript",
      initialized: false,
      disposed: false,
      serverCapabilities: null,
      exitHandler: null,
      async start() {
        this.initialized = true;
        starts.push(Date.now());
      },
      async shutdown() {
        this.disposed = true;
      },
      kill() {
        this.disposed = true;
      },
      onPublishDiagnostics() {},
      onRequest() {},
      onUnexpectedExit(handler) {
        this.exitHandler = handler;
      },
      async sendRequest() {
        return null;
      },
      sendNotification() {},
      didOpen() {},
      didChange() {},
      didClose() {},
    };
    connections.push(connection);
    return connection;
  };

  const manager = new LspManager(
    "/ws",
    makeConnection,
    { join: (...parts) => parts.join("/"), resolve: (...parts) => parts.join("/") },
    { existsSync: () => false, readFile: async () => "" },
    undefined,
    { onServerCrash: (languageId, restarting, attempt) => crashes.push({ languageId, restarting, attempt }) },
    () => undefined
  );
  manager.setServerConfig("typescript", { command: "fake-lsp", args: [] });

  return { manager, starts, crashes, connections };
}

// ============================================================================
// 1. A restart scheduled before the shutdown must not fire after it
// ============================================================================

{
  const { manager, starts, crashes, connections } = harness();

  await manager.restartServer("typescript");
  assert.equal(starts.length, 1, "the injected server starts");

  // The server dies: the transport forwards the exit, and a restart is scheduled after the backoff.
  connections[0].exitHandler(1);
  assert.equal(crashes.length, 1, "the crash is reported");
  assert.deepEqual(crashes[0], { languageId: "typescript", restarting: true, attempt: 1 }, "…as a restartable attempt");

  // The session ends while that restart is still pending.
  await manager.shutdownAll();
  await sleep(RESTART_INITIAL_BACKOFF_MS + BACKOFF_SLACK_MS);
  assert.equal(starts.length, 1, "a restart scheduled before the shutdown must NOT start a server afterwards");

  // …and the shutdown ends that manager's crash history, so a late exit report starts over rather
  // than spending a budget the user never saw. (Without the reset this reads `attempt: 2`.)
  connections[0].exitHandler(1);
  assert.equal(crashes.at(-1).attempt, 1, "the attempt counter restarts after a full shutdown");

  // Leave no pending timer behind: that last report scheduled one.
  await manager.shutdownAll();
}

// ============================================================================
// 2. One pending restart per language: two crash reports do not stack two restarts
// ============================================================================

{
  const { manager, starts, connections } = harness();

  await manager.restartServer("typescript");
  assert.equal(starts.length, 1);

  // Two exit reports inside the backoff window (the same server exiting twice, or a crash while a
  // restart is already scheduled). One timer must survive, so exactly one restart starts.
  connections[0].exitHandler(1);
  connections[0].exitHandler(1);
  // The surviving timer is the SECOND report's, whose backoff is doubled by the first attempt.
  await sleep(RESTART_INITIAL_BACKOFF_MS * 2 + BACKOFF_SLACK_MS);
  assert.equal(starts.length, 2, "exactly one restart fires, not one per crash report");

  await manager.shutdownAll();
}

console.log("lsp-restart-cleanup validation passed");
