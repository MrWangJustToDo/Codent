/**
 * Unit validation for model connection resolution (no network).
 *
 * Run: pnpm --filter @codent/core run validate:model-config
 */

import assert from "node:assert/strict";

import {
  DEFAULT_BASE_URLS,
  DEFAULT_LOCAL_OPENAI_BASE_URL,
  parseModelStyle,
  resolveModelConfig,
  resolveModelConnection,
} from "../dist/index.mjs";

assert.equal(parseModelStyle("anthropic"), "anthropic");
assert.equal(parseModelStyle("openai"), "openai");
assert.equal(parseModelStyle("ollama"), "openai");
assert.equal(parseModelStyle(undefined), "openai");

const openaiDefault = resolveModelConnection({ style: "openai", model: "gpt-4.1" });
assert.equal(openaiDefault.baseURL, DEFAULT_BASE_URLS.openai);

const anthropicDefault = resolveModelConnection({ style: "anthropic", model: "claude-sonnet-4" });
assert.equal(anthropicDefault.baseURL, DEFAULT_BASE_URLS.anthropic);

const local = resolveModelConnection({
  style: "openai",
  model: "qwen2.5-coder:7b",
  baseURL: DEFAULT_LOCAL_OPENAI_BASE_URL,
  apiKey: "sk-test",
});
assert.equal(local.style, "openai");
assert.equal(local.baseURL, DEFAULT_LOCAL_OPENAI_BASE_URL);
assert.equal(local.apiKey, "sk-test");

const explicit = resolveModelConnection({
  style: "openai",
  model: "custom",
  baseURL: "https://gateway.example.com/v1",
  apiKey: "key",
});
assert.equal(explicit.baseURL, "https://gateway.example.com/v1");

const noV1 = resolveModelConnection({
  style: "openai",
  model: "custom",
  baseURL: "https://gateway.example.com/api",
  apiKey: "key",
});
assert.equal(noV1.baseURL, "https://gateway.example.com/api");

// One rule for baseURL precedence: an explicit connection field wins over metadata. The async
// resolver used to re-apply `modelInfo.baseURL ?? connection.baseURL` afterwards, which silently
// ignored `--base-url` when metadata carried a URL. Empty `model` skips the models.dev lookup.
{
  const resolved = await resolveModelConfig({
    baseURL: "https://explicit.example/v1",
    modelInfo: {
      id: "m",
      name: "M",
      style: "openai",
      apiModel: "m",
      baseURL: "https://metadata.example/v1",
    },
  });
  assert.equal(
    resolved.connection.baseURL,
    "https://explicit.example/v1",
    "an explicit baseURL must win over modelInfo.baseURL"
  );
}

console.log("model-config validation passed");
