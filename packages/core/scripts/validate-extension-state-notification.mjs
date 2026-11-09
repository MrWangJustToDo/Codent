/**
 * Validation for the runner-level extension state notification.
 *
 * The review found that `session:extensions` was published from ONE dispatch command
 * (`extension.toggle`), so any other caller of `loadExtension` / `setEnabled` changed state without
 * telling the host — the panel and remote snapshot kept the old shape. The notification now belongs
 * to the state transition (`onExtensionStateChanged`), and a throwing host callback must not turn a
 * successful activation/disable into a failure.
 *
 * Cases:
 * 1. load / disable / re-enable each notify.
 * 2. A load declared disabled still notifies.
 * 3. Revoking a HUNG activation notifies AND contains a throwing host callback — that path is the
 *    only way to disable an extension whose `activate` never settles, so it must not be the one
 *    path that goes silent.
 * 4. Integration: a real `ManagedAgent` publishes the frame on its bus (the wiring
 *    `agent-bootstrap` owns), and the retained snapshot agrees with the emitted payload.
 *
 * Run: pnpm --filter @codent/core run validate:extension-state-notification
 */

import assert from "node:assert/strict";

import { ExtensionRunner } from "../dist/dev.mjs";
import { AgentManager, registerCoreEnv } from "../dist/index.mjs";

// A minimal env: nothing here touches the filesystem or runs commands.
registerCoreEnv({
  rootPath: "/mock",
  getPlatform: async () => "linux",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => "/mock",
  path: {
    join: (...parts) => parts.join("/"),
    dirname: (p) => {
      const i = p.lastIndexOf("/");
      return i <= 0 ? "/" : p.slice(0, i);
    },
    basename: (p, ext) => {
      const base = p.split("/").pop() ?? p;
      return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
    },
    extname: (p) => {
      const base = p.split("/").pop() ?? p;
      const i = base.lastIndexOf(".");
      return i < 0 ? "" : base.slice(i);
    },
    resolve: (...parts) => `/${parts.join("/")}`,
    normalize: (p) => p.replace(/\/+/g, "/"),
    isAbsolute: (p) => p.startsWith("/"),
    getSep: () => "/",
    parse: (p) => {
      const base = p.split("/").pop() ?? p;
      const i = base.lastIndexOf(".");
      return {
        root: "/",
        dir: p.slice(0, p.lastIndexOf("/")) || "/",
        base,
        ext: i < 0 ? "" : base.slice(i),
        name: i < 0 ? base : base.slice(0, i),
      };
    },
  },
  fs: {
    readFile: async () => {
      throw new Error("ENOENT");
    },
    writeFile: async () => {},
    appendFile: async () => {},
    mkdir: async () => {},
    exists: async () => false,
    readdir: async () => [],
    remove: async () => {},
    stat: async () => {
      throw new Error("ENOENT");
    },
  },
  runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  fetch: async () => new Response("", { status: 200 }),
});

function makeExtension(id) {
  return {
    id,
    name: `${id} ext`,
    version: "1.0.0",
    description: "state notification",
    activate() {},
  };
}

function trackedRunner(extra = {}) {
  const seen = [];
  const runner = new ExtensionRunner({
    onExtensionStateChanged: (id) => seen.push(id),
    ...extra,
  });
  return { runner, seen };
}

// ---------------------------------------------------------------------------
// 1. load / disable / re-enable each publish exactly one state change
// ---------------------------------------------------------------------------
{
  const { runner, seen } = trackedRunner();
  await runner.loadExtension(makeExtension("notify"));
  assert.deepEqual(seen, ["notify"], "a successful load notifies");

  assert.equal((await runner.setEnabled("notify", false)).ok, true);
  assert.deepEqual(seen, ["notify", "notify"], "a disable notifies");

  assert.equal((await runner.setEnabled("notify", true)).ok, true);
  assert.deepEqual(seen, ["notify", "notify", "notify"], "a re-enable notifies");

  await runner.destroyAll();
}

