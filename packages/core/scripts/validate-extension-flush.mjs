/**
 * Extension flush / teardown contract — `ctx.registerFlush` and `ctx.registerExitFlush`.
 *
 * The regression this guards is silent in both directions: a teardown flush that is registered but
 * never awaited loses the extension's last batch (the entry just never appears), and an exit flush
 * that is never released keeps running after the extension is destroyed (writing state on behalf of
 * something that no longer exists). Neither shows up as an error, so every assertion here is paired
 * with an inversion — a case that must fail if the mechanism is inert.
 *
 * Covered:
 *   1. `registerFlush` runs before `deactivate()`, and is awaited (a slow flush completes first).
 *   2. A throwing flush is reported as `agent:extension-error` phase `flush` and does NOT skip
 *      deactivate or unregistration; other extensions still tear down.
 *   3. Disabling one extension runs its flush and leaves the others alone.
 *   4. `registerExitFlush` runs on the exit path (fatal handler + `exit`), best-effort.
 *   5. A throwing exit flush is contained — the exit path still completes.
 *   6. Releasing an extension stops its exit flush (unregisterInstanceArtifacts).
 *   7. The log extension's sink is flushed by the exit path (the built-in consumer on both hooks).
 *
 * Run: pnpm --filter @codent/core run validate:extension-flush
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AgentLog,
  ExtensionRunner,
  clearCoreEnv,
  createAgentEventBus,
  createLogExtension,
  flushExtensionExitFlushesSync,
  registerCoreEnv,
  registerExtensionExitFlush,
} from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal real-fs CoreEnv: the sink needs appendFile (+ sync variants for the exit path). */
function createFsEnv(rootPath) {
  // AgentManager binds the *relative* `.agents/logs/<id>` path, so the fixture must resolve like a
  // real host does (absolute paths pass through) — otherwise the sink writes into the cwd.
  const toAbs = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));
  return {
    rootPath,
    path: {
      join: (...p) => p.join("/"),
      dirname: (p) => p.split("/").slice(0, -1).join("/") || "/",
      // The extension loader walks the extension dir with these, so a partial `path` shape fails
      // later (in a different module) rather than here.
      isAbsolute: path.isAbsolute,
      normalize: path.normalize,
      relative: path.relative,
      resolve: (...p) => path.resolve(...p),
    },
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => rootPath,
    fs: {
      readFile: async (p, encoding) => fs.promises.readFile(toAbs(p), encoding),
      writeFile: async (p, content) => fs.promises.writeFile(toAbs(p), content),
      appendFile: async (p, content) => fs.promises.appendFile(toAbs(p), content, "utf8"),
      appendFileSync: (p, content) => fs.appendFileSync(toAbs(p), content, "utf8"),
      mkdir: async (p) => void (await fs.promises.mkdir(toAbs(p), { recursive: true })),
      mkdirSync: (p) => fs.mkdirSync(toAbs(p), { recursive: true }),
      exists: async (p) =>
        fs.promises.access(toAbs(p)).then(
          () => true,
          () => false
        ),
      existsSync: (p) => fs.existsSync(toAbs(p)),
      stat: async (p) => {
        const st = await fs.promises.stat(toAbs(p));
        return { isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size, mtime: st.mtime };
      },
      remove: async (p) => fs.promises.rm(toAbs(p), TEMP_RM_OPTIONS),
      readdir: async () => [],
    },
    runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    fetch: async () => new Response(),
  };
}

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ext-flush-"));
clearCoreEnv();
registerCoreEnv(createFsEnv(rootPath));

