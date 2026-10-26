/**
 * Extension event observation — the read side of the extension event surface.
 *
 * The regression this guards is silent: interception (`ctx.events.on`) has always existed, so an
 * observation API that *looks* present but delivers nothing, delivers too much, or leaks across a
 * disable is easy to ship and hard to notice. Each positive assertion is therefore paired with an
 * inversion — a negative case that fails if the positive one would pass trivially.
 *
 * Covered:
 *   1. The observable set expands to every non-internal event and excludes the internal ones.
 *   2. `observe` delivers a declared event and its disposer unsubscribes.
 *   3. Retained replay: `observe` replays the current value synchronously; `{ replay: false }`
 *      suppresses it; `retained` reads on demand.
 *   4. `observeAny` receives declared events and does NOT receive `tool:chunk` / `extension:ui`,
 *      and does not replay retained values at subscribe time.
 *   5. The bus wildcard invariant: core has exactly one `on("*")` (the log consumer, which
 *      still owns the bridge's subscription while the bridge is being moved).
 *   6. Wildcard delivery excludes internal events: a wildcard listener never receives one, which
 *      is what keeps a subscriber that produces internal events from observing its own output.
 *   7. The declared internal set matches this validator's list in both directions, and no
 *      internal event carries an event→entry rule (the rule could never run — wildcard delivery
 *      withholds internal events — so the two tables must not disagree).
 *
 *   6. A throwing observer does not stop a second observer on the same event.
 *   7. A rejected observer promise is reported as `agent:extension-error` (observer phase) and
 *      never surfaces as an unhandled rejection.
 *   8. Disable unsubscribes observers; re-enable + re-register fires each handler exactly once.
 *   9. Observed payloads are the same object other consumers see (the read-only contract).
 *
 * Run: pnpm --filter @codent/core run validate:extension-event-observation
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  ExtensionRunner,
  EXTENSION_EVENT_VISIBILITY,
  createAgentEventBus,
  observableExtensionEvents,
  registerCoreEnv,
  DEFAULT_EVENT_LOG_RULES,
} from "../dist/dev.mjs";

// The runner resolves CoreEnv lazily; a stub keeps `getEnv()` from throwing in a host that builds
// a runner standalone (same idiom as validate-extension-pi-like.mjs).
registerCoreEnv({
  rootPath: "/workspace",
  getPlatform: async () => "test",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => "/home/test",
  fs: {
    readFile: async () => "",
    stat: async () => ({ isDirectory: false, isFile: false, size: 0, mtime: new Date() }),
    readdir: async () => [],
    writeFile: async () => {},
    mkdir: async () => {},
    exists: async () => false,
    remove: async () => {},
  },
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => ({ ok: true, status: 200 }),
});

const INTERNAL_EVENTS = ["tool:chunk", "tool:clear", "extension:ui"];

/** Build a runner on a bus we own, so the test can emit exactly what it wants to observe. */
async function withRunner(activate, run) {
  const bus = createAgentEventBus();
  const runner = new ExtensionRunner({ cwd: "/workspace", eventBus: bus });
  await runner.loadExtension({ id: "obs", name: "Obs", version: "1.0.0", activate });
  try {
    await run({ bus, runner });
  } finally {
    await runner.destroyAll();
  }
}

// --- 1. Observability table -------------------------------------------------
{
  const observable = observableExtensionEvents();
  const names = Object.keys(EXTENSION_EVENT_VISIBILITY);

  for (const type of INTERNAL_EVENTS) {
    assert.equal(
      EXTENSION_EVENT_VISIBILITY[type],
      "internal",
      `${type} must be classified internal (streaming/self-publish must not reach extensions)`
    );
    assert.ok(!observable.includes(type), `${type} must be absent from the observable expansion`);
    assert.ok(names.includes(type), `${type} must still be classified (completeness)`);
  }

  // Inversion: the expansion must not be the whole registry, or the internal rows do nothing.
  assert.ok(observable.length < names.length, "the observable set must be a strict subset of the registry");
  assert.ok(observable.length > 40, `the observable set should cover the telemetry surface, got ${observable.length}`);
  for (const expected of ["llm:response", "subagent:completed", "session:usage", "agent:extension-error"]) {
    assert.ok(observable.includes(expected), `${expected} must be observable`);
  }
  console.log("1. observability table: ok");
}

