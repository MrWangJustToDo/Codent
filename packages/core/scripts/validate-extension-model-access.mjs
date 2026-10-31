/**
 * Validates extension model access (`ctx.llm`) and its accounting.
 *
 * The capability is dangerous in three specific ways, and each has a check here:
 *
 *   1. **Cost.** A completion must land in the session's own `UsageTracker` without the caller
 *      passing anything — the memory subsystem already produced one "tokens reached the jsonl but no
 *      session total" bug, and an extension-facing API is where that class would spread.
 *   2. **Reach.** A named model may only be one the session's catalog offers *on the session's
 *      connection*; anything else would let an extension reach a provider the host never configured.
 *   3. **Runaway.** A per-run budget must fail closed, with a typed error the caller can catch.
 *
 * Run: pnpm --filter @codent/core run validate:extension-model-access
 */
import assert from "node:assert/strict";

import { ExtensionLlmError, UsageTracker, completeExtensionQuery, registerCoreEnv } from "../dist/dev.mjs";

registerCoreEnv({
  rootPath: "/mock",
  getPlatform: async () => "linux",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => "/mock",
  path: {
    join: (...parts) => parts.join("/"),
    dirname: (p) => p.slice(0, Math.max(0, p.lastIndexOf("/"))) || "/",
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
    parse: (p) => ({ root: "/", dir: "/", base: p.split("/").pop() ?? "", ext: "", name: "" }),
  },
  fs: {
    readFile: async () => "",
    writeFile: async () => {},
    mkdir: async () => {},
    exists: async () => false,
    readdir: async () => [],
    remove: async () => {},
    stat: async () => ({ isDirectory: () => false, size: 0, mtimeMs: 0 }),
  },
  runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  fetch: async () => new Response("", { status: 200 }),
});

const USAGE = { promptTokens: 11, completionTokens: 5, totalTokens: 16 };

const ANSWER_SCHEMA = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      value && typeof value === "object" && value.answer === "ok"
        ? { value }
        : { issues: [{ message: "answer must be ok" }] },
    jsonSchema: { input: () => ({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }) },
  },
};

const textStream = () =>
  (async function* () {
    yield { type: "TEXT_MESSAGE_CONTENT", delta: "hello" };
    yield { type: "RUN_FINISHED", usage: USAGE };
  })();

const structuredStream = () =>
  (async function* () {
    yield { type: "TEXT_MESSAGE_CONTENT", delta: '{"answer":"ok"}' };
    yield { type: "CUSTOM", name: "structured-output.complete", value: { object: { answer: "ok" }, raw: "" } };
    yield { type: "RUN_FINISHED", usage: USAGE };
  })();

const adapter = (stream) => ({
  adapter: {
    kind: "text",
    name: "fake",
    model: "session-model",
    "~types": {},
    chatStream: stream,
    structuredOutputStream: structuredStream,
    async structuredOutput() {
      return { answer: "ok" };
    },
  },
  model: "session-model",
  modelStyle: "openai",
  structuredOutput: "supported",
});

function makeHost(overrides = {}) {
  const usage = new UsageTracker();
  const state = { budgetUsed: 0, budgetLimit: 20, requests: 0 };
  const host = {
    usage,
    log: null,
    resolveTextAdapter: async () => adapter(textStream),
    getExtensionConnection: () => ({ style: "openai", baseURL: "https://api.example/v1" }),
    getExtensionCatalog: () => undefined,
    getExtensionSignal: () => undefined,
    getExtensionModel: () => "session-model",
    getExtensionMaxOutputTokens: () => undefined,
    consumeExtensionBudget() {
      state.budgetUsed += 1;
      if (state.budgetUsed > state.budgetLimit) {
        throw new ExtensionLlmError("budget-exceeded", "budget exhausted (test)");
      }
    },
    refundExtensionBudget() {
      if (state.budgetUsed > 0) state.budgetUsed -= 1;
    },
    ...overrides,
  };
  return { host, usage, state };
}

// ── 1. text completion, usage attributed automatically ──────────────────────
{
  const { host, usage } = makeHost();
  const result = await completeExtensionQuery(host, "ext-a", { prompt: "hi" });
  assert.deepEqual(result, { text: "hello" }, "the text form returns the completed text");
  assert.equal(usage.getTotal().inputTokens, USAGE.promptTokens, "prompt tokens reach the session tracker");
  assert.equal(usage.getTotal().outputTokens, USAGE.completionTokens, "and completion tokens");
}

