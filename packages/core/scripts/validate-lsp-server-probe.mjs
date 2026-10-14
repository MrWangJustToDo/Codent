/**
 * Validation for LspManager probe-before-spawn behavior.
 *
 * Covers:
 * - Missing server binary → probe skips spawn, no throw, onServerError fired
 * - getStatus marks unavailable with a human reason
 * - Present binary → proceeds past the probe to the connection factory
 * - Spawn ENOENT → translated to a friendly actionable message
 *
 * Run: pnpm --filter @codent/core run validate:lsp-server-probe
 */

import assert from "node:assert/strict";

import { LspManager } from "../dist/dev.mjs";

const path = {
  join: (...p) => p.join("/"),
  resolve: (...p) => "/" + p.join("/"),
};
const fs = {
  existsSync: async () => false,
  readFile: async () => "",
  readdir: async () => [],
};

let spawnAttempts = 0;
const getConnection = () => {
  spawnAttempts++;
  throw new Error("should never be reached when probe skips");
};

const failures = [];
const manager = new LspManager(
  "/repo",
  getConnection,
  path,
  fs,
  undefined,
  {
    onServerError: (lang, msg, kind) => failures.push({ languageId: lang, error: msg, kind }),
  },
  undefined,
  async (cmd) => cmd === "typescript-language-server"
);

// 1. Missing binary → probe skips start (no spawn, no throw), reports once.
manager.setServerConfig("go", { command: "gopls", args: ["serve"] });
const client = await manager.waitForClient("go", 3000);
assert.equal(client, null);
assert.equal(spawnAttempts, 0);
assert.equal(failures.length, 1);

// 2. getStatus marks the missing-binary server unavailable with a reason.
const status = manager.getStatus().find((s) => s.languageId === "go");
assert.ok(status);
assert.equal(status.available, false);
assert.match(status.unavailableReason ?? "", /not found on PATH/);

// 3. Present binary → proceeds past probe to the connection factory.
let reachedConnection = false;
manager.setConnectionFactory(() => {
  reachedConnection = true;
  return {
    languageId: "typescript",
    initialized: false,
    disposed: false,
    start: async () => {
      throw new Error("ENOENT (simulated)");
    },
    sendRequest: async () => undefined,
    sendNotification: () => {},
    didOpen: () => {},
    didChange: () => {},
    onUnexpectedExit: () => {},
    onPublishDiagnostics: () => {},
    shutdown: async () => {},
    request: async () => undefined,
    notify: () => {},
  };
});
manager.setServerConfig("typescript", { command: "typescript-language-server", args: ["--stdio"] });
await manager.getClientForLanguage("typescript").catch(() => {});
// startServer runs fire-and-forget and awaits the probe, so let it settle.
await new Promise((r) => setTimeout(r, 50));
assert.equal(reachedConnection, true);

// 4. Spawn ENOENT → friendly actionable message in onServerError.
const enoentError = failures.find((f) => f.error.includes("not found on PATH"));
assert.ok(enoentError, "expected an ENOENT-friendly onServerError message");

// 5. probeCommand result is cached (second call does not re-invoke the probe).
let probeCalls = 0;
const countingManager = new LspManager("/repo", getConnection, path, fs, undefined, undefined, undefined, async () => {
  probeCalls++;
  return true;
});
await countingManager.probeCommand("clangd");
await countingManager.probeCommand("clangd");
assert.equal(probeCalls, 1);

// 6. The failure KIND travels with the message — the extension must not have to infer it from text.
assert.equal(failures[0].kind, "command_missing", "a probed-absent binary is a command_missing (degrade)");
assert.equal(enoentError.kind, "command_missing", "…and so is an ENOENT from the spawn, translated");

// A race at startup — the session closes while the handshake is in flight — must be reported as
// `start_abandoned`, NOT as a failure: the server did nothing wrong, and the very next start of the
// same language succeeds. Reporting it as an error is what makes a startup read as "failed, then ready".
{
  let releaseStart;
  const starting = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const raceManager = new LspManager(
    "/repo",
    () => ({
      languageId: "typescript",
      initialized: false,
      disposed: false,
      start: () => starting,
      sendRequest: async () => undefined,
      sendNotification: () => {},
      didOpen: () => {},
      didChange: () => {},
      onUnexpectedExit: () => {},
      onPublishDiagnostics: () => {},
      shutdown: async () => {},
      kill: () => {},
    }),
    path,
    fs,
    undefined,
    { onServerError: (languageId, error, kind) => failures.push({ languageId, error, kind }) },
    undefined,
    async () => true
  );
  raceManager.setServerConfig("typescript", { command: "typescript-language-server", args: ["--stdio"] });
  const inFlight = raceManager.waitForClient("typescript", 500);
  await new Promise((r) => setTimeout(r, 10)); // let startServer reach the handshake
  // `shutdownAll` sets the flag synchronously and then awaits the in-flight start, so the handshake has
  // to be released first — otherwise this test deadlocks instead of exercising the race.
  const shutdown = raceManager.shutdownAll();
  releaseStart();
  await shutdown;

  await inFlight.catch(() => {});
  const abandoned = failures.find((f) => f.kind === "start_abandoned");
  assert.ok(abandoned, "a startup abandoned by shutdown reports `start_abandoned`");
}

