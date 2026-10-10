/**
 * Validates websearch helpers: domain filter, abort-timeout wiring, provider registry,
 * selection/spreading, keyed-vs-free transport, and fallback naming.
 *
 * Run: pnpm --filter @codent/core run validate:websearch-providers
 */

import assert from "node:assert/strict";

import {
  clearCoreEnv,
  createTimeoutAbort,
  filterResultsByDomain,
  getProviderManager,
  hashToIndex,
  initializeProviders,
  normalizeRawGlobalToolConfig,
  parseMcpResponse,
  parseModelsConfig,
  parseParallelResults,
  PROVIDER_KEY_FIELDS,
  PROVIDER_REGISTRY,
  registerCoreEnv,
  resetWebsearchProviders,
} from "../dist/dev.mjs";
// The cancel verdict is a render-layer reader and lives on the public entry, not the
// internal one — same split as validate-cancel-semantics.mjs.
import { isAbortError } from "../dist/index.mjs";

// Domain filter
const results = [
  { title: "GH", snippet: "", url: "https://github.com/foo" },
  { title: "SO", snippet: "", url: "https://stackoverflow.com/q/1" },
  { title: "Pin", snippet: "", url: "https://www.pinterest.com/x" },
  { title: "Bad", snippet: "", url: "not-a-url" },
];

assert.deepEqual(
  filterResultsByDomain(results, ["github.com"]).map((r) => r.title),
  ["GH"]
);
assert.deepEqual(
  filterResultsByDomain(results, undefined, ["pinterest.com"]).map((r) => r.title),
  ["GH", "SO", "Bad"]
);
assert.equal(
  filterResultsByDomain(results, ["github.com"]).some((r) => r.title === "Bad"),
  false
);

// Abort + timeout: external abort cancels controller.signal
{
  const external = new AbortController();
  const { controller, cleanup } = createTimeoutAbort({ timeoutMs: 60_000, signal: external.signal });
  assert.equal(controller.signal.aborted, false);
  external.abort();
  assert.equal(controller.signal.aborted, true);
  cleanup();
}

// Already-aborted external signal
{
  const external = new AbortController();
  external.abort();
  const { controller, cleanup } = createTimeoutAbort({ timeoutMs: 60_000, signal: external.signal });
  assert.equal(controller.signal.aborted, true);
  cleanup();
}

