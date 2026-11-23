/**
 * Validates that ANY explicit model flag isolates the ACP session from `models.json`.
 *
 * The TUI's rule is `modelExplicit` — set by `--model`, `--style`, `--base-url` **or** `--api-key`.
 * ACP tested only `model.trim()`, so `codent acp --api-key sk-flag` fell into the models.json branch
 * and the flag never took effect (and with no models.json it called the env resolver WITHOUT the
 * overrides, losing it there too). The same command behaved differently in the two hosts, and the
 * failure surfaced as a 401 rather than "your flag was ignored".
 *
 * Run: pnpm --filter @codent/acp run validate:acp-model-flags
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TEMP_RM_OPTIONS } from "../../core/scripts/helpers/temp-cleanup.mjs";
import { bootstrapLocalAcp } from "../dist/index.mjs";

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "acp-model-flags-"));
const configDir = path.join(rootPath, ".agents", "config");
await fs.promises.mkdir(configDir, { recursive: true });
await fs.promises.writeFile(
  path.join(configDir, "models.json"),
  JSON.stringify(
    {
      models: [
        {
          type: "direct",
          style: "openai",
          baseURL: "https://file.example/v1",
          apiKey: "file-key",
          models: ["file-model"],
        },
      ],
      active: { entryIndex: 0, model: "file-model" },
    },
    null,
    2
  )
);

const previousModel = process.env.MODEL;
const previousKey = process.env.API_KEY;
try {
  // No flag: the file owns the connection (unchanged behaviour).
  {
    const boot = await bootstrapLocalAcp({ cwd: rootPath });
    assert.equal(boot.defaults.modelApiKey, "file-key", "without flags the models.json entry is used");
    assert.ok(boot.models, "…and its catalog is advertised");
  }

  // Only `--api-key`: the flags isolate the session, so the file entry must not win.
  {
    process.env.MODEL = "flag-model";
    delete process.env.API_KEY;
    const boot = await bootstrapLocalAcp({ cwd: rootPath, model: { apiKey: "flag-key" } });
    assert.equal(boot.defaults.modelApiKey, "flag-key", "an api-key flag is not overwritten by the file entry");
    assert.notEqual(boot.defaults.modelBaseURL, "https://file.example/v1", "…and the file's baseURL is not adopted");
    assert.deepEqual(
      boot.models?.entries?.map((entry) => entry.models),
      [["flag-model"]],
      "the advertised catalog is the single flag model, not the file's entries"
    );
  }

  // Only `--base-url`: same rule.
  {
    process.env.MODEL = "flag-model";
    const boot = await bootstrapLocalAcp({ cwd: rootPath, model: { baseURL: "https://flag.example/v1" } });
    assert.equal(boot.defaults.modelBaseURL, "https://flag.example/v1", "a base-url flag is honoured");
    assert.equal(boot.defaults.modelApiKey ?? "", "", "…and the file key does not ride along");
  }
} finally {
  if (previousModel === undefined) delete process.env.MODEL;
  else process.env.MODEL = previousModel;
  if (previousKey === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = previousKey;
  await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);
}

console.log("acp model flags validation passed");