// ---------------------------------------------------------------------------
// 2. A load declared disabled still notifies (the panel must show the instance)
// ---------------------------------------------------------------------------
{
  const { runner, seen } = trackedRunner();
  const instance = await runner.loadExtension(makeExtension("preoff"), { id: "preoff", enabled: false });
  assert.equal(instance.state, "inactive", "it exists but is not activated");
  assert.deepEqual(seen, ["preoff"], "the state is still announced");
  assert.equal(
    runner.getExtensionInfos().find((info) => info.id === "preoff")?.state,
    "inactive",
    "the management snapshot lists it (it is not a failure, just off)"
  );

  await runner.destroyAll();
}

// ---------------------------------------------------------------------------
// 3. Revoking a hung activation notifies, and a throwing host callback is contained
// ---------------------------------------------------------------------------
{
  const seen = [];
  const runner = new ExtensionRunner({
    onExtensionStateChanged: (id) => seen.push(id),
    onExtensionDisabled: () => {
      throw new Error("host wiring bug");
    },
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const loading = runner.loadExtension({
    ...makeExtension("hung"),
    activate: () => gate,
  });

  // `activate` has been invoked and `activating` is set synchronously before the await.
  assert.equal((await runner.setEnabled("hung", false)).ok, true, "a hung activation can be revoked");
  // Exactly one frame: the revoke owns the transition, and the abandoned `loadExtension` must not
  // announce it a second time (the outcome is `revoked`).
  assert.deepEqual(seen, ["hung"], "the revoke publishes exactly one state change");
  // `state === "inactive"` is the instance's INITIAL value, so it proves nothing on its own — the
  // lease is what a real revoke removes.
  assert.equal(runner.contextFor("hung"), undefined, "the activation lease is revoked");
  assert.equal(
    runner.getExtensionInfos().find((info) => info.id === "hung")?.state,
    "inactive",
    "and the snapshot reports it as disabled"
  );

  release();
  const loaded = await loading;
  assert.equal(loaded.state, "inactive", "the abandoned activation does not resurrect the instance");
  await runner.destroyAll();
}

// ---------------------------------------------------------------------------
// 4. A real ManagedAgent publishes `session:extensions` (host wiring, not the probe)
// ---------------------------------------------------------------------------
{
  const manager = new AgentManager();
  const agent = await manager.createManagedAgent({ name: "notify-integration", model: "test-model" });
  const bus = agent.getEventBus();
  assert.ok(bus, "the agent has a scoped bus");

  const frames = [];
  // `on` replays the retained value by default; count only LIVE frames here.
  bus.on("session:extensions", (event) => frames.push(event.payload), { replay: false });

  const runner = agent.getExtensionRunner();
  assert.ok(runner, "bootstrap attached the runner");
  const target = runner.getExtensionInfos().find((info) => info.enabled);
  assert.ok(target, "an active built-in is available to toggle");

  // The retained snapshot BEFORE the change — a stale provider would keep replaying this.
  let before;
  bus.on("session:extensions", (event) => (before = event.payload), { replay: true });
  assert.equal(before.extensions.find((extension) => extension.id === target.id)?.enabled, true);

  assert.equal((await runner.setEnabled(target.id, false)).ok, true);

  assert.equal(frames.length, 1, "the transition published exactly one frame");
  const emitted = frames[0];
  assert.equal(
    emitted.extensions.find((extension) => extension.id === target.id)?.enabled,
    false,
    "the frame carries the new state"
  );

  // A detached copy taken BEFORE the change must not satisfy this assertion; the retained provider
  // has to be reading live runner state, not a snapshot taken at subscribe time.
  let replayed;
  bus.on("session:extensions", (event) => (replayed = event.payload), { replay: true });
  assert.equal(
    replayed.extensions.find((extension) => extension.id === target.id)?.enabled,
    false,
    "the retained snapshot follows the state change (not the pre-disable value)"
  );

  await manager.dispose();
}

console.log("extension-state-notification validation passed");
