/**
 * Ensures the websearch toolConfig from a loaded `models.json` (`global.toolConfig`) merges
 * under the host config per field: the host (CLI/env) value wins, the file fills the gaps.
 *
 * Run: node packages/app/test/merge-tool-config.test.mjs
 */
import assert from "node:assert/strict";

import { mergeModelsConfigToolConfig } from "../dist/utils/merge-tool-config.mjs";

// 1. No file toolConfig → host config passes through untouched (and by reference).
{
  const host = { websearch: { braveApiKey: "sk-brave", provider: "brave" } };
  assert.equal(mergeModelsConfigToolConfig(host, {}) === host, true);
  assert.equal(mergeModelsConfigToolConfig(undefined, undefined), undefined);
  assert.equal(mergeModelsConfigToolConfig(undefined, { toolConfig: undefined }), undefined);
}

// 2. File fills gaps the host leaves open.
{
  const merged = mergeModelsConfigToolConfig(undefined, {
    toolConfig: { provider: "parallel", exaApiKey: "exa-from-file" },
  });
  assert.equal(merged.websearch.provider, "parallel");
  assert.equal(merged.websearch.exaApiKey, "exa-from-file");
}

// 3. Per-field precedence: the host wins on `provider`, the file still supplies its own key.
{
  const merged = mergeModelsConfigToolConfig(
    { websearch: { provider: "brave", braveApiKey: "sk-brave" } },
    { toolConfig: { provider: "parallel", tavilyApiKey: "tvly" } }
  );
  assert.equal(merged.websearch.provider, "brave", "host provider wins");
  assert.equal(merged.websearch.braveApiKey, "sk-brave", "host key kept");
  assert.equal(merged.websearch.tavilyApiKey, "tvly", "file-only key filled in");
}

// 4. An empty host string does not clobber a file value.
{
  const merged = mergeModelsConfigToolConfig({ websearch: { provider: "" } }, { toolConfig: { provider: "exa" } });
  assert.equal(merged.websearch.provider, "exa");
}

console.log("merge-tool-config: ok");
