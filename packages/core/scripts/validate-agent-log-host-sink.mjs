/**
 * Validates AgentLog file-sink host wiring:
 * 1. LocalAgentSessionHost.create() attaches the sink at
 *    `.agents/logs/{sessionId}/agent.log` with a stable `ses_` id and persists
 *    bootstrap + runtime entries.
 * 2. AgentManager.spawnSubagent inherits the parent session dir and writes an
 *    independent `{subagentId}.log`.
 * 3. Extension activation failures are visible: `agent-factory.ts` logs them before
 *    the session sink exists, so this pins the seam's pre-attach retention to a real
 *    bootstrap rather than to a synthetic one.
 * 4. Destroy order is unconditional: the log flush is chained onto the awaited
 *    extension teardown, so entries written by an async `session:shutdown`
 *    interceptor are in the file once `destroy()` resolves.
 *
 * The fixture mirrors the real Node CoreEnv, including its **sync** fs primitives
 * (`appendFileSync` / `mkdirSync` / `existsSync`). Without them `flushSync` degrades to
 * a fire-and-forget async flush, and the destroy-order assertion would measure that
 * degradation instead of the path Node actually takes.
 *
 * Run: pnpm --filter @codent/core run validate:agent-log-host-sink
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `DEFAULT_EXTENSION_DIR` is a dev-only export (not part of core's curated public entry),
// resolved here so the fixture dir cannot drift from the discovery path.
import { DEFAULT_EXTENSION_DIR } from "../dist/dev.mjs";
import { AgentManager, clearCoreEnv, createLocalAgentSessionHost, registerCoreEnv } from "../dist/index.mjs";

import { waitFor } from "./helpers/log-capture.mjs";
import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createdDirs = [];

/** Real-fs CoreEnv rooted at a fresh temp dir; relative paths resolve under it. */
async function useEnv(prefix) {
  const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(rootPath);
  const toAbs = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));
  clearCoreEnv();
  registerCoreEnv({
    rootPath,
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => rootPath,
    fs: {
      readFile: async (p, encoding) => fs.promises.readFile(toAbs(p), encoding),
      writeFile: async (p, content) => fs.promises.writeFile(toAbs(p), content),
      appendFile: async (p, content) => fs.promises.appendFile(toAbs(p), content, "utf8"),
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
      // Sync primitives, exactly as `@codent/node`'s native fs exposes them.
      appendFileSync: (p, content) => fs.appendFileSync(toAbs(p), content, "utf8"),
      mkdirSync: (p) => fs.mkdirSync(toAbs(p), { recursive: true }),
      existsSync: (p) => fs.existsSync(toAbs(p)),
    },
    runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    fetch: async () => new Response(),
  });
  return rootPath;
}

/** Write an extension module into the project extension dir of `rootPath`. */
async function writeExtension(rootPath, filename, lines) {
  const dir = path.join(rootPath, DEFAULT_EXTENSION_DIR);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, filename), [...lines, ""].join("\n"), "utf8");
}

/** The agent.log path for a session under `rootPath`. */
const logFileFor = (rootPath, sessionId) => path.join(rootPath, ".agents/logs", sessionId, "agent.log");

const exists = (p) =>
  fs.promises.access(p).then(
    () => true,
    () => false
  );

// ----------------------------------------------------------------------------
// 1. Main agent: stable ses_ id + session-scoped log dir with bootstrap events.
// ----------------------------------------------------------------------------
const rootPath = await useEnv("agent-log-host-sink-");
const manager = new AgentManager();
const host = createLocalAgentSessionHost({ manager });

const result = await host.create({ name: "verify", model: "test-model" });
const managed = manager.getAgent(result.session.getSnapshot().agentId);
assert.ok(managed, "managed agent created");

const sessionId = managed.ensureSessionData()?.id;
assert.ok(sessionId?.startsWith("ses_"), `stable ses_ id, got ${sessionId}`);

managed.getLog()?.info("system", "host-level-entry");
await sleep(450); // default flush interval is 250ms

const logDir = path.join(rootPath, ".agents/logs", sessionId);
const logFile = path.join(logDir, "agent.log");
assert.ok(await exists(logFile), "agent.log exists");
const content = await fs.promises.readFile(logFile, "utf-8");
assert.ok(content.includes("host-level-entry"), "runtime entry landed on disk");
assert.ok(content.includes("Session started"), "bootstrap entry persisted (sink attached before bootstrap events)");
console.log("main agent OK:", path.relative(rootPath, logDir));