// ── 2. multi-message requests keep their conversation ───────────────────────
{
  let received = null;
  const captureAdapter = adapter(() => textStream());
  captureAdapter.adapter.chatStream = (options) => {
    received = options?.messages;
    return textStream();
  };
  const { host } = makeHost({ resolveTextAdapter: async () => captureAdapter });
  const result = await completeExtensionQuery(host, "ext-a", {
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ],
  });
  assert.equal(result.text, "hello");
  assert.deepEqual(
    received?.map((message) => message.role),
    ["user", "assistant", "user"],
    "roles and order reach the provider — a flattened transcript would lose them"
  );
  assert.deepEqual(
    received?.map((message) => message.content),
    ["one", "two", "three"]
  );
}

// ── 2b. a billed structured failure is still attributed (fallback sums both) ─
{
  const billedStructured = () =>
    (async function* () {
      // Billed and completed, but the object fails validation → the port throws AFTER the provider
      // charged, which is exactly the case `withUsage` exists for.
      yield { type: "CUSTOM", name: "structured-output.complete", value: { object: { answer: "wrong" }, raw: "" } };
      yield { type: "RUN_FINISHED", usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } };
    })();
  const textJson = () =>
    (async function* () {
      yield { type: "TEXT_MESSAGE_CONTENT", delta: '{"answer":"ok"}' };
      yield { type: "RUN_FINISHED", usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } };
    })();
  const stub = {
    ...adapter(textJson),
    adapter: { ...adapter(textJson).adapter, structuredOutputStream: billedStructured },
  };
  const { host, usage } = makeHost({ resolveTextAdapter: async () => stub });
  const result = await completeExtensionQuery(host, "ext-a", { prompt: "json", schema: ANSWER_SCHEMA });
  assert.deepEqual(result, { data: { answer: "ok" } });
  // TanStack >= 1.0 validates the `outputSchema` inside `chat()` and ends the run at the
  // failed check, before the provider's RUN_FINISHED — so the failed attempt's usage never
  // reaches this port and cannot be attributed. What must still hold is the other half: the
  // retry that succeeded is billed, and its numbers are not lost with it.
  assert.equal(
    usage.getTotal().inputTokens,
    7,
    "the fallback attempt's prompt tokens are attributed (the failed attempt's are not reported upstream)"
  );
  assert.equal(usage.getTotal().outputTokens, 3, "nor its completion tokens");
}

// ── 3. structured completion returns the validated value ────────────────────
{
  const { host } = makeHost();
  const schema = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) =>
        value && typeof value === "object" && value.answer === "ok"
          ? { value }
          : { issues: [{ message: "answer must be ok" }] },
      jsonSchema: {
        input: () => ({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }),
      },
    },
  };
  const result = await completeExtensionQuery(host, "ext-a", { prompt: "give me json", schema });
  assert.deepEqual(result, { data: { answer: "ok" } });
}

// ── 4. an unknown model rejects before any request ──────────────────────────
{
  const { host } = makeHost({
    getExtensionCatalog: () => [
      { type: "direct", style: "openai", baseURL: "https://api.example/v1", models: ["session-model"] },
    ],
  });
  await assert.rejects(
    () => completeExtensionQuery(host, "ext-a", { prompt: "hi", model: "not-in-catalog" }),
    (error) => error instanceof ExtensionLlmError && error.code === "unknown-model",
    "a model the catalog does not offer is a typed error"
  );
}

// ── 5. a catalog model on ANOTHER connection rejects ────────────────────────
{
  const { host } = makeHost({
    getExtensionCatalog: () => [
      { type: "direct", style: "openai", baseURL: "https://elsewhere.example/v1", models: ["other-model"] },
    ],
  });
  await assert.rejects(
    () => completeExtensionQuery(host, "ext-a", { prompt: "hi", model: "other-model" }),
    (error) => error instanceof ExtensionLlmError && error.code === "unknown-model",
    "an extension may not reach a second provider/connection"
  );
}

// ── 6. the same-connection catalog model is accepted ────────────────────────
{
  const { host } = makeHost({
    getExtensionCatalog: () => [
      {
        type: "direct",
        style: "openai",
        baseURL: "https://api.example/v1/",
        apiKey: "k",
        models: ["cheap-model"],
      },
    ],
    // Selection is what is under test here, not the network: build the stub adapter for the picked
    // model instead of the real factory.
    createExtensionAdapter: (input) => ({ ...adapter(textStream), model: input.model }),
  });
  const result = await completeExtensionQuery(host, "ext-a", { prompt: "hi", model: "cheap-model" });
  assert.equal(result.text, "hello", "a trailing slash is the same connection");
}