// The timeout must abort with a REASON that is not a cancel.
//
// A bare `controller.abort()` makes `fetch` reject with the platform's `AbortError`, and
// `isAbortError` accepts that by `name` alone — so a pure timeout settled as "cancelled by
// user" and the model was told `[Search cancelled by user.] <query>` for a search nobody
// stopped. Asserting `isAbortError` on the signal's reason is what pins it: it is the same
// predicate the tools and the presentation layer use to decide "cancel or failure".
{
  const external = new AbortController();
  const { controller, cleanup } = createTimeoutAbort({ timeoutMs: 1, signal: external.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(controller.signal.aborted, true, "the timeout still aborts");
  assert.equal(
    isAbortError(controller.signal.reason, external.signal),
    false,
    "a timeout must NOT read as a user cancel (the run signal is still live)"
  );
  cleanup();

  // …and the user-abort path must keep reading as a cancel, or the fix traded one
  // false negative for a false positive.
  const run = new AbortController();
  const aborted = createTimeoutAbort({ timeoutMs: 60_000, signal: run.signal });
  run.abort();
  assert.equal(aborted.controller.signal.aborted, true, "an external abort still aborts");
  assert.equal(
    isAbortError(aborted.controller.signal.reason, run.signal),
    true,
    "a user abort must still read as a cancel"
  );
  aborted.cleanup();
}

// ============================================================================
// Provider registry
// ============================================================================

// The table IS the registration order and the key wiring. A provider dropped from it (or
// reordered) must fail here before it can silently change selection.
assert.deepEqual(
  PROVIDER_REGISTRY.map((r) => r.name),
  ["brave", "parallel", "exa", "tavily", "duckduckgo"],
  "registry order defines preference + fallback"
);
// Key wiring is the single source `ProviderManager.configure` reads; pin it so a provider added
// to the registry without a key field (or vice versa) surfaces here rather than as "key ignored".
assert.deepEqual(
  PROVIDER_KEY_FIELDS,
  { brave: "braveApiKey", parallel: "parallelApiKey", exa: "exaApiKey", tavily: "tavilyApiKey" },
  "key fields are the single key-wiring source"
);
for (const name of PROVIDER_REGISTRY.map((r) => r.name)) {
  assert.ok(name !== "duckduckgo" || !(name in PROVIDER_KEY_FIELDS), "a pure-free provider has no key field");
}

// ============================================================================
// Stubbed CoreEnv
// ============================================================================

let lastUrl = "";
const stubEnv = {
  rootPath: "/tmp",
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => "/tmp",
  fs: {
    readFile: async () => "",
    writeFile: async () => {},
    mkdir: async () => {},
    exists: async () => false,
    readdir: async () => [],
    stat: async () => ({ isDirectory: false, isFile: true, size: 0, mtime: new Date() }),
    remove: async () => {},
  },
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async (url) => {
    lastUrl = String(url);
    // Exa MCP — SSE framing with a Google-style `Highlights:` body.
    if (lastUrl.includes("mcp.exa.ai")) {
      const payload = {
        result: {
          content: [
            {
              type: "text",
              text: [
                "Title: Example",
                "URL: https://example.com",
                "Highlights:",
                "Hello from Exa",
                "---",
                "Title: Second",
                "URL: https://second.example.com",
                "Content:",
                "Another body",
              ].join("\n"),
            },
          ],
        },
      };
      return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    // Parallel MCP — JSON-in-text `{ results: [{ url, title, excerpts }] }`.
    if (lastUrl.includes("search.parallel.ai")) {
      const payload = {
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: [{ url: "https://parallel.example.com", title: "Parallel One", excerpts: ["From Parallel"] }],
              }),
            },
          ],
        },
      };
      return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    // Tavily REST — `{ results: [{ title, url, content }] }`.
    if (lastUrl.includes("api.tavily.com")) {
      return new Response(
        JSON.stringify({
          results: [{ title: "Tavily One", url: "https://tavily.example.com", content: "From Tavily" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    // Brave official API — `{ web: { results: [{ title, url, description }] } }`.
    if (lastUrl.includes("api.search.brave.com")) {
      return new Response(
        JSON.stringify({
          web: { results: [{ title: "Brave One", url: "https://brave.example.com", description: "From Brave" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    // Everything else — DuckDuckGo HTML.
    return new Response(
      `<div class="result web-result"><a class="result__a" href="https://example.com">Example</a><a class="result__snippet">Hi</a></div>`,
      { status: 200, headers: { "content-type": "text/html" } }
    );
  },
};

resetWebsearchProviders();
registerCoreEnv(stubEnv);

try {
  initializeProviders();
  const pm = getProviderManager();

  // No keys → brave + tavily are unavailable, so first available free provider wins.
  assert.equal((await pm.selectProvider()).name, "parallel");

  // Tavily has no free transport: unavailable without a key.
  const tavilyInfo = (await pm.listProviders()).find((p) => p.name === "tavily");
  assert.equal(tavilyInfo.available, false, "tavily must be unavailable without a key");
  const braveInfo = (await pm.listProviders()).find((p) => p.name === "brave");
  assert.equal(braveInfo.available, false, "brave must be unavailable without a key");

  // Parallel free transport parses its JSON-in-text payload.
  const parallelOutcome = await pm.search("test query", { maxResults: 3, timeoutMs: 5000 });
  assert.equal(parallelOutcome.provider, "parallel");
  assert.equal(parallelOutcome.results[0].url, "https://parallel.example.com");
  assert.equal(parallelOutcome.results[0].title, "Parallel One");
  assert.equal(parallelOutcome.results[0].snippet, "From Parallel");
  assert.equal(lastUrl.includes("apiKey="), false, "free transport carries no key");

  // Explicitly prefer exa — still selectable, parses the MCP payload.
  pm.configure({ provider: "exa" });
  assert.equal((await pm.selectProvider()).name, "exa");
  const exaOutcome = await pm.search("test query", { maxResults: 3, timeoutMs: 5000 });
  assert.equal(exaOutcome.provider, "exa");
  assert.equal(exaOutcome.results[0].url, "https://example.com");
  assert.equal(exaOutcome.results[0].snippet, "Hello from Exa");
  assert.equal(exaOutcome.results[1].url, "https://second.example.com");
  assert.equal(exaOutcome.results[1].snippet, "Another body");
  assert.equal(lastUrl.includes("exaApiKey="), false, "exa free transport carries no key");

  // Explicitly prefer duckduckgo — still selectable and parses HTML.
  pm.configure({ provider: "duckduckgo" });
  assert.equal((await pm.selectProvider()).name, "duckduckgo");
  const ddg = await pm.search("test query", { maxResults: 3, timeoutMs: 5000 });
  assert.equal(ddg.provider, "duckduckgo");
  assert.equal(ddg.results[0].url, "https://example.com");

  // A Brave key makes Brave available…
  pm.configure({ braveApiKey: "test-key" });
  assert.equal(
    (await pm.listProviders()).find((p) => p.name === "brave").available,
    true,
    "brave becomes available with a key"
  );
  // …and it is SELECTED, even with a session id set (a configured key must not be swallowed
  // by the free-provider spread). This is the regression the audit found. The session id is
  // chosen so the raw spread over the available providers would NOT land on brave, so this
  // assertion fails if the keyed-priority branch is removed.
  let keyedSid = "";
  for (let i = 0; i < 50; i++) {
    if (hashToIndex(`ses_keyed_${i}`, 4) !== 0) {
      keyedSid = `ses_keyed_${i}`;
      break;
    }
  }
  assert.notEqual(keyedSid, "", "test setup: found a session id hashing off brave");
  pm.setSessionId(keyedSid);
  assert.equal((await pm.selectProvider()).name, "brave", "a configured keyed provider wins auto-selection");
  const braveOutcome = await pm.search("test query", { maxResults: 3, timeoutMs: 5000 });
  assert.equal(braveOutcome.provider, "brave");
  assert.ok(lastUrl.includes("api.search.brave.com"), "brave uses its official API");
} finally {
  clearCoreEnv();
  resetWebsearchProviders();
}

// With NO key, the same session id must NOT be pinned to brave (spread stays in the free pool),
// proving the keyed-priority branch and the spread branch are mutually exclusive.
resetWebsearchProviders();
registerCoreEnv(stubEnv);
try {
  initializeProviders();
  const pm = getProviderManager();
  pm.setSessionId("ses_keyed_priority");
  assert.notEqual((await pm.selectProvider()).name, "brave", "without a key brave is not selected");
} finally {
  clearCoreEnv();
  resetWebsearchProviders();
}

// ============================================================================
// Unavailable provider is skipped (explicit + auto)
// ============================================================================

resetWebsearchProviders();
registerCoreEnv(stubEnv);
try {
  initializeProviders();
  const pm = getProviderManager();
  // Explicitly prefer a provider that needs a key we do not have → must NOT be selected;
  // selection falls through to an available provider.
  pm.configure({ provider: "tavily" });
  const picked = await pm.selectProvider();
  assert.notEqual(picked.name, "tavily", "an explicit preference for an unavailable provider is skipped");
  assert.ok(["parallel", "exa", "duckduckgo"].includes(picked.name), "falls through to an available free provider");
} finally {
  clearCoreEnv();
  resetWebsearchProviders();
}

// ============================================================================
// Failure fallback + all-failed error
// ============================================================================

{
  resetWebsearchProviders();
  const pm = getProviderManager();
  const results = { results: [{ title: "OK", url: "https://ok.example.com", snippet: "" }] };
  const calls = [];
  pm.register({
    name: "p_fail",
    isAvailable: async () => true,
    search: async () => {
      calls.push("p_fail");
      throw new Error("boom");
    },
  });
  pm.register({
    name: "p_ok",
    isAvailable: async () => true,
    search: async () => {
      calls.push("p_ok");
      return results.results;
    },
  });

  // Selected provider fails → the NEXT available provider produces the result, and the
  // reported provider is the one that actually ran.
  const outcome = await pm.search("q");
  assert.equal(outcome.provider, "p_ok", "fallback returns the provider that succeeded");
  assert.deepEqual(calls, ["p_fail", "p_ok"], "the failing provider is tried first, then the next");
  resetWebsearchProviders();
}

{
  resetWebsearchProviders();
  const pm = getProviderManager();
  pm.register({
    name: "p_a",
    isAvailable: async () => true,
    search: async () => {
      throw new Error("first");
    },
  });
  pm.register({
    name: "p_b",
    isAvailable: async () => true,
    search: async () => {
      throw new Error("second");
    },
  });
  await assert.rejects(
    () => pm.search("q"),
    (error) => /All search providers failed/.test(error.message) && /second/.test(error.message),
    "all providers failing surfaces one error naming the last failure"
  );
  resetWebsearchProviders();
}

// ============================================================================
// MCP isError → failure (not a successful empty search)
// ============================================================================

assert.throws(
  () =>
    parseMcpResponse(
      `event: message\ndata: ${JSON.stringify({ result: { content: [{ text: "boom" }], isError: true } })}\n\n`
    ),
  /MCP search error/,
  "an isError MCP frame must throw, so the manager can fall back"
);
assert.throws(
  () => parseParallelResults("not json at all"),
  /malformed payload/,
  "a malformed Parallel payload must throw rather than report zero results"
);

resetWebsearchProviders();
registerCoreEnv(stubEnv);
try {
  // End to end: Exa returns isError:true → the search must fall back to DuckDuckGo (not
  // report a successful empty result).
  const errorEnv = {
    ...stubEnv,
    fetch: async (url) => {
      lastUrl = String(url);
      if (lastUrl.includes("mcp.exa.ai")) {
        const payload = {
          result: { content: [{ text: "web_search_exa error (401): Invalid API key." }], isError: true },
        };
        return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(
        `<div class="result web-result"><a class="result__a" href="https://ddg.example.com">DDG</a><a class="result__snippet">fallback</a></div>`,
        { status: 200, headers: { "content-type": "text/html" } }
      );
    },
  };
  registerCoreEnv(errorEnv);
  initializeProviders({ provider: "exa" });
  const outcome = await getProviderManager().search("q", { maxResults: 3, timeoutMs: 5000 });
  assert.equal(outcome.provider, "duckduckgo", "an isError provider falls back to the next available");
  assert.equal(outcome.results[0].url, "https://ddg.example.com");
} finally {
  clearCoreEnv();
  resetWebsearchProviders();
}

// ============================================================================
// Keyed vs free transport
// ============================================================================

resetWebsearchProviders();
registerCoreEnv(stubEnv);
try {
  // Exa with a key → the same MCP endpoint but carrying `?exaApiKey=`.
  initializeProviders({ exaApiKey: "exa-secret", provider: "exa" });
  {
    const pm = getProviderManager();
    const outcome = await pm.search("q", { maxResults: 2, timeoutMs: 5000 });
    assert.equal(outcome.provider, "exa");
    assert.ok(lastUrl.includes("exaApiKey=exa-secret"), "exa keyed transport sends the key on the MCP url");
  }
} finally {
  clearCoreEnv();
  resetWebsearchProviders();
}

resetWebsearchProviders();
registerCoreEnv(stubEnv);
try {
  // Parallel with a key → the same MCP endpoint but carrying `?apiKey=`.
  initializeProviders({ parallelApiKey: "parallel-secret", provider: "parallel" });
  {
    const pm = getProviderManager();
    const outcome = await pm.search("q", { maxResults: 2, timeoutMs: 5000 });
    assert.equal(outcome.provider, "parallel");
    assert.ok(lastUrl.includes("apiKey=parallel-secret"), "parallel keyed transport sends the key on the MCP url");
  }
} finally {
  clearCoreEnv();
  resetWebsearchProviders();
}

resetWebsearchProviders();
registerCoreEnv(stubEnv);
try {
  // Tavily with a key → REST API, Bearer auth, JSON results.
  initializeProviders({ tavilyApiKey: "tvly-secret", provider: "tavily" });
  const pm = getProviderManager();
  assert.equal((await pm.listProviders()).find((p) => p.name === "tavily").available, true);
  const outcome = await pm.search("q", { maxResults: 2, timeoutMs: 5000 });
  assert.equal(outcome.provider, "tavily");
  assert.ok(lastUrl.includes("api.tavily.com"), "tavily uses its REST endpoint");
  assert.equal(outcome.results[0].url, "https://tavily.example.com");
  assert.equal(outcome.results[0].snippet, "From Tavily");
} finally {
  clearCoreEnv();
  resetWebsearchProviders();
}

// ============================================================================
// Free-provider spreading
// ============================================================================

// hashToIndex is the pure function the spread depends on; pin its shape.
assert.equal(hashToIndex("", 3) >= 0 && hashToIndex("", 3) < 3, true);
assert.equal(hashToIndex("same", 3), hashToIndex("same", 3), "hashing is deterministic");

resetWebsearchProviders();
registerCoreEnv(stubEnv);
try {
  initializeProviders();
  const pm = getProviderManager();

  // No keys → free providers in registration order are [parallel, exa, duckduckgo].
  const freeNames = pm.listProviderNames().filter((n) => n === "parallel" || n === "exa" || n === "duckduckgo");

  // Find a session id that does NOT hash to the first free provider, so the assertion
  // below fails if spreading were removed (would always return `freeNames[0]`).
  let sessionId = "";
  for (let i = 0; i < 50; i++) {
    const candidate = `session-${i}`;
    if (hashToIndex(candidate, freeNames.length) !== 0) {
      sessionId = candidate;
      break;
    }
  }
  assert.notEqual(sessionId, "", "expected a session id hashing off the first slot");

  const expected = freeNames[hashToIndex(sessionId, freeNames.length)];
  assert.notEqual(expected, freeNames[0], "test setup: the expected provider is not the first");

  pm.setSessionId(sessionId);
  const spread = await pm.selectProvider();
  assert.equal(spread.name, expected, "free providers are spread by session id, not first-available");

  // Same session id → same provider (contiguous within a conversation).
  assert.equal((await pm.selectProvider()).name, expected, "selection is stable for one session");

  // A key makes a provider win outright (it is no longer a free-pool candidate): with any
  // keyed provider available, selection is the keyed provider regardless of session id.
  pm.configure({ exaApiKey: "exa-secret" });
  for (let i = 0; i < 50; i++) {
    pm.setSessionId(`session-${i}`);
    const picked = await pm.selectProvider();
    assert.equal(picked.name, "exa", "a keyed provider wins outright, not spread in the free pool");
  }
} finally {
  clearCoreEnv();
  resetWebsearchProviders();
}

// A user abort must short-circuit provider fallback (`ProviderManager.search`): the aborted call
// rethrows the abort instead of trying the next provider, and never masks it as "all failed"
// (which would not read as a cancel to an error-only consumer).
{
  resetWebsearchProviders();
  const pm = getProviderManager();
  const calls = [];
  const abortError = () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
  };
  pm.register({
    name: "p_abort",
    isAvailable: async () => true,
    search: async () => {
      calls.push("p_abort");
      throw abortError();
    },
  });
  pm.register({
    name: "p_next",
    isAvailable: async () => true,
    search: async () => {
      calls.push("p_next");
      return [];
    },
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => pm.search("q", { signal: controller.signal }),
    (error) => error.name === "AbortError"
  );
  assert.deepEqual(calls, ["p_abort"], "an aborted signal must not fall through to the next provider");
  resetWebsearchProviders();
}

// ============================================================================
// models.json toolConfig: legacy key read + normalized
// ============================================================================

// Legacy `websearchProvider` is read as `provider` and stripped (a pre-rename file keeps
// working and the next save emits `provider` only).
const minimalEntry = { type: "direct", style: "openai", baseURL: "https://api.example.com/v1" };
{
  const config = parseModelsConfig(
    JSON.stringify({ global: { toolConfig: { websearchProvider: "exa" } }, models: [minimalEntry] })
  );
  assert.equal(config.global.toolConfig.provider, "exa", "legacy websearchProvider is read as provider");
  assert.equal(config.global.toolConfig.websearchProvider, undefined, "the legacy key is stripped");
}

// An explicit `provider` wins over the legacy spelling.
{
  const config = parseModelsConfig(
    JSON.stringify({
      global: { toolConfig: { provider: "parallel", websearchProvider: "exa" } },
      models: [minimalEntry],
    })
  );
  assert.equal(config.global.toolConfig.provider, "parallel", "provider wins over the legacy key");
  assert.equal(config.global.toolConfig.websearchProvider, undefined);
}

// The raw (write-path) normalizer does the same rename without dropping sibling keys.
{
  const raw = normalizeRawGlobalToolConfig({ toolConfig: { websearchProvider: "exa", braveApiKey: "k" }, other: 1 });
  assert.equal(raw.toolConfig.provider, "exa", "raw normalizer renames websearchProvider");
  assert.equal(raw.toolConfig.websearchProvider, undefined, "raw normalizer drops the legacy key");
  assert.equal(raw.toolConfig.braveApiKey, "k", "raw normalizer keeps sibling toolConfig keys");
  assert.equal(raw.other, 1, "raw normalizer keeps sibling global keys");
  // No legacy key → identity (so the write path can cheaply skip a rebuild).
  const untouched = { toolConfig: { provider: "exa" } };
  assert.equal(normalizeRawGlobalToolConfig(untouched) === untouched, true, "nothing to rename → same reference");
}

console.log("websearch-providers validation passed");
