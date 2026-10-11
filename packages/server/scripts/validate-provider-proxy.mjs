/**
 * Validates provider path mapping, env secret filtering, and streaming proxy.
 *
 * Run: pnpm --filter @codent/server run validate:provider-proxy
 */

import { registerCoreEnv } from "@codent/core";
import { createNodeEnv } from "@codent/node";
import { Hono } from "hono";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REMOTE_PROVIDER_API_KEY,
  anthropicProxyBasePath,
  filterSensitiveVars,
  mapProviderPathToUpstream,
  normalizeProviderRequestPath,
  openaiProxyBasePath,
  providerRoutes,
} from "../dist/index.mjs";

// --- path helpers ---

assert.equal(openaiProxyBasePath("https://api.openai.com/v1"), "/api/provider/openai/v1");
assert.equal(openaiProxyBasePath("https://api.deepseek.com"), "/api/provider/openai");
assert.equal(anthropicProxyBasePath("https://api.anthropic.com"), "/api/provider/anthropic");

assert.equal(
  mapProviderPathToUpstream("https://api.openai.com/v1", "openai", "/api/provider/openai/v1/chat/completions"),
  "https://api.openai.com/v1/chat/completions"
);
assert.equal(
  mapProviderPathToUpstream("https://api.deepseek.com", "openai", "/openai/v1/chat/completions"),
  "https://api.deepseek.com/v1/chat/completions"
);
assert.equal(normalizeProviderRequestPath("/openai/v1/x"), "/api/provider/openai/v1/x");

assert.equal(REMOTE_PROVIDER_API_KEY, "remote-provider");

// --- env secret filter ---

const filtered = filterSensitiveVars({
  MODEL: "gpt",
  API_KEY: "sk-secret",
  OPENAI_API_KEY: "sk-oai",
  BRAVE_API_KEY: "brave",
  PATH: "/usr/bin",
});
assert.equal(filtered.MODEL, "gpt");
assert.equal(filtered.PATH, "/usr/bin");
assert.equal(filtered.API_KEY, undefined);
assert.equal(filtered.OPENAI_API_KEY, undefined);
assert.equal(filtered.BRAVE_API_KEY, undefined);

// --- streaming proxy against mock upstream ---

const upstreamChunks = ["data: hello\n\n", "data: world\n\n"];
let sawAuth = "";
let sawBody = "";
let upstreamHits = 0;
const upstream = createServer((req, res) => {
  upstreamHits += 1;
  sawAuth = String(req.headers.authorization || "");
  req.on("data", (d) => (sawBody += d));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of upstreamChunks) res.write(chunk);
    res.end();
  });
});

await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = /** @type {import('node:net').AddressInfo} */ (upstream.address()).port;

process.env.MODEL_STYLE = "openai";
process.env.MODEL = "mock-model";
process.env.BASE_URL = `http://127.0.0.1:${upstreamPort}/v1`;
process.env.API_KEY = "sk-server-only";

const app = new Hono().route("/api/provider", providerRoutes);

const proxyRes = await app.request("http://local/api/provider/openai/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer client-should-not-win" },
  body: JSON.stringify({ model: "mock-model", stream: true }),
});

assert.equal(proxyRes.status, 200);
assert.equal(sawAuth, "Bearer sk-server-only", "server must inject its API_KEY");
const body = await proxyRes.text();
assert.ok(body.includes("hello"));
assert.ok(body.includes("world"));
assert.equal(proxyRes.headers.get("content-encoding"), null, "must not forward content-encoding after decode");

// The server's model set is the allowlist and the single source of truth on
// this path: a client model outside it is refused, never silently rewritten.
// `collectAllowedModels` seeds the set with the env MODEL, and reaching here
// requires `connection.baseURL`, whose companion MODEL is always set — so the
// set is never empty and there is no "no allowlist configured" rewrite path.
assert.ok(sawBody.includes('"model":"mock-model"'), "allowlisted model is forwarded unchanged");

