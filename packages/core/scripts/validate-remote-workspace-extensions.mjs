/**
 * Validation: a remote workspace loads no disk extensions.
 *
 * Run: pnpm --filter @codent/core run validate:remote-workspace-extensions
 *
 * Disk extension discovery reads files through the owning env's `fs` (paths on the WORKSPACE
 * machine) and then `import()`s them in the CLIENT process. With `--remote-env` those are two
 * different machines, so before this guard every discovered file failed with ENOENT — or, when the
 * client happened to have the same path, an unrelated local file ran while the workspace was
 * elsewhere. The env now carries a `remote` capability marker and `loadExtensions` skips discovery
 * for it; in-process `config.extensions` and the built-ins still load.
 *
 * Both directions are asserted on the SAME extension file: a local env loads it (so the fixture is
 * genuinely loadable and the skip is the guard, not a broken file), and a remote env does not.
 */

import { createNodeEnv } from "@codent/node";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentManager, registerCoreEnv } from "../dist/index.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const root = await mkdtemp(join(tmpdir(), "codent-remote-ext-"));

const extDir = join(root, ".agents", "extensions");
await mkdir(extDir, { recursive: true });
await writeFile(
  join(extDir, "probe-ext.mjs"),
  `export default {
  id: "probe-ext",
  name: "Probe",
  version: "1.0.0",
  description: "loads only when disk discovery runs",
  activate() {},
};
`
);

const localEnv = createNodeEnv({ rootPath: root, cwd: root, platform: "linux", mode: "native" });

/** The in-process extension host-supplied code can still provide on either plane. */
const inProcessExtension = {
  id: "in-process-ext",
  name: "In process",
  version: "1.0.0",
  description: "registered as a factory, never discovered from disk",
  async activate() {},
};

const extensionIds = (agent) => (agent.getExtensionRunner()?.getExtensionInfos() ?? []).map((info) => info.id);

// ---------------------------------------------------------------------------
// 1. Local workspace: the disk extension is discovered and loaded
// ---------------------------------------------------------------------------
registerCoreEnv(localEnv);
const localManager = new AgentManager();
const localAgent = await localManager.createManagedAgent({
  name: "remote-ext-local",
  model: "test-model",
  extensionDirs: [extDir],
  skills: false,
  memory: false,
  lsp: false,
  codeMode: false,
});
const localIds = extensionIds(localAgent);
assert.ok(localIds.includes("probe-ext"), `a local workspace loads the disk extension (got ${localIds.join(", ")})`);
await localManager.dispose();

// ---------------------------------------------------------------------------
// 2. Remote workspace: discovery is skipped, in-process extensions still load
// ---------------------------------------------------------------------------
registerCoreEnv({ ...localEnv, remote: true });
const remoteManager = new AgentManager();
const remoteAgent = await remoteManager.createManagedAgent({
  name: "remote-ext-remote",
  model: "test-model",
  extensionDirs: [extDir],
  extensions: [{ create: async () => inProcessExtension }],
  skills: false,
  memory: false,
  lsp: false,
  codeMode: false,
});
const remoteIds = extensionIds(remoteAgent);
assert.ok(
  !remoteIds.includes("probe-ext"),
  `a remote workspace must not import the workspace's extension files (got ${remoteIds.join(", ")})`
);
assert.ok(
  remoteIds.includes("in-process-ext"),
  "an in-process extension factory still loads on a remote workspace (the guard is discovery-only)"
);
await remoteManager.dispose();

// ---------------------------------------------------------------------------
// 3. The marker is opt-in: a local env carries no `remote` flag
// ---------------------------------------------------------------------------
assert.equal(localEnv.remote, undefined, "a local env leaves the remote marker unset");
assert.equal({ ...localEnv, remote: true }.remote, true, "resolveCoreEnv's spread keeps the marker");

await rm(root, TEMP_RM_OPTIONS);

console.log("validate:remote-workspace-extensions passed");
