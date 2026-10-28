/**
 * Validates the extension message-transform seam (change: add-extension-message-transform).
 *
 * Covers the contracts that are easy to get subtly wrong:
 *
 * 1. Registration semantics: disposer, replace-on-reregister, stale disposer is inert,
 *    disable stops transforming.
 * 2. Chaining in extension load order, with per-transformer failure isolation
 *    (throw / invalid return keep the last valid message set and do not abort the run).
 * 3. Placement: the transformer sees the wire the way the pipeline delivers it, and is
 *    invoked on LATER iterations too — not just the first call. The failure this guards
 *    against is a seam that reads/edits the engine's `config.messages` before the
 *    channel-anchored projection replaces them (the `max_tokens` continuation prompt
 *    has exactly this bug today: it survives the first call and is gone after).
 * 4. Zero-overhead: with no transformer registered the middleware returns no config
 *    change at all.
 *
 * Run: pnpm --filter @codent/core run validate:extension-message-transform
 */

import assert from "node:assert/strict";

import {
  ExtensionRunner,
  createAgentEventBus,
  createMessageTransformMiddleware,
  createWireRecoveryMiddleware,
  createStatusMiddleware,
  createApprovalResumeMiddleware,
  createLifecycleMiddleware,
  createCompactionMiddleware,
  createToolCompactMiddleware,
  createTurnContextMiddleware,
  createExtensionsMiddleware,
  createEarlyToolResultUiMiddleware,
  createTaskPreforkMiddleware,
  createPlanModeMiddleware,
  createTodoReminderMiddleware,
  createRepeatReminderMiddleware,
  createBackgroundMiddleware,
  createPromptCacheMiddleware,
  CANONICAL_MIDDLEWARE_ORDER,
  sortMiddlewaresByPhase,
  UsageTracker,
  MODEL_CAPABILITIES,
  MODEL_CAPABILITY_FLAGS,
} from "../dist/dev.mjs";

// ============================================================================
// Harness
// ============================================================================

function makeRunner(bus, log) {
  return new ExtensionRunner({
    cwd: "/workspace",
    eventBus: bus,
    log: log ?? null,
  });
}

/** Minimal ExtensionAPI stub: activates and registers whatever the body does. */
function extension(id, activate) {
  return {
    id,
    name: id,
    version: "0.0.0",
    description: `test extension ${id}`,
    activate,
  };
}

function msg(role, content) {
  return { role, content };
}

/** Messages shaped like a channel projection output (roles only; content is a marker). */
function wire(...roles) {
  return roles.map((role, i) => msg(role, `m${i}`));
}

/**
 * `capabilities` omitted means UNKNOWN (`undefined`, permissive); an explicit array means the
 * model declared exactly that set. The two are no longer the same thing, so this helper must
 * not default to `[]` — that would assert "supports nothing" and make every flag strict.
 */
function makeUsage({ capabilities } = {}) {
  const usage = new UsageTracker();
  usage.setCapabilities(capabilities);
  return usage;
}

const records = [];