const rejectedRes = await app.request("http://local/api/provider/openai/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer client-should-not-win" },
  body: JSON.stringify({ model: "client-wrong-model", stream: true }),
});
assert.equal(rejectedRes.status, 400, "a model the server does not serve is refused");
const rejectedBody = JSON.parse(await rejectedRes.text());
assert.equal(
  rejectedBody.error.code,
  "model_not_allowed",
  "rejection carries the model_not_allowed code so clients can explain it"
);
// The message must name the real source of the allowed set. It previously always
// said "models.json allowlist" even when no models.json existed and the only
// model came from the server's MODEL env var, which sent readers looking for a
// file that was not there.
assert.match(rejectedBody.error.message, /mock-model/, "the refusal names the model(s) the server does serve");
assert.ok(!sawBody.includes("client-wrong-model"), "a refused model must not reach the upstream provider");
assert.equal(upstreamHits, 1, "the refused request caused no upstream call");

// A request with no model field has nothing to contradict and is forwarded
// unchanged, matching the previous pass-through behaviour.
const noModelRes = await app.request("http://local/api/provider/openai/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer client-should-not-win" },
  body: JSON.stringify({ stream: true }),
});
assert.equal(noModelRes.status, 200, "a request without a model field still passes through");
assert.equal(upstreamHits, 2, "the model-less request reached upstream");

const infoRes = await app.request("http://local/api/provider/info");
assert.equal(infoRes.status, 200);
const info = await infoRes.json();
assert.equal(info.mode, "remote");
assert.equal(info.style, "openai");
assert.equal(info.model, "mock-model");
assert.equal(info.basePath, "/api/provider/openai/v1");

// The advertised config must be self-consistent: the model this server serves leads the
// list and is reported as active, so a client's selectable list — and its idea of which
// model is current — contains the model every proxied request carries. The server's own
// models.json names other ids and records no selection, which is exactly the shape that
// made clients display a model the proxy never sent.
{
  const root = mkdtempSync(join(tmpdir(), "provider-info-"));
  mkdirSync(join(root, ".agents", "config"), { recursive: true });
  writeFileSync(
    join(root, ".agents", "config", "models.json"),
    JSON.stringify({
      global: {
        toolConfig: {
          braveApiKey: "brave-must-not-leak",
          exaApiKey: "exa-must-not-leak",
          parallelApiKey: "parallel-must-not-leak",
          tavilyApiKey: "tavily-must-not-leak",
        },
      },
      models: [
        {
          type: "direct",
          style: "anthropic",
          baseURL: "https://upstream.example.com/v1",
          apiKey: "sk-must-not-leak",
          models: ["other-a", "other-b"],
        },
      ],
    })
  );
  registerCoreEnv(createNodeEnv({ rootPath: root }));

  const advertised = await (await app.request("http://local/api/provider/info")).json();
  const directModels = advertised.config.models
    .filter((entry) => entry.type === "direct")
    .flatMap((entry) => entry.models ?? []);

  assert.deepEqual(
    directModels,
    ["mock-model", "other-a", "other-b"],
    "the served model must be advertised first, without duplicating a models.json id"
  );
  assert.equal(advertised.config.models[0].style, "openai", "advertised under the connection's own style");
  assert.deepEqual(advertised.config.active, { entryIndex: 0, model: "mock-model" });
  assert.ok(
    advertised.config.models[advertised.config.active.entryIndex].models.includes(advertised.config.active.model),
    "active must point at an entry that offers it"
  );
  assert.ok(!JSON.stringify(advertised).includes("sk-must-not-leak"), "no apiKey may leave the server");
  assert.ok(!JSON.stringify(advertised).includes("upstream.example.com"), "no upstream baseURL either");
  // `global.toolConfig` holds websearch keys — a server secret like a direct entry's apiKey.
  // No client consumes it, so it must not appear in the sanitized payload at all.
  assert.equal(advertised.config.global, undefined, "global.toolConfig must be stripped from /api/provider/info");
  for (const key of ["brave-must-not-leak", "exa-must-not-leak", "parallel-must-not-leak", "tavily-must-not-leak"]) {
    assert.ok(!JSON.stringify(advertised).includes(key), `websearch key ${key} must not leave the server`);
  }

  rmSync(root, { recursive: true, force: true });
}

upstream.close();

process.env.BASE_URL = "http://127.0.0.1:1/v1";
const failRes = await app.request("http://local/api/provider/openai/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "mock-model", stream: false }),
});
assert.equal(failRes.status, 502);
const failBody = await failRes.json();
assert.equal(typeof failBody.error, "object");
assert.equal(failBody.error.code, "upstream_fetch_failed");
assert.match(String(failBody.error.message), /Upstream provider error:/);

console.log("provider-proxy validation passed");