// ----------------------------------------------------------------------------
// 1. Flush runs before deactivate, and is awaited.
// ----------------------------------------------------------------------------
{
  const bus = createAgentEventBus("root");
  const runner = new ExtensionRunner({ cwd: "/workspace", eventBus: bus });
  const order = [];

  await runner.loadExtension({
    id: "writer",
    name: "Writer",
    version: "1.0.0",
    description: "buffers state",
    activate: (ctx) => {
      ctx.registerFlush(async () => {
        await sleep(40); // must be *awaited*, not merely started
        order.push("flush");
      });
    },
    deactivate: () => {
      order.push("deactivate");
    },
  });

  runner.destroyAll();
  await sleep(200); // pathological wait: if flush were not awaited, "deactivate" would land first

  assert.deepEqual(order, ["flush", "deactivate"], `flush must settle before deactivate, got ${order.join(" → ")}`);
  console.log("1. flush is awaited before deactivate: ok");
}

// ----------------------------------------------------------------------------
// 2. A throwing flush is reported and does not skip deactivate or unregistration.
// ----------------------------------------------------------------------------
{
  const bus = createAgentEventBus("root");
  const failures = [];
  bus.on("agent:extension-error", (e) => failures.push(e.payload));

  const runner = new ExtensionRunner({ cwd: "/workspace", eventBus: bus });
  const seen = [];
  let toolRegistered = true;

  await runner.loadExtension({
    id: "thrower",
    name: "Thrower",
    version: "1.0.0",
    description: "fails to flush",
    activate: (ctx) => {
      ctx.registerTool({
        name: "thrower_tool",
        description: "t",
        inputSchema: ctx.z.object({}),
        execute: async () => ({}),
      });
      ctx.registerFlush(() => {
        throw new Error("flush boom");
      });
    },
    deactivate: () => {
      seen.push("deactivate");
    },
  });

  runner.destroyAll();
  await sleep(80);

  const flushFailure = failures.find((f) => f.phase === "flush");
  assert.ok(flushFailure, "a throwing flush must be reported (phase: flush)");
  assert.equal(flushFailure.extensionId, "thrower");
  assert.match(flushFailure.error, /flush boom/);
  assert.deepEqual(seen, ["deactivate"], "deactivate must still run after a failed flush");
  assert.equal(
    runner.getTools().find((t) => t.name === "thrower_tool"),
    undefined,
    "tools still unregistered"
  );
  toolRegistered = false;
  void toolRegistered;
  console.log("2. throwing flush is reported, teardown continues: ok");
}

// ----------------------------------------------------------------------------
// 3. Disabling one extension flushes it and leaves others alone.
// ----------------------------------------------------------------------------
{
  const bus = createAgentEventBus("root");
  const runner = new ExtensionRunner({ cwd: "/workspace", eventBus: bus });
  const flushed = [];

  for (const id of ["a", "b"]) {
    await runner.loadExtension({
      id,
      name: id,
      version: "1.0.0",
      description: id,
      activate: (ctx) => ctx.registerFlush(() => flushed.push(id)),
    });
  }

  await runner.setEnabled("a", false);
  assert.deepEqual(flushed, ["a"], `only the disabled extension flushes, got ${flushed.join(", ")}`);

  // Inversion: the flush must still exist for the *other* extension — a registry keyed by nothing
  // would report an empty list here and pass the assertion above vacuously.
  await runner.destroyAll();
  assert.deepEqual(flushed, ["a", "b"], "b's flush must still be registered when it is finally destroyed");
  console.log("3. disable flushes only that extension: ok");
}

// ----------------------------------------------------------------------------
// 4/5. The exit path runs registered exit flushes, and contains a throw.
// ----------------------------------------------------------------------------
{
  const ran = [];
  const disposeFirst = registerExtensionExitFlush(() => ran.push("sync"));
  const disposeThrower = registerExtensionExitFlush(() => {
    throw new Error("exit flush boom");
  });

  // The two calls mirror what `installAgentLogProcessGuards` does on `exit` / the fatal handler.
  flushExtensionExitFlushesSync();
  assert.deepEqual(ran, ["sync"], "a registered exit flush must run on the exit path");
  console.log("4. exit flush runs: ok");

  // Inversion: the thrower was registered *after* `sync`, so silently swallowing the throw must not
  // stop the path — and a second pass must still reach `sync` (no registry corruption).
  ran.length = 0;
  flushExtensionExitFlushesSync();
  assert.deepEqual(ran, ["sync"], "a throwing exit flush must be contained, not abort the path");
  disposeThrower();
  disposeFirst();
  console.log("5. throwing exit flush is contained: ok");
}

