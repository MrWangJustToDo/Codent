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
  resolveModelConnectionFromEnv,
} from "../dist/index.mjs";

assert.equal(parseModelStyle("anthropic"), "anthropic");
assert.equal(parseModelStyle("openai"), "openai");
assert.equal(parseModelStyle("ollama"), "openai");
assert.equal(parseModelStyle(undefined), "openai");

// ONE env → connection mapping (CLI / ACP / agent server). The ACP copy used to parse the style
// case-sensitively, so `MODEL_STYLE=Anthropic` meant `anthropic` in the TUI and `openai` over ACP.
{
  const fromEnv = resolveModelConnectionFromEnv({
    MODEL: "env-model",
    MODEL_STYLE: "Anthropic",
    BASE_URL: "https://env.example/v1",
    API_KEY: "env-key",
  });
  assert.deepEqual(fromEnv, {
    model: "env-model",
    style: "anthropic",
    baseURL: "https://env.example/v1",
    apiKey: "env-key",
  });

  const overridden = resolveModelConnectionFromEnv(
    { MODEL: "env-model", MODEL_STYLE: "anthropic" },
    { model: "flag-model", style: "openai" }
  );
  assert.equal(overridden.model, "flag-model", "a flag wins over the record");
  assert.equal(overridden.style, "openai", "a flag wins on the style too");
  assert.equal(resolveModelConnectionFromEnv({}).model, "", "an empty record resolves an empty connection");
}

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
