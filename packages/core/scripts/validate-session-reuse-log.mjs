/**
 * Validates restart session-reuse + log continuity:
 * 1. Launch 1 creates a fresh empty session E and writes `.agents/logs/E/agent.log`.
 * 2. Launch 2 (default startup, new manager/host) reuses E and keeps the *same*
 *    session id — logs continue in `.agents/logs/E/agent.log` (with a launch
 *    divider) instead of a transient `.agents/logs/{newId}` dir.
 * 3. No stray log dirs are created for the reused launch.
 *
 * The leftover empty session file is written directly with `store.save`, because a session
 * now reaches disk only on its first *content* save: a fresh launch and `/new` no longer
 * leave one, so the reuse path exercised here is defensive (a legacy leftover).
 *
 * Run: pnpm --filter @codent/core run validate:session-reuse-log
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentManager, createLocalAgentSessionHost, registerCoreEnv } from "../dist/index.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-reuse-log-"));

/** Mirrors native-fs: relative paths resolve under rootPath, absolute pass through. */
const toAbs = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));

registerCoreEnv({
  rootPath,
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => rootPath,
  fs: {
    readFile: async (p, encoding) => fs.promises.readFile(toAbs(p), encoding ?? "utf-8"),
    writeFile: async (p, content) => fs.promises.writeFile(toAbs(p), content),
    appendFile: async (p, content) => fs.promises.appendFile(toAbs(p), content, "utf8"),
    // Atomic log replace (`SessionStore` writes a temp file and renames it). The store is now
    // driven directly below, so the mock must provide it — without `rename` the store rewrites
    // the log in place and a concurrent `load()` can read a truncated file.
    rename: async (from, to) => fs.promises.rename(toAbs(from), toAbs(to)),
    mkdir: async (p) => fs.promises.mkdir(toAbs(p), { recursive: true }),
    exists: async (p) =>
      fs.promises.access(toAbs(p)).then(
        () => true,
        () => false
      ),
    readdir: async (p) => {
      try {
        const entries = await fs.promises.readdir(toAbs(p), { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
      } catch {
        return [];
      }
    },
    stat: async (p) => {
      const st = await fs.promises.stat(toAbs(p));
      return { isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size, mtime: st.mtime };
    },
    remove: async (p) => fs.promises.rm(toAbs(p), TEMP_RM_OPTIONS),
  },
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => new Response(),
});

const listLogDirs = async () => {
  const dir = path.join(rootPath, ".agents/logs");
  const exists = await fs.promises.access(dir).then(
    () => true,
    () => false
  );
  if (!exists) return [];
  return (await fs.promises.readdir(dir)).filter((n) => n.startsWith("ses_")).sort();
};

// ----------------------------------------------------------------------------
// Launch 1: fresh empty session E.
// ----------------------------------------------------------------------------
const manager1 = new AgentManager();
const host1 = createLocalAgentSessionHost({ manager: manager1 });
const created1 = await host1.create({ name: "launch-1", model: "test-model" });
const managed1 = manager1.getAgent(created1.session.getSnapshot().agentId);
assert.ok(managed1, "launch 1 managed agent");

const sessionE = managed1.getSessionData()?.id;
assert.ok(sessionE?.startsWith("ses_"), `launch 1 stable ses_ id, got ${sessionE}`);

managed1.getLog().info("system", "launch-1-marker");
await sleep(450); // default flush interval is 250ms

// Leave an empty session file for launch 2 to discover. Written through `store.save`
// directly: `managed.persistSession()` no longer creates one (a session reaches disk only
// on its first content save), so this stands in for the leftover file an older build left
// behind — the defensive case the reuse path still covers.
const emptySession = managed1.getSessionData();
await managed1.getSessionStore().save(emptySession);
await sleep(50);

const logDirE = path.join(rootPath, ".agents/logs", sessionE);
const logFileE = path.join(logDirE, "agent.log");
assert.ok(
  await fs.promises.access(logFileE).then(
    () => true,
    () => false
  ),
  "launch 1 log file exists"
);
assert.ok((await fs.promises.readFile(logFileE, "utf-8")).includes("launch-1-marker"), "launch 1 entry on disk");

await host1.destroy(created1.session.id);
const dirsAfterLaunch1 = await listLogDirs();
assert.deepEqual(dirsAfterLaunch1, [sessionE], `exactly one log dir after launch 1, got ${dirsAfterLaunch1.join(",")}`);

// ----------------------------------------------------------------------------
// Launch 2: default startup must reuse E (same id) and keep logging to E's dir.
// ----------------------------------------------------------------------------
const manager2 = new AgentManager();
const host2 = createLocalAgentSessionHost({ manager: manager2 });
const created2 = await host2.create({ name: "launch-2", model: "test-model" });
const managed2 = manager2.getAgent(created2.session.getSnapshot().agentId);
assert.ok(managed2, "launch 2 managed agent");

const session2 = managed2.getSessionData()?.id;
assert.equal(session2, sessionE, "launch 2 reuses the latest empty session id");

managed2.getLog().info("system", "launch-2-marker");
await sleep(450);

const dirsAfterLaunch2 = await listLogDirs();
assert.deepEqual(
  dirsAfterLaunch2,
  [sessionE],
  `no stray log dir after reused launch, got ${dirsAfterLaunch2.join(",")}`
);

const content2 = await fs.promises.readFile(logFileE, "utf-8");
assert.ok(content2.includes("launch-2-marker"), "launch 2 entry landed in the reused session log dir");
assert.ok(content2.includes("new session ---"), "launch divider written for the reused log file");

// ----------------------------------------------------------------------------
// Launch 3: graceful teardown releases the reservation so E is reused again
// (instead of a new empty session) on an immediate restart.
// ----------------------------------------------------------------------------
await host2.destroy(created2.session.id);

const manager3 = new AgentManager();
const host3 = createLocalAgentSessionHost({ manager: manager3 });
const created3 = await host3.create({ name: "launch-3", model: "test-model" });
const session3 = manager3.getAgent(created3.session.getSnapshot().agentId)?.getSessionData()?.id;
assert.equal(session3, sessionE, "launch 3 reuses E after the reservation was released on teardown");
await host3.destroy(created3.session.id);

// ----------------------------------------------------------------------------
// Host create options: in-process extension factories load through the real
// AgentBootstrap, and builtins switches land on the managed config.
// ----------------------------------------------------------------------------
const manager4 = new AgentManager();
const host4 = createLocalAgentSessionHost({ manager: manager4 });
const created4 = await host4.create({
  name: "launch-options",
  model: "test-model",
  extensions: [
    {
      create: () => ({
        id: "host-create-extension",
        name: "Host create extension",
        version: "1.0.0",
        description: "loaded through AgentSessionCreateOptions.extensions",
        activate() {},
      }),
    },
  ],
  builtins: { lsp: false, skills: false, memory: false, mcp: false, codeMode: false },
});
const managed4 = manager4.getAgent(created4.session.getSnapshot().agentId);
assert.ok(managed4, "host create options managed agent");
assert.ok(
  managed4
    .getExtensionRunner()
    ?.getExtensionInfos()
    .some((info) => info.id === "host-create-extension"),
  "an in-process extension factory from host.create is loaded"
);
assert.equal(managed4.config.lsp, false, "builtins.lsp reaches the managed config");
assert.equal(managed4.config.skills, false, "builtins.skills reaches the managed config");
assert.equal(managed4.config.memory, false, "builtins.memory reaches the managed config");
assert.equal(managed4.config.mcp, false, "builtins.mcp reaches the managed config");
assert.equal(managed4.config.codeMode, false, "builtins.codeMode reaches the managed config");
await host4.destroy(created4.session.id);

console.log("session reuse + log continuity OK");
console.log("  reused session:", sessionE);
console.log("  log dirs:", dirsAfterLaunch2.join(", "));

await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);
console.log("session-reuse-log validation passed");