// ----------------------------------------------------------------------------
// 6. Destroying an extension releases its exit flush.
// ----------------------------------------------------------------------------
{
  const bus = createAgentEventBus("root");
  const runner = new ExtensionRunner({ cwd: "/workspace", eventBus: bus });
  const ran = [];

  await runner.loadExtension({
    id: "exit-writer",
    name: "Exit writer",
    version: "1.0.0",
    description: "writes on exit",
    activate: (ctx) => ctx.registerExitFlush(() => ran.push("exit-writer")),
  });

  flushExtensionExitFlushesSync();
  assert.deepEqual(ran, ["exit-writer"], "the registered exit flush runs while the extension is alive");

  await runner.destroyAll();
  ran.length = 0;
  flushExtensionExitFlushesSync();
  assert.deepEqual(ran, [], "a destroyed extension must no longer run on the exit path");
  console.log("6. destroying an extension releases its exit flush: ok");
}

// ----------------------------------------------------------------------------
// 7. The log extension's own sink is on the exit path (the built-in consumer).
// ----------------------------------------------------------------------------
{
  const bus = createAgentEventBus("root");
  const dir = path.join(rootPath, ".agents/logs/ses_exit");

  const ext = createLogExtension({ bus, resolveLog: () => null });
  const log = new AgentLog();
  ext.attachSink(log, { dir, filename: "agent.log", flushIntervalMs: 10_000 });
  ext.start();

  log.info("system", "buffered-at-exit");
  // An ordinary exit flush writes through `ctx.logger` — exactly the "state a crash report needs"
  // use case. It must land, which means the log sink's finalizer has to run AFTER it (the sink is
  // registered first, at agent construction, so insertion order alone ran it too early).
  const disposeUserFlush = registerExtensionExitFlush(() => log.info("system", "user-exit-entry"));
  // No polling and no async flush: only the exit path can land this, which is the property under
  // test (a 10s interval and an immediate read make a timer-based write impossible).
  flushExtensionExitFlushesSync();
  disposeUserFlush();

  const content = fs.readFileSync(path.join(dir, "agent.log"), "utf-8");
  assert.ok(content.includes("buffered-at-exit"), "the log extension's pending batch lands on the exit path");
  assert.ok(content.includes("user-exit-entry"), "an ordinary exit flush that logs must run BEFORE the sink finalizer");

  ext.dispose();
  assert.equal(ext.getAttachedSinkCount(), 0, "dispose releases every registered sink");

  const before = content.length;
  log.info("system", "after-dispose");
  flushExtensionExitFlushesSync();
  assert.equal(
    fs.readFileSync(path.join(dir, "agent.log"), "utf-8").length,
    before,
    "a disposed log extension must not keep flushing"
  );

  // The registry being empty is not enough: the *seam* has to be unbound too. Otherwise the log
  // keeps feeding a sink nobody owns — entries are neither written nor retained, and no later
  // flush can recover them. The log's own flush path is the probe, because it is independent of
  // the extension registry (which `dispose()` has already cleared either way).
  log.flushSync();
  assert.equal(
    fs.readFileSync(path.join(dir, "agent.log"), "utf-8").length,
    before,
    "a disposed log extension must leave the seam unbound (the sink must not be reachable)"
  );
  console.log("7. log extension flushes on the exit path, and stops after dispose: ok");
}