// --- 2. observe delivers + disposer ----------------------------------------
{
  const seen = [];
  let off;
  await withRunner(
    (ctx) => {
      off = ctx.events.observe("llm:response", (event) => seen.push(event.payload.model));
    },
    async ({ bus }) => {
      bus.emit("llm:response", { model: "alpha" });
      bus.emit("llm:response", { model: "beta" });
      assert.deepEqual(seen, ["alpha", "beta"], "observe delivers each emission");
      off();
      bus.emit("llm:response", { model: "gamma" });
      assert.deepEqual(seen, ["alpha", "beta"], "the returned disposer unsubscribes");
    }
  );
}
console.log("2. observe delivers + disposer: ok");

// --- 3. retained replay semantics ------------------------------------------
{
  const bus = createAgentEventBus();
  bus.retain("session:usage", () => ({ percent: 42 }));
  bus.emit("session:usage", { percent: 42 });

  const runner = new ExtensionRunner({ cwd: "/workspace", eventBus: bus });
  const replayed = [];
  const noReplay = [];
  const broad = [];
  let onDemand;
  await runner.loadExtension({
    id: "obs",
    name: "Obs",
    version: "1.0.0",
    activate(ctx) {
      ctx.events.observe("session:usage", (event) => replayed.push(event.payload.percent));
      ctx.events.observe("session:usage", (event) => noReplay.push(event.payload.percent), { replay: false });
      ctx.events.observeAny((event) => {
        if (event.type === "session:usage") broad.push(event.payload.percent);
      });
      onDemand = ctx.events.retained("session:usage");
    },
  });

  assert.deepEqual(replayed, [42], "observe replays the current retained value synchronously");
  assert.deepEqual(noReplay, [], "{ replay: false } suppresses the replay");
  assert.deepEqual(broad, [], "observeAny does not replay retained values");
  assert.equal(onDemand?.percent, 42, "retained() reads the current value on demand");

  bus.emit("session:usage", { percent: 55 });
  assert.deepEqual(replayed, [42, 55], "replay subscriber also receives later emissions");
  assert.deepEqual(noReplay, [55], "no-replay subscriber receives later emissions");
  await runner.destroyAll();
}
console.log("3. retained replay semantics: ok");

// --- 4. observeAny covers declared, excludes internal ----------------------
{
  const any = [];
  await withRunner(
    (ctx) => {
      ctx.events.observeAny((event) => any.push(event.type));
    },
    async ({ bus }) => {
      bus.emit("llm:response", { model: "m" });
      bus.emit("subagent:completed", { summary: "s" });
      bus.emit("session:usage", { percent: 1 });
      bus.emit("tool:chunk", { kind: "chunk", chunk: { type: "text", text: "x" } });
      bus.emit("extension:ui", { type: "notify", message: "hi" });

      assert.ok(any.includes("llm:response"), "observeAny receives llm:response");
      assert.ok(any.includes("subagent:completed"), "observeAny receives subagent:completed");
      assert.ok(any.includes("session:usage"), "observeAny receives session:usage");
      for (const type of INTERNAL_EVENTS) {
        assert.ok(!any.includes(type), `observeAny must not receive internal ${type}`);
      }
    }
  );
}
console.log("4. observeAny scope: ok");

// --- 6. wildcard delivery excludes internal events -------------------------
// The bus applies the visibility classification to wildcard fan-out, so a wildcard subscriber can
// never receive an internal event. That is what keeps a subscriber which itself produces internal
// events from observing its own output, and it makes wildcard delivery equivalent to
// `observeAny` — both mean "every observable event".
{
  const wildcard = [];
  const bus = createAgentEventBus();
  bus.on("*", (event) => wildcard.push(event.type));

  bus.emit("llm:response", { model: "m" });
  bus.emit("agent:stop", {});
  bus.emit("tool:chunk", { kind: "chunk", chunk: { type: "text", text: "x" } });
  bus.emit("extension:ui", { type: "notify", message: "hi" });

  assert.ok(wildcard.includes("llm:response"), "wildcard still receives business events");
  assert.ok(wildcard.includes("agent:stop"), "wildcard still receives business events (agent:stop)");
  for (const type of INTERNAL_EVENTS) {
    assert.ok(!wildcard.includes(type), `wildcard must NOT receive internal ${type}`);
  }
  console.log("6. wildcard excludes internal events: ok");
}

