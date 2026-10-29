/**
 * Validates that a fact recorded *during bootstrap* reaches the log file.
 *
 * Bootstrap finishing before `agents.register(managed)` is what made pre-registration events
 * unresolvable: the bridge looks a log up by `event.agentId`, and until registration that lookup
 * found nothing — so an extension whose `activate` throws produced `agent:extension-error` that no
 * sink ever saw. The fix binds the agent's log for the construction window (symmetric with
 * `teardownLogs`), and this file is the assertion that it exists rather than the intent that it does.
 *
 * The assertions are deliberately about the FILE, not about a capture object: an in-memory capture
 * would pass even if the pending buffer dropped the entry, which is the failure mode being guarded.
 *
 * Run: pnpm --filter @codent/core run validate:bootstrap-log-binding
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentManager, createLocalAgentSessionHost, registerCoreEnv } from "../dist/index.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bootstrap-log-"));
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

const readEntries = async (sessionId) => {
  const file = path.join(rootPath, ".agents/logs", sessionId, "agent.log");
  const exists = await fs.promises.access(file).then(
    () => true,
    () => false
  );
  if (!exists) return [];
  const content = await fs.promises.readFile(file, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("----------"))
    .map((line) => JSON.parse(line));
};

// ----------------------------------------------------------------------------
// A throwing `activate` runs during bootstrap — before the agent is registered.
// ----------------------------------------------------------------------------
const ACTIVATION_MESSAGE = "activation exploded on purpose";

// An instruction file, so the run also covers a bootstrap step that SUCCEEDS: the assertion below
// is that a good step is recorded once, not that every step is.
await fs.promises.writeFile(path.join(rootPath, "AGENTS.md"), "# project instructions\n", "utf8");

const manager = new AgentManager();
const host = createLocalAgentSessionHost({ manager });
const created = await host.create({
  name: "bootstrap-log",
  model: "test-model",
  extensions: [
    {
      create: () => ({
        id: "thrower",
        name: "Throwing extension",
        version: "1.0.0",
        description: "its activate() throws, during bootstrap",
        activate() {
          throw new Error(ACTIVATION_MESSAGE);
        },
      }),
    },
  ],
  builtins: { lsp: false, skills: false, memory: false, mcp: false, codeMode: false },
});

const managed = manager.getAgent(created.session.getSnapshot().agentId);
assert.ok(managed, "the agent is registered after bootstrap");
const sessionId = managed.getSessionData()?.id;
assert.ok(sessionId?.startsWith("ses_"), `session id, got ${sessionId}`);

// The sink flushes on an interval, so poll instead of sleeping a fixed time.
let entries = [];
for (let attempt = 0; attempt < 100; attempt++) {
  entries = await readEntries(sessionId);
  if (entries.some((entry) => entry.event === "agent:extension-error")) break;
  await sleep(25);
}

const activationFailures = entries.filter((entry) => entry.event === "agent:extension-error");
assert.equal(
  activationFailures.length,
  1,
  `exactly one activation failure on disk, got ${activationFailures.length}: ${JSON.stringify(activationFailures)}`
);
const failure = activationFailures[0];
assert.equal(failure.category, "system");
assert.match(failure.message, /thrower/, "the failing extension is named");
assert.match(failure.message, new RegExp(ACTIVATION_MESSAGE), "the thrown message is carried");
assert.equal(failure.level, "error", "a contained activation failure is recorded as a fault, not as a note");

// Bootstrap facts carry no run: they happen before any turn exists. A `run` here would mean the
// envelope took one from somewhere it should not have.
assert.equal(failure.run, undefined, "a bootstrap entry is not run-scoped");

// The bootstrap summary is the single aggregated row, and it also lands pre-registration.
const summary = entries.find((entry) => entry.event === "session:bootstrap-summary");
assert.ok(summary, `bootstrap summary on disk, got ${entries.map((e) => e.event).join(",")}`);
assert.match(summary.message, /Bootstrap complete/, "one row, not one per step");

// A successful step must not have produced its own row: the summary is the aggregate, and
// per-step rows were what made "did bootstrap work?" unanswerable without reading twelve lines.
const docRows = entries.filter((entry) => entry.event === "session:doc");
assert.equal(docRows.length, 1, `one documentation row (the load itself), got ${docRows.length}`);

// ----------------------------------------------------------------------------
// The window closes: after registration the same agent still records, and a
// second failure does not double-write (bind moved from constructionLogs → agents).
// ----------------------------------------------------------------------------
const before = (await readEntries(sessionId)).length;
managed.emitEvent("agent:extension-error", { extensionId: "post-registration", phase: "config", error: "x" });
let afterEntries = [];
for (let attempt = 0; attempt < 100; attempt++) {
  afterEntries = await readEntries(sessionId);
  if (afterEntries.length > before) break;
  await sleep(25);
}
const postRows = afterEntries.filter((entry) => entry.event === "agent:extension-error");
assert.equal(postRows.length, 2, "one pre-registration + one post-registration, each written once");

// The construction binding is released on registration (handed to the registry); a leak would hold
// the agent's log and sink for the life of the manager.
assert.equal(manager.getConstructionLogCount(), 0, "registration releases the construction binding");

// A launch is bounded: the buffer cap is 200, and the measured volume is ~8. A jump here means a
// fact started being recorded once per bootstrap step (the duplicate class this change removed).
assert.ok(
  entries.length <= 12,
  `bootstrap stays a handful of rows, got ${entries.length}: ${entries.map((e) => e.event).join(",")}`
);

// The summary is ONE row: `find` alone would pass even if five were written.
assert.equal(
  entries.filter((entry) => entry.event === "session:bootstrap-summary").length,
  1,
  "exactly one bootstrap summary row"
);

// The construction binding is released on registration: a second bind would not be reached, but
// an unresolved id after teardown must simply produce nothing rather than throw.
await host.destroy(created.session.id);
assert.equal(manager.getConstructionLogCount(), 0, "teardown leaves no construction binding");

console.log("bootstrap-log-binding validation passed");
console.log("  pre-registration failures on disk:", activationFailures.length);
console.log("  bootstrap entries:", entries.length);

await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);
