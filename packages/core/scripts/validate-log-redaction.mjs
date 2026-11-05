/**
 * Log redaction: credentials never reach a durable entry.
 *
 * Run: pnpm --filter @codent/core run validate:log-redaction
 */

import assert from "node:assert/strict";

import { AgentLog, redactLogValue, redactSecrets } from "../dist/dev.mjs";

const cases = [
  ["Authorization: Bearer sk-abcdef1234567890", /sk-|abcdef/],
  ["x-api-key: super-secret-key", /super-secret-key/],
  ["api_key=AIzaSyD-1234567890", /AIzaSyD/],
  ["password: hunter2", /hunter2/],
  ["GET https://example.test/?token=abc123&x=1", /abc123/],
  ["ghp_abcdefghijklmnop", /ghp_/],
];
for (const [input, leak] of cases) {
  const out = redactSecrets(input);
  assert.match(out, /\[redacted\]/, `must redact: ${input}`);
  assert.doesNotMatch(out, leak, `must not leak: ${input} -> ${out}`);
}

// Non-secrets stay readable.
assert.equal(redactSecrets("token count: 42"), "token count: 42");
assert.equal(redactSecrets("read_file src/index.ts"), "read_file src/index.ts");

const data = redactLogValue({
  apiKey: "secret",
  password: "secret",
  nested: { access_token: "secret", ok: "visible" },
  items: [{ secret: "secret", name: "item" }],
  text: "Authorization: Bearer abcdefgh",
});
assert.equal(data.apiKey, "[redacted]");
assert.equal(data.password, "[redacted]");
assert.equal(data.nested.access_token, "[redacted]");
assert.equal(data.nested.ok, "visible");
assert.equal(data.items[0].secret, "[redacted]");
assert.equal(data.items[0].name, "item");
assert.equal(data.text, "Authorization: [redacted]");

// The seam redacts regardless of which writer produced the entry.
{
  let captured;
  const log = new AgentLog({ minLevel: "debug" });
  log.attachSink({ handleEntry: (entry) => (captured = entry) });
  log.info("tool", "run: Authorization: Bearer abcdefgh", { apiKey: "secret", command: "git status" });
  assert.equal(captured.message, "run: Authorization: [redacted]");
  assert.equal(captured.data.apiKey, "[redacted]");
  assert.equal(captured.data.command, "git status");

  log.error("llm", "provider failed", new Error("x-api-key: supersecret"), { token: "secret" });
  assert.match(captured.error.message, /\[redacted\]/);
  assert.doesNotMatch(captured.error.message, /supersecret/);
  assert.equal(captured.data.token, "[redacted]");
}

console.log("log redaction validation passed");