// --- 7. the declared internal set matches this validator's list ------------
// Both directions, so adding an internal event in core without adding it here fails — the
// property `extension-event-observation` promises for the classification table.
{
  const declaredInternal = Object.entries(EXTENSION_EVENT_VISIBILITY)
    .filter(([, v]) => v === "internal")
    .map(([k]) => k);
  assert.deepEqual(
    [...new Set(declaredInternal)].sort(),
    [...INTERNAL_EVENTS].sort(),
    "the internal set must match exactly — a new internal event must be added to this validator too"
  );
  console.log("7. internal set asserted both ways: ok");
}

// --- 7b. no internal event carries an event→entry rule ---------------------
// Wildcard delivery withholds internal events, and the event→entry consumer is the wildcard
// subscriber. So an internal event *with* a rule is an inconsistency: the rule exists, reads as if
// the event is logged, and can never run. Asserted here because the failure mode is silent — the
// event simply never appears in the log, which is indistinguishable from "nothing happened".
{
  const offenders = INTERNAL_EVENTS.filter((type) => {
    const rule = DEFAULT_EVENT_LOG_RULES[type];
    return rule !== undefined && rule !== false;
  });
  assert.deepEqual(
    offenders,
    [],
    `internal events must not carry an entry rule (the rule could never run): ${offenders.join(", ")}`
  );
  // Inversion: the lookup must be reading the real table, so a rule added to an internal event
  // would be found. `session:start` is the canary — it must have a rule.
  assert.ok(DEFAULT_EVENT_LOG_RULES["session:start"], "rule table lookup is live");
  console.log("7b. no internal event carries an entry rule: ok");
}

// --- 5. wildcard consumer invariant (source scan) --------------------------
{
  const srcRoot = path.resolve(process.cwd(), "src");
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        for (const line of fs.readFileSync(full, "utf8").split("\n")) {
          const trimmed = line.trim();
          // Skip doc-comment examples (JSDoc `* const x = bus.on("*", …)`), which are prose, not
          // call sites; a real second subscriber is never inside a comment.
          if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
          if (/\.on\(\s*"\*"/.test(line)) hits.push(`${path.relative(srcRoot, full)}: ${trimmed}`);
        }
      }
    }
  };
  walk(srcRoot);

  // Inversion: the scan must find the one legitimate consumer, or it is scanning the wrong tree and
  // would pass vacuously if the rule moved. The consumer stays a wildcard under the amended design
  // (D3): the bus now excludes internal events from wildcard delivery, so the recursion guard is
  // structural and no ~50-subscription expansion is needed.
  assert.equal(
    hits.length,
    1,
    `expected exactly one wildcard consumer in core, got ${hits.length}:\n${hits.join("\n")}`
  );
  if (!/event-log-bridge\.ts/.test(hits[0])) {
    assert.match(
      hits[0],
      /log\/extension\.ts/,
      `the wildcard consumer must be the log consumer (bridge or log extension), got ${hits[0]}`
    );
  }
  console.log("5. wildcard consumer invariant (source scan): ok");
}