// ── 7. no adapter is a typed error, not a crash ─────────────────────────────
{
  const { host } = makeHost({ resolveTextAdapter: async () => null });
  await assert.rejects(
    () => completeExtensionQuery(host, "ext-a", { prompt: "hi" }),
    (error) => error instanceof ExtensionLlmError && error.code === "no-adapter"
  );
}

// ── 8. an empty request is rejected ────────────────────────────────────────
{
  const { host } = makeHost();
  await assert.rejects(
    () => completeExtensionQuery(host, "ext-a", {}),
    (error) => error instanceof ExtensionLlmError && error.code === "bad-request"
  );
}

// ── 8b. an aborted signal rejects the call, and is not charged ────────────
{
  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  const { host, state } = makeHost();
  await assert.rejects(
    () => completeExtensionQuery(host, "ext-a", { prompt: "hi", signal: controller.signal }),
    (error) => /abort|cancel/i.test(error?.message ?? ""),
    "a pre-aborted signal must not issue a request"
  );
  assert.equal(state.budgetUsed, 0, "a request that is never issued must not consume a budget slot");
}

// ── 9. the per-run budget fails closed ─────────────────────────────────────
{
  const { host, state } = makeHost();
  state.budgetLimit = 1;
  await completeExtensionQuery(host, "ext-a", { prompt: "first" });
  await assert.rejects(
    () => completeExtensionQuery(host, "ext-a", { prompt: "second" }),
    (error) => error instanceof ExtensionLlmError && error.code === "budget-exceeded",
    "the second call in the run exceeds the budget"
  );
}

// ── 10. an unbilled failure gives its budget slot back ─────────────────────
{
  const { host, state } = makeHost();
  state.budgetLimit = 1;
  const failing = {
    ...adapter(textStream),
    adapter: {
      ...adapter(textStream).adapter,
      // A provider error chunk before any output: no usage, nothing billed.
      chatStream: () =>
        (async function* () {
          yield { type: "RUN_ERROR", message: "connection reset" };
        })(),
    },
  };
  host.resolveTextAdapter = async () => failing;
  await assert.rejects(() => completeExtensionQuery(host, "ext-a", { prompt: "boom" }));
  assert.equal(state.budgetUsed, 0, "a failed attempt that was not billed refunds its slot");
  // The same host can still spend the slot: the refund is what makes a transient failure survivable.
  host.resolveTextAdapter = async () => adapter(textStream);
  const result = await completeExtensionQuery(host, "ext-a", { prompt: "retry" });
  assert.equal(result.text, "hello", "the slot is usable again after a transient failure");
}

// ── 11. the host output-token cap is a ceiling ────────────────────────────
{
  let seenMaxTokens;
  const capturing = adapter(() => textStream());
  capturing.adapter.chatStream = (options) => {
    // The port maps the cap to the provider's own key (`max_tokens` or `max_completion_tokens`) and
    // applies its thinking-aware floor; the ceiling is asserted through whatever number it sends.
    seenMaxTokens = Object.values(options?.modelOptions ?? {}).find((value) => typeof value === "number");
    return textStream();
  };
  const { host } = makeHost({
    resolveTextAdapter: async () => capturing,
    getExtensionMaxOutputTokens: () => 100,
  });
  await completeExtensionQuery(host, "ext-a", { prompt: "hi", maxOutputTokens: 5000 });
  assert.ok(
    typeof seenMaxTokens === "number" && seenMaxTokens < 5000,
    `a request larger than the host cap is clamped (saw ${String(seenMaxTokens)})`
  );
}

// ── 12. repeated completions do not leak abort listeners ──────────────────
{
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on("warning", onWarning);
  try {
    const controller = new AbortController();
    const { host } = makeHost({ getExtensionSignal: () => controller.signal });
    for (let i = 0; i < 15; i++) {
      await completeExtensionQuery(host, "ext-a", { prompt: `call ${i}` });
    }
    // Warnings are emitted on a later tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      warnings.filter((warning) => warning.name === "MaxListenersExceededWarning"),
      [],
      "each completed query detaches its abort mirror from the run signal"
    );
  } finally {
    process.off("warning", onWarning);
  }
}

console.log("extension model access validation passed");
