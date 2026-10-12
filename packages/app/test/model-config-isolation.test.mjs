/**
 * `modelExplicit` isolates the session from the on-disk `.agents/config/models.json`.
 *
 * When the CLI bootstrap passes explicit model flags, `initConfig` must NOT load the
 * file: the flags are authoritative and `/models` lists nothing. (The inverse — no flags
 * → the file is loaded — depends on the real workspace file, so it is not asserted here.)
 *
 * Run: node packages/app/test/model-config-isolation.test.mjs
 */
import assert from "node:assert/strict";

import { initConfig, useConfig } from "../dist/index.mjs";

await initConfig({
  model: "flag-model",
  style: "openai",
  baseURL: "http://flag.example/v1",
  apiKey: "flag-key",
  systemPrompt: "sys",
  modelExplicit: true,
});

const { config, modelsConfig } = useConfig.getReadonlyState();
assert.equal(modelsConfig, null, "explicit model flags must not load the on-disk models config");
assert.equal(config.model, "flag-model", "the flag model survives");
assert.equal(config.baseURL, "http://flag.example/v1", "the flag baseURL survives");
assert.equal(config.apiKey, "flag-key", "the flag apiKey survives");

console.log("model-config-isolation: ok");