// ----------------------------------------------------------------------------
// 8. `settleTeardowns` drains a growable set: a teardown that enqueues *more* teardowns
//    (exactly what a subagent cascade does) is still awaited.
//    The assertion has to be "it did not resolve yet", not "the late one eventually ran" — a late
//    promise settles on its own either way. So generation 2 is gated: with a single
//    `Promise.allSettled` the call returns while it is still pending, which is the failure.
// ----------------------------------------------------------------------------
{
  const { AgentManager } = await import("../dist/index.mjs");
  const manager = new AgentManager();

  const settled = [];
  let releaseLate;
  const lateGate = new Promise((resolve) => {
    releaseLate = resolve;
  });

  // The snapshot `Promise.allSettled([...])` takes happens synchronously, before the first await,
  // so a teardown enqueued right after the call is *not* in generation 1 — only the loop can see it.
  manager.trackTeardown(Promise.resolve());
  const settling = manager.settleTeardowns();
  manager.trackTeardown(lateGate.then(() => settled.push("late")));

  let resolved = false;
  settling.then(() => {
    resolved = true;
  });
  await sleep(20);
  assert.equal(resolved, false, "settleTeardowns must not resolve while a during-settling teardown is still pending");

  releaseLate();
  await settling;
  assert.deepEqual(settled, ["late"], `the late teardown must be awaited, got [${settled.join(", ")}]`);
  console.log("8. settleTeardowns drains a growing set: ok");
}

// ----------------------------------------------------------------------------
// 9. A destroyed subagent releases its log sink (the extension registry shrinks).
//    Regression: `spawnSubagent` discarded the detach handle, so a subagent's sink stayed
//    registered for the life of the process and the parent log dir could never be removed.
// ----------------------------------------------------------------------------
{
  const { AgentManager, createLocalAgentSessionHost } = await import("../dist/index.mjs");
  const cascadeRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ext-cascade-"));
  clearCoreEnv();
  registerCoreEnv(createFsEnv(cascadeRoot));

  const manager = new AgentManager();
  const host = createLocalAgentSessionHost({ manager });
  const result = await host.create({ name: "cascade", model: "test-model" });
  const parentId = result.session.getSnapshot().agentId;

  const sub = await manager.spawnSubagent(parentId, { name: "sub" });
  const registrySize = () => manager.getLogExtension().getAttachedSinkCount();

  await sleep(300); // let the parent's session sink bind
  const withSub = registrySize();
  assert.ok(withSub >= 1, `subagent sink must be registered, got ${withSub}`);

  manager.destroyAgent(sub.id);
  await manager.settleTeardowns();
  assert.equal(
    registrySize(),
    withSub - 1,
    `destroying a subagent must release its sink (registry ${withSub} → ${registrySize()})`
  );

  manager.destroyAgent(parentId);
  await manager.settleTeardowns();
  assert.equal(registrySize(), 0, `destroying every agent must empty the sink registry, got ${registrySize()}`);

  // The regression's second half: with the sink released, the log directory can be removed.
  await fs.promises.rm(cascadeRoot, TEMP_RM_OPTIONS);
  console.log("9. subagent destroy releases its sink: ok");
}

// 10. The real `exit` wiring is exercised in a child process.
//     Sections 4/5 call `flushExtensionExitFlushesSync()` directly, which proves the registry but
//     not that `installAgentLogProcessGuards` is wired to it — deleting that call used to fail
//     nothing. The guards install `process.on("exit")`, so this runs in a child whose only job is
//     to leave a buffered entry and exit normally.
// ----------------------------------------------------------------------------
{
  const logDir = path.join(rootPath, ".agents/logs/ses_exit_wiring");
  fs.mkdirSync(logDir, { recursive: true });

  execFileSync(process.execPath, [path.resolve("scripts/helpers/exit-wiring-child.mjs"), rootPath, logDir], {
    cwd: path.resolve("."),
    stdio: "pipe",
  });

  const wrote = path.join(logDir, "agent.log");
  assert.ok(
    fs.existsSync(wrote),
    "the guards' real `exit` hook must flush the log extension (deleting the wiring call must fail here)"
  );
  assert.ok(fs.readFileSync(wrote, "utf-8").includes("written-on-real-exit"), "the buffered entry must land on exit");
  console.log("10. installAgentLogProcessGuards wires the extension flush on real exit: ok");
}

console.log("\nextension-flush validation passed");