// 7. How each kind is surfaced. Three of the four are NOT failures, and `restart_pending` is not even
// terminal — the rule the extension applies, asserted here so a silent downgrade cannot creep back in.
{
  const { classifyServerFailure } = await import("../dist/dev.mjs");
  assert.equal(classifyServerFailure("not found on PATH", "start_failed").level, "info", "missing binary → info");
  assert.equal(classifyServerFailure("shutdown during startup", "start_abandoned").level, "info", "a race → info");
  assert.equal(
    classifyServerFailure("handshake failed", "restart_pending").level,
    "silent",
    "a retry in flight → log only"
  );
  const terminal = classifyServerFailure("handshake timed out after 30000ms", "start_failed");
  assert.equal(terminal.level, "error", "a server that did not come up → error");
  assert.match(terminal.text, /handshake timed out/, "…and the notice carries the reason");
}

// 8. One server per identical config record — the headline invariant.
//
// The default table gives `typescript` / `javascript` / `typescriptreact` / `javascriptreact` the SAME
// record, so auto-starting all four used to spawn four equivalent servers. One connection created is one
// process spawned (the host builds a connection per start), so counting factory calls is the assertion.
{
  const connections = [];
  let exits = [];
  const crashes = [];
  const sharingManager = new LspManager(
    "/repo",
    () => {
      const exitHandlers = [];
      exits.push(exitHandlers);
      const connection = {
        languageId: "typescript",
        initialized: false,
        disposed: false,
        start: async () => {
          connection.initialized = true;
        },
        sendRequest: async () => undefined,
        sendNotification: () => {},
        didOpen: () => {},
        didChange: () => {},
        onUnexpectedExit: (cb) => exitHandlers.push(cb),
        onPublishDiagnostics: () => {},
        shutdown: async () => {
          connection.disposed = true;
        },
        kill: () => {},
      };
      connections.push(connection);
      return connection;
    },
    path,
    fs,
    undefined,
    { onServerCrash: (languageId, restarting, attempt) => crashes.push({ languageId, restarting, attempt }) },
    undefined,
    async () => true
  );
  for (const id of ["typescript", "javascript", "typescriptreact", "javascriptreact"]) {
    sharingManager.setServerConfig(id, { command: "typescript-language-server", args: ["--stdio"] });
  }

  sharingManager.startEagerly(["typescript", "javascript", "typescriptreact", "javascriptreact"]);
  await sharingManager.waitForClient("typescript", 1000);

  assert.equal(connections.length, 1, "four ids with the same record spawn ONE server");
  for (const id of ["typescript", "javascript", "typescriptreact", "javascriptreact"]) {
    assert.ok(sharingManager.getRunningClient(id), `${id} resolves the shared client (alias registered)`);
  }
  assert.equal(
    sharingManager.isServerStarting("javascriptreact"),
    false,
    "a sharing id is not seen as starting a second server of its own"
  );

  // The process dies → every alias must go, and the budget is charged once for the shared server.
  exits[0][0](1);
  for (const id of ["typescript", "javascript", "typescriptreact", "javascriptreact"]) {
    assert.equal(sharingManager.getRunningClient(id), null, `${id} is cleared when the shared server dies`);
  }
  assert.equal(crashes.filter((c) => c.restarting).length, 1, "one restart is scheduled for the shared server");

  // A record that differs is its own server: the grouping is the config, not the language family.
  sharingManager.setServerConfig("javascript", { command: "typescript-language-server", args: ["--stdio", "--log-level", "4"] });
  // `getClientForLanguage` kicks the start off in the background, so wait for readiness before counting.
  await sharingManager.waitForClient("javascript", 1000);
  assert.equal(connections.length, 2, "a differing record gets its own server");
}

console.log("lsp-server-probe validation passed");