// --- 6..9. throw isolation, failure reporting, teardown, payload identity ---
{
  const bus = createAgentEventBus();
  const runner = new ExtensionRunner({ cwd: "/workspace", eventBus: bus });
  const order = [];
  const failures = [];
  let payloadFromFirst;
  let payloadFromSecond;

  await runner.loadExtension({
    id: "first",
    name: "First",
    version: "1.0.0",
    activate(ctx) {
      ctx.events.observe("session:start", (event) => {
        order.push("first");
        payloadFromFirst = event.payload;
        throw new Error("observer boom");
      });
      ctx.events.observe("agent:extension-error", (event) => failures.push(event.payload.phase));
    },
  });
  await runner.loadExtension({
    id: "second",
    name: "Second",
    version: "1.0.0",
    activate(ctx) {
      ctx.events.observe("session:start", (event) => {
        order.push("second");
        payloadFromSecond = event.payload;
      });
    },
  });

  const startPayload = { cwd: "/workspace" };
  bus.emit("session:start", startPayload);

  // 6. A throwing observer must not starve the next observer on the same event.
  assert.deepEqual(order, ["first", "second"], "a throwing observer does not starve the next one");
  // 7. The failure is reported as agent:extension-error with the observer phase.
  assert.ok(
    failures.includes("event-observer"),
    `observer failure reported with phase event-observer, got ${JSON.stringify(failures)}`
  );
  // 9. Payload identity: both observers (and hence every other consumer) see the same object.
  assert.equal(payloadFromFirst, startPayload, "observer receives the emitted payload object itself");
  assert.equal(payloadFromSecond, startPayload, "a second observer receives the same object");
  console.log("6. throwing observer isolation + failure reporting + payload identity: ok");

  // 8. Disable stops observation; re-enable + re-register fires exactly once (no duplicates).
  order.length = 0;
  let res = await runner.setEnabled("second", false);
  assert.equal(res.ok, true, res.message);
  bus.emit("session:start", { cwd: "/workspace" });
  assert.deepEqual(order, ["first"], "a disabled extension stops receiving events");

  order.length = 0;
  res = await runner.setEnabled("second", true);
  assert.equal(res.ok, true, res.message);
  bus.emit("session:start", { cwd: "/workspace" });
  assert.deepEqual(order, ["first", "second"], "re-enabled extension fires once, not twice");
  console.log("7. disable stops / re-enable re-registers once: ok");

  await runner.destroyAll();
  order.length = 0;
  bus.emit("session:start", { cwd: "/workspace" });
  assert.deepEqual(order, [], "destroyAll unsubscribes every observer");
  console.log("8. destroyAll unsubscribes: ok");
}

// --- 7b. rejected observer promise is contained ------------------------------
{
  const bus = createAgentEventBus();
  const runner = new ExtensionRunner({ cwd: "/workspace", eventBus: bus });
  const failures = [];
  let unhandled = null;
  const onUnhandled = (reason) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);

  await runner.loadExtension({
    id: "reject",
    name: "Reject",
    version: "1.0.0",
    activate(ctx) {
      ctx.events.observe("session:start", async () => {
        throw new Error("async observer boom");
      });
      ctx.events.observe("agent:extension-error", (event) => failures.push(event.payload.phase));
    },
  });

  bus.emit("session:start", { cwd: "/workspace" });
  await new Promise((r) => setTimeout(r, 10));
  process.off("unhandledRejection", onUnhandled);

  assert.equal(unhandled, null, "a rejected observer must not become an unhandled rejection");
  assert.ok(
    failures.includes("event-observer"),
    `rejected observer reported with phase event-observer, got ${JSON.stringify(failures)}`
  );
  await runner.destroyAll();
  console.log("9. rejected observer promise is contained: ok");
}

// --- 10. a throwing interceptor is contained AND attributed ------------------
{
  const bus = createAgentEventBus();
  const runner = new ExtensionRunner({ cwd: "/workspace", eventBus: bus });
  const failures = [];
  let laterRan = false;

  await runner.loadExtension({
    id: "gate",
    name: "Gate",
    version: "1.0.0",
    activate(ctx) {
      ctx.registerInterceptor("tool:before:*", () => {
        throw new Error("interceptor boom");
      });
      ctx.events.observe("agent:extension-error", (event) => failures.push(event.payload));
    },
  });
  await runner.loadExtension({
    id: "after-gate",
    name: "After Gate",
    version: "1.0.0",
    activate(ctx) {
      ctx.registerInterceptor("tool:before:*", () => {
        laterRan = true;
      });
    },
  });

  await bus.intercept({ type: "tool:before:read_file", payload: {} });
  assert.equal(laterRan, true, "a throwing interceptor does not starve the rest of the chain");
  const reported = failures.find((row) => row.phase === "interceptor");
  assert.ok(reported, `interceptor failure reported, got ${JSON.stringify(failures)}`);
  assert.equal(reported.extensionId, "gate", "the report names the extension that owns the handler");
  assert.match(reported.error, /tool:before:\*/, "the report names the pattern");
  await runner.destroyAll();
  console.log("10. throwing interceptor is contained + attributed: ok");
}

console.log("extension-event-observation validation passed");