async function runCase(name, fn) {
  try {
    await fn();
    records.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    records.push({ name, ok: false, error: err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err && err.message ? err.message : String(err)}`);
  }
}

// ============================================================================
// 1. Registration semantics
// ============================================================================

console.log("registration semantics");

await runCase("disposer unregisters the transformer", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  let calls = 0;
  const ext = extension("a", (ctx) => {
    ctx.registerMessageTransformer(() => {
      calls += 1;
      return wire("user");
    });
  });
  const instance = await runner.loadExtension(ext);
  assert.equal(runner.hasMessageTransformers(), true, "hasMessageTransformers true after register");

  await runner.applyMessageTransformers({ extensionId: "", agentId: "x", phase: "init", messages: wire("user") });
  assert.equal(calls, 1, "transformer invoked once");

  // Dispose via the stored disposer (re-activate is not how disable works).
  await runner.destroyExtension(instance);
  assert.equal(runner.hasMessageTransformers(), false, "hasMessageTransformers false after destroy");

  await runner.applyMessageTransformers({ extensionId: "", agentId: "x", phase: "init", messages: wire("user") });
  assert.equal(calls, 1, "transformer no longer invoked");
});

await runCase("re-registration replaces; stale disposer is inert", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  const seen = [];
  let disposeFirst;

  const ext = extension("a", (ctx) => {
    disposeFirst = ctx.registerMessageTransformer((c) => {
      seen.push("first");
      return [...c.messages, msg("user", "from-first")];
    });
    ctx.registerMessageTransformer((c) => {
      seen.push("second");
      return [...c.messages, msg("user", "from-second")];
    });
  });
  await runner.loadExtension(ext);

  const out = await runner.applyMessageTransformers({
    extensionId: "",
    agentId: "x",
    phase: "init",
    messages: wire("user"),
  });
  assert.deepEqual(seen, ["second"], "only the second transformer runs");
  assert.equal(out.at(-1).content, "from-second");

  // A stale disposer must not clear the newer registration.
  disposeFirst();
  assert.equal(runner.hasMessageTransformers(), true, "stale disposer leaves the newer transformer registered");

  seen.length = 0;
  const out2 = await runner.applyMessageTransformers({
    extensionId: "",
    agentId: "x",
    phase: "init",
    messages: wire("user"),
  });
  assert.deepEqual(seen, ["second"], "newer transformer still runs after stale dispose");
  assert.equal(out2.at(-1).content, "from-second");
});

await runCase("disabled extension stops transforming", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  let calls = 0;
  const ext = extension("a", (ctx) => {
    ctx.registerMessageTransformer(() => {
      calls += 1;
      return wire("user", "transformed");
    });
  });
  await runner.loadExtension(ext);

  await runner.applyMessageTransformers({ extensionId: "", agentId: "x", phase: "init", messages: wire("user") });
  assert.equal(calls, 1);

  const result = await runner.setEnabled("a", false);
  assert.equal(result.ok, true, "disable succeeded");
  assert.equal(runner.hasMessageTransformers(), false, "disable clears the transformer");

  await runner.applyMessageTransformers({ extensionId: "", agentId: "x", phase: "init", messages: wire("user") });
  assert.equal(calls, 1, "no transform while disabled");

  // Re-enabling re-runs activate(), which registers a fresh transformer.
  const reenabled = await runner.setEnabled("a", true);
  assert.equal(reenabled.ok, true, "re-enable succeeded");
  assert.equal(runner.hasMessageTransformers(), true, "re-enable restores the transformer");

  await runner.applyMessageTransformers({ extensionId: "", agentId: "x", phase: "init", messages: wire("user") });
  assert.equal(calls, 2, "transform runs again after re-enable");

  await runner.destroyAll();
  assert.equal(runner.hasMessageTransformers(), false, "destroyAll clears transformers");
});

// ============================================================================
// 2. Chaining + failure isolation
// ============================================================================

console.log("chaining and failure isolation");

await runCase("transformers chain in extension load order", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  const order = [];

  await runner.loadExtension(
    extension("a", (ctx) => {
      ctx.registerMessageTransformer((c) => {
        order.push("a");
        return [...c.messages, msg("user", "a")];
      });
    })
  );
  await runner.loadExtension(
    extension("b", (ctx) => {
      ctx.registerMessageTransformer((c) => {
        order.push("b");
        // Proves chaining: sees a's output.
        assert.equal(c.messages.at(-1).content, "a", "b receives a's output");
        return [...c.messages, msg("user", "b")];
      });
    })
  );

  const out = await runner.applyMessageTransformers({
    extensionId: "",
    agentId: "x",
    phase: "init",
    messages: wire("user"),
  });
  assert.deepEqual(order, ["a", "b"], "load order preserved");
  assert.deepEqual(
    out.map((m) => m.content),
    ["m0", "a", "b"]
  );
});

await runCase("throwing transformer keeps last valid messages and does not abort", async () => {
  const bus = createAgentEventBus();
  const errors = [];
  bus.on("agent:extension-error", (event) => errors.push(event.payload), { replay: false });
  const runner = makeRunner(bus);

  await runner.loadExtension(
    extension("boom", (ctx) => {
      ctx.registerMessageTransformer(() => {
        throw new Error("extension exploded");
      });
    })
  );
  await runner.loadExtension(
    extension("good", (ctx) => {
      ctx.registerMessageTransformer((c) => [...c.messages, msg("user", "good")]);
    })
  );

  const out = await runner.applyMessageTransformers({
    extensionId: "",
    agentId: "x",
    phase: "init",
    messages: wire("user"),
  });
  assert.deepEqual(
    out.map((m) => m.content),
    ["m0", "good"],
    "throwing transformer contributes nothing; later transformer still runs"
  );
  assert.equal(errors.length, 1, "one agent:extension-error emitted");
  assert.equal(errors[0].extensionId, "boom");
  assert.equal(errors[0].phase, "message-transform");
  assert.match(errors[0].error, /exploded/);
});

await runCase("invalid return is ignored and later transformers still run", async () => {
  const bus = createAgentEventBus();
  const errors = [];
  bus.on("agent:extension-error", (event) => errors.push(event.payload), { replay: false });
  const runner = makeRunner(bus);

  await runner.loadExtension(
    extension("bad-return", (ctx) => {
      ctx.registerMessageTransformer(() => "not an array");
    })
  );
  await runner.loadExtension(
    extension("bad-entries", (ctx) => {
      ctx.registerMessageTransformer(() => [{ content: "no role field" }]);
    })
  );
  await runner.loadExtension(
    extension("good", (ctx) => {
      ctx.registerMessageTransformer((c) => [...c.messages, msg("user", "good")]);
    })
  );

  const out = await runner.applyMessageTransformers({
    extensionId: "",
    agentId: "x",
    phase: "init",
    messages: wire("user"),
  });
  assert.deepEqual(
    out.map((m) => m.content),
    ["m0", "good"]
  );
  assert.equal(errors.length, 2, "both invalid returns reported");
  assert.deepEqual(
    errors.map((e) => e.extensionId),
    ["bad-return", "bad-entries"]
  );
});

await runCase("returning void leaves messages unchanged", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  await runner.loadExtension(
    extension("noop", (ctx) => {
      ctx.registerMessageTransformer(() => undefined);
    })
  );
  const input = wire("user", "assistant");
  const out = await runner.applyMessageTransformers({ extensionId: "", agentId: "x", phase: "init", messages: input });
  assert.deepEqual(out, input, "void return leaves the messages unchanged");
});

// ============================================================================
// 2b. Exclusive ownership — the wire seam's shared-array hazard
// ============================================================================
//
// The compact path is the only one handing out a non-owned array: the wire
// projection cache keeps the array it returns AND the engine's `applyMiddlewareConfig`
// assigns that same reference to its live message state. A transformer that mutates
// `ctx.messages` in place and returns void would therefore (a) leak its edit into the
// cached array, so the same call would not transform again on a later iteration, and
// (b) leave the mutation in the engine's retained state. These cases pin the ownership
// guarantee that makes the in-place style safe.

console.log("exclusive ownership");

await runCase("in-place mutation does not reach the array the caller retained", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  await runner.loadExtension(
    extension("inplace", (ctx) => {
      ctx.registerMessageTransformer((c) => {
        // Mutate the handed array and return void, i.e. keep using the array we own.
        c.messages[0].content = "MUTATED";
        return undefined;
      });
    })
  );

  // Exactly what the projection cache does: retain the array and hand it over.
  const cached = wire("user");
  const out = await runner.applyMessageTransformers({ extensionId: "", agentId: "x", phase: "init", messages: cached });

  assert.equal(out[0].content, "MUTATED", "the transformer's edit is applied to the wire it owns");
  assert.notEqual(
    cached[0].content,
    "MUTATED",
    "the caller-retained array must NOT be mutated — otherwise the edit leaks into the wire-projection cache"
  );
  assert.notEqual(out, cached, "the handed array must not be the caller's array");
});

await runCase("in-place mutation of a content PART does not reach the caller's message", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  await runner.loadExtension(
    extension("inplace-part", (ctx) => {
      ctx.registerMessageTransformer((c) => {
        const content = c.messages[0].content;
        content[0].text = "MUTATED";
        content[1].source.data = "MUTATED-IMAGE";
        content.push({ type: "text", text: "extra" });
        return undefined;
      });
    })
  );

  const original = {
    role: "user",
    content: [
      { type: "text", text: "original" },
      { type: "image", source: { type: "base64", data: "abc" } },
    ],
  };
  const out = await runner.applyMessageTransformers({
    extensionId: "",
    agentId: "x",
    phase: "init",
    messages: [original],
  });

  assert.equal(out[0].content[0].text, "MUTATED", "the transformer edits the wire it owns");
  assert.equal(original.content[0].text, "original", "the part object is a copy, not the caller's");
  assert.equal(original.content[1].source.data, "abc", "a nested part object is copied too");
  assert.equal(original.content.length, 2, "pushing a part does not grow the caller's array");
  assert.equal(out[0].content.length, 3);
});

await runCase("a NESTED ARRAY's element is copied, not shared", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  await runner.loadExtension(
    extension("inplace-nested-array", (ctx) => {
      ctx.registerMessageTransformer((c) => {
        const part = c.messages[0].content[0];
        // `output` is an array of objects (MCP content / tool results); a shallow array copy left
        // its elements shared with the channel, so this edit reached the persisted transcript.
        part.output[0].text = "MUTATED";
        part.metadata.tags.push("MUTATED");
        return undefined;
      });
    })
  );

  const original = {
    role: "user",
    content: [{ type: "text", text: "original", output: [{ type: "text", text: "inner" }], metadata: { tags: [] } }],
  };
  const out = await runner.applyMessageTransformers({
    extensionId: "",
    agentId: "x",
    phase: "init",
    messages: [original],
  });

  assert.equal(out[0].content[0].output[0].text, "MUTATED", "the transformer edits the wire it owns");
  assert.equal(original.content[0].output[0].text, "inner", "the array element is a copy, not the caller's");
  assert.deepEqual(original.content[0].metadata.tags, [], "a nested array inside an object is copied too");
});

await runCase("a cached array is transformed again on every call", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  let calls = 0;
  await runner.loadExtension(
    extension("inplace", (ctx) => {
      ctx.registerMessageTransformer((c) => {
        calls++;
        c.messages[0].content = `call-${calls}`;
        return undefined;
      });
    })
  );

  // Same array reference both times — the cache-hit shape across two iterations.
  const cached = wire("user");
  const first = await runner.applyMessageTransformers({
    extensionId: "",
    agentId: "x",
    phase: "init",
    messages: cached,
  });
  const second = await runner.applyMessageTransformers({
    extensionId: "",
    agentId: "x",
    phase: "iteration",
    messages: cached,
  });

  assert.equal(first[0].content, "call-1");
  assert.equal(
    second[0].content,
    "call-2",
    "the second call must transform the cached array again — a leaked in-place edit would make it a no-op"
  );
});

// ============================================================================
// 3. Middleware contract: placement + per-iteration invocation
// ============================================================================

console.log("middleware contract");

await runCase("placement: message-transform sits immediately after compaction", async () => {
  const idx = CANONICAL_MIDDLEWARE_ORDER.indexOf("message-transform");
  assert.notEqual(idx, -1, "registered in the canonical order");
  assert.equal(
    CANONICAL_MIDDLEWARE_ORDER.indexOf("compaction") + 1,
    idx,
    "adjacent to compaction — otherwise the channel projection discards its output"
  );
});

await runCase("zero overhead: no transformer → no config change", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus); // no extensions loaded
  const mw = createMessageTransformMiddleware({
    agentId: "x",
    getExtensionRunner: () => runner,
    getUsage: () => makeUsage(),
  });
  const config = { messages: wire("user") };
  const result = await mw.onConfig({ phase: "init" }, config);
  assert.ok(
    result === undefined || Object.keys(result).length === 0,
    "returns no config change so the pipeline behaves exactly as before"
  );
  assert.equal(config.messages, config.messages, "config untouched");
});

await runCase("invoked on every iteration, not just the first call", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  const phases = [];
  await runner.loadExtension(
    extension("t", (ctx) => {
      ctx.registerMessageTransformer((c) => {
        phases.push(c.phase);
        return [...c.messages, msg("user", `transformed-${c.phase}`)];
      });
    })
  );

  const mw = createMessageTransformMiddleware({
    agentId: "x",
    getExtensionRunner: () => runner,
    getUsage: () => makeUsage(),
  });

  // Call 1: init phase.
  const first = await mw.onConfig({ phase: "init" }, { messages: wire("user") });
  assert.equal(first.messages.length, 2, "first call transformed");

  // Call 2: a later iteration, after a tool result landed on the channel.
  const second = await mw.onConfig({ phase: "beforeModel" }, { messages: wire("user", "assistant", "tool") });
  assert.equal(second.messages.length, 4, "later iteration transformed too");

  assert.deepEqual(phases, ["init", "iteration"], "phase reported per call");

  // Call 3: restart-style retry — a fresh engine runs init again and must still transform.
  const retry = await mw.onConfig({ phase: "init" }, { messages: wire("user") });
  assert.equal(retry.messages.length, 2, "retry still transformed");
});

// ============================================================================
// 4. Wire-only contract at the seam
// ============================================================================
//
// The seam must be a pure function of its input: it replaces the array it returns and
// touches nothing else. That is what keeps transformer output out of the UI channel
// and the persisted session — the middleware writes only to `config.messages`, and the
// channel is written by `turn-context` / `background` and by the run
// itself, never from a middleware return value.

console.log("wire-only contract");

await runCase("the seam does not mutate its input and returns a distinct array", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  await runner.loadExtension(
    extension("rewrite", (ctx) => {
      ctx.registerMessageTransformer((c) => {
        // In-place style: mutate what we were handed, then return void.
        c.messages[0].content = "REWRITTEN";
        return undefined;
      });
    })
  );
  const mw = createMessageTransformMiddleware({
    agentId: "x",
    getExtensionRunner: () => runner,
    getUsage: () => makeUsage(),
  });

  const incoming = wire("user");
  const config = { messages: incoming };
  const result = await mw.onConfig({ phase: "init" }, config);

  assert.equal(result.messages[0].content, "REWRITTEN", "the model sees the transformed wire");
  assert.equal(incoming[0].content, "m0", "the incoming wire is untouched — nothing to persist");
  assert.notEqual(result.messages, incoming, "the replacement is a distinct array");
});

await runCase("with no transformer the incoming wire is passed through untouched", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  const mw = createMessageTransformMiddleware({
    agentId: "x",
    getExtensionRunner: () => runner,
    getUsage: () => makeUsage(),
  });

  const incoming = wire("user");
  const result = await mw.onConfig({ phase: "init" }, { messages: incoming });

  assert.ok(result === undefined || Object.keys(result).length === 0, "no config change at all");
  assert.equal(incoming[0].content, "m0", "incoming wire untouched");
});

await runCase("capability context is forwarded from the usage probe", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  const seen = [];
  await runner.loadExtension(
    extension("t", (ctx) => {
      ctx.registerMessageTransformer((c) => {
        seen.push({ unsupported: [...c.unsupportedPartTypes].sort(), vision: c.modelHasVision });
        return undefined;
      });
    })
  );

  // Model without vision → image unsupported.
  const noVision = createMessageTransformMiddleware({
    agentId: "x",
    getExtensionRunner: () => runner,
    getUsage: () => makeUsage({ capabilities: ["tool_calling"] }),
  });
  await noVision.onConfig({ phase: "init" }, { messages: wire("user") });

  // Unknown capabilities → permissive (nothing unsupported, vision available).
  // UNKNOWN is `undefined`; an empty array now means "declared, and none apply" (strict).
  const unknown = createMessageTransformMiddleware({
    agentId: "x",
    getExtensionRunner: () => runner,
    getUsage: () => makeUsage({}),
  });
  await unknown.onConfig({ phase: "init" }, { messages: wire("user") });

  assert.deepEqual(seen[0].unsupported, ["audio", "document", "image", "video"], "no vision → image stripped");
  assert.equal(seen[0].vision, false);
  assert.deepEqual(seen[1].unsupported, [], "unknown capabilities stay permissive");
  assert.equal(seen[1].vision, true, "unknown capabilities report vision available");
});

await runCase("capability context reflects the run's widened drop set", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  const seen = [];
  await runner.loadExtension(
    extension("w", (ctx) => {
      ctx.registerMessageTransformer((c) => {
        seen.push({ unsupported: [...c.unsupportedPartTypes].sort(), vision: c.modelHasVision });
        return undefined;
      });
    })
  );

  // The probe says this model takes everything (unknown capabilities stay permissive), but a
  // multimodal API rejection widened THIS run's strip to all four types. An extension deciding "can
  // this model see the image?" has to see that, or it leaves media in place that the strip — running
  // later on the same wire — removes anyway.
  const widened = createMessageTransformMiddleware({
    agentId: "x",
    getExtensionRunner: () => runner,
    getUsage: () => makeUsage({}),
    getWireDropPartTypes: () => new Set(["image", "audio", "video", "document"]),
  });
  await widened.onConfig({ phase: "init" }, { messages: wire("user") });

  assert.deepEqual(
    seen[0].unsupported,
    ["audio", "document", "image", "video"],
    "the run's widened set wins over the permissive probe"
  );
  assert.equal(seen[0].vision, true, "…while the declared flags still describe the model");

  // Armed but empty (the probe found nothing to drop) must not read as "everything unsupported".
  const empty = createMessageTransformMiddleware({
    agentId: "x",
    getExtensionRunner: () => runner,
    getUsage: () => makeUsage({}),
    getWireDropPartTypes: () => new Set(),
  });
  await empty.onConfig({ phase: "init" }, { messages: wire("user") });
  assert.deepEqual(seen[1].unsupported, [], "an empty armed set stays permissive");
});

/**
 * Capability → exposed flag, read from the source table rather than duplicated here.
 *
 * This is the point of `MODEL_CAPABILITY_FLAGS`: it is exhaustively keyed by
 * `ModelCapability`, so adding a capability to `models/types.ts` breaks compilation in the
 * extension types until it is named, and this script then iterates the new pair with no
 * edit at all. A hand-copied list here would go stale silently.
 */
const CAPABILITY_FLAGS = Object.entries(MODEL_CAPABILITY_FLAGS);

await runCase("the exposed modelHas* flag surface matches the capability source of truth", async () => {
  assert.deepEqual(
    [...MODEL_CAPABILITIES].sort(),
    Object.keys(MODEL_CAPABILITY_FLAGS).sort(),
    "every ModelCapability must be named in MODEL_CAPABILITY_FLAGS"
  );
  assert.equal(
    Object.keys(MODEL_CAPABILITY_FLAGS).length,
    CAPABILITY_FLAGS.length,
    "the flag table must cover every capability exactly once"
  );
});

await runCase("every exposed modelHas* flag tracks its ModelCapability", async () => {
  const bus = createAgentEventBus();
  const runner = makeRunner(bus);
  let ctx;
  await runner.loadExtension(
    extension("t", (c) => {
      c.registerMessageTransformer((c2) => {
        ctx = c2;
        return undefined;
      });
    })
  );

  // Declare exactly one capability: it must be the only non-permissive flag.
  for (const [cap] of CAPABILITY_FLAGS) {
    const mw = createMessageTransformMiddleware({
      agentId: "x",
      getExtensionRunner: () => runner,
      getUsage: () => makeUsage({ capabilities: [cap] }),
    });
    await mw.onConfig({ phase: "init" }, { messages: wire("user") });

    assert.deepEqual([...ctx.capabilities], [cap], `ctx.capabilities must carry the raw declared set for "${cap}"`);

    for (const [otherCap, otherFlag] of CAPABILITY_FLAGS) {
      const expected = otherCap === cap;
      assert.equal(
        ctx[otherFlag],
        expected,
        `ctx.${otherFlag} must be ${expected} when only "${cap}" is declared (flag coverage for "${otherCap}")`
      );
    }
  }

  // Every flag must default to permissive when the provider declared nothing.
  const unknown = createMessageTransformMiddleware({
    agentId: "x",
    getExtensionRunner: () => runner,
    getUsage: () => makeUsage({}),
  });
  await unknown.onConfig({ phase: "init" }, { messages: wire("user") });
  for (const [, flag] of CAPABILITY_FLAGS) {
    assert.equal(ctx[flag], true, `ctx.${flag} must be permissive when capabilities are unknown`);
  }
  assert.equal(ctx.capabilities, null, "ctx.capabilities is null when unknown — distinct from an empty set");

  // An explicitly EMPTY declaration is the opposite: resolved, and none apply, so every flag is
  // strict. This is the distinction the whole `undefined` vs `[]` split exists to make reachable.
  const declaredNone = createMessageTransformMiddleware({
    agentId: "x",
    getExtensionRunner: () => runner,
    getUsage: () => makeUsage({ capabilities: [] }),
  });
  await declaredNone.onConfig({ phase: "init" }, { messages: wire("user") });
  for (const [, flag] of CAPABILITY_FLAGS) {
    assert.equal(ctx[flag], false, `ctx.${flag} must be strict when the model declared none of them`);
  }
  assert.equal(ctx.capabilities.size, 0, "ctx.capabilities is an empty set when none were declared");
  assert.notEqual(ctx.capabilities, null, "an empty declaration must not be reported as unknown");
});

await runCase("pipeline assembles with the new middleware in canonical order", async () => {
  const stub = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "then") return undefined;
      return stub;
    },
    apply() {
      return stub;
    },
  });
  const assembled = [
    createStatusMiddleware(stub),
    createApprovalResumeMiddleware(stub),
    createLifecycleMiddleware(stub),
    createCompactionMiddleware(stub),
    createMessageTransformMiddleware(stub),
    createToolCompactMiddleware(stub),
    createWireRecoveryMiddleware(stub),
    createTurnContextMiddleware(stub),
    createExtensionsMiddleware(stub),
    createEarlyToolResultUiMiddleware(stub),
    createTaskPreforkMiddleware(stub),
    createPlanModeMiddleware(stub),
    createTodoReminderMiddleware(stub),
    createRepeatReminderMiddleware(stub),
    createBackgroundMiddleware(stub),
    createPromptCacheMiddleware(stub),
  ];
  const sorted = sortMiddlewaresByPhase(assembled, () => {});
  assert.deepEqual(
    sorted.map((m) => m.name),
    [...CANONICAL_MIDDLEWARE_ORDER],
    "phase sort resolves to the canonical order"
  );
});

// ============================================================================
// Summary
// ============================================================================

const failed = records.filter((r) => !r.ok);
console.log("");
if (failed.length > 0) {
  console.error(`extension-message-transform validation FAILED (${failed.length}/${records.length})`);
  for (const f of failed) console.error(`  - ${f.name}: ${f.error?.message ?? f.error}`);
  process.exit(1);
}
console.log(`extension-message-transform validation passed (${records.length} cases)`);