// ----------------------------------------------------------------------------
// 2. Subagent: inherits parent session dir, independent {subagentId}.log.
// ----------------------------------------------------------------------------
const subagent = await manager.spawnSubagent(managed.id, { name: "sub" });
subagent.getLog()?.info("system", "subagent-entry");
await sleep(450);

const subFile = path.join(logDir, `${subagent.id}.log`);
assert.ok(await exists(subFile), "subagent file exists");
const subContent = await fs.promises.readFile(subFile, "utf-8");
assert.ok(subContent.includes("subagent-entry"), "subagent entry landed in parent session dir");
console.log("subagent OK:", path.relative(rootPath, subFile));

// ----------------------------------------------------------------------------
// 3. Extension activation failure emitted during bootstrap (before the session sink
//    exists) must still reach the persisted log.
//    Regression guard: with no pre-attach retention, `buildManagedAgent`'s extension
//    load/activation errors were written into a log that had no sink yet and vanished.
// ----------------------------------------------------------------------------
{
  const extRoot = await useEnv("agent-log-ext-fail-");
  await writeExtension(extRoot, "broken-extension.mjs", [
    "export const name = 'broken-extension';",
    "export async function activate() {",
    "  throw new Error('deliberate activation failure for the log-retention guard');",
    "}",
  ]);

  const extManager = new AgentManager();
  const extHost = createLocalAgentSessionHost({ manager: extManager });
  const extResult = await extHost.create({ name: "verify-ext-fail", model: "test-model" });
  const extManaged = extManager.getAgent(extResult.session.getSnapshot().agentId);
  assert.ok(extManaged, "managed agent created for the extension-failure case");

  const extLogFile = logFileFor(extRoot, extManaged.ensureSessionData()?.id);
  const extContent = await waitFor(
    async () => {
      try {
        return await fs.promises.readFile(extLogFile, "utf-8");
      } catch {
        return "";
      }
    },
    (c) => c.includes("broken-extension")
  );

  assert.ok(
    extContent.includes("broken-extension"),
    "pre-attach bootstrap entry (extension activation failure) reached the persisted log"
  );
  console.log("extension activation failure retained across pre-attach bootstrap OK");
}

// ----------------------------------------------------------------------------
// 4. Destroy order: an async `session:shutdown` interceptor's entry is durable once
//    `destroy()` resolves. `destroyAgent` awaits the shutdown interception and the
//    extension teardown, then flushes the log — so the interceptor's write can neither
//    be unregistered mid-flight nor flushed before it happens.
// ----------------------------------------------------------------------------
{
  const orderRoot = await useEnv("agent-log-destroy-order-");
  await writeExtension(orderRoot, "shutdown-writer.mjs", [
    "export const name = 'shutdown-writer';",
    "export async function activate(ctx) {",
    "  ctx.registerInterceptor('session:shutdown', async () => {",
    "    // Async on purpose: a sync interceptor would hide the ordering bug.",
    "    await new Promise((r) => setTimeout(r, 30));",
    "    ctx.logger.info('shutdown-interceptor-entry');",
    "  });",
    "}",
  ]);

  const orderManager = new AgentManager();
  const orderHost = createLocalAgentSessionHost({ manager: orderManager });
  const orderResult = await orderHost.create({ name: "verify-destroy-order", model: "test-model" });
  const orderAgentId = orderResult.session.getSnapshot().agentId;
  const orderSessionId = orderManager.getAgent(orderAgentId).ensureSessionData()?.id;
  const orderLogFile = logFileFor(orderRoot, orderSessionId);

  await orderHost.destroy(orderAgentId);

  // No polling: `destroy()` settles the interception + teardown + flush already.
  const orderContent = await fs.promises.readFile(orderLogFile, "utf-8").catch(() => "");
  assert.ok(
    orderContent.includes("shutdown-interceptor-entry"),
    "async session:shutdown interceptor entry is on disk by the time destroy() resolves"
  );
  console.log("destroy-order flush OK (async shutdown interceptor entry durable at destroy())");
}

for (const dir of createdDirs) await fs.promises.rm(dir, TEMP_RM_OPTIONS);
console.log("agent-log-host-sink validation passed");
