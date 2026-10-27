/**
 * An idle agent must be WOKEN by a finished background job.
 *
 * The completion notification is a one-shot push from `background-middleware`, injected at the next
 * model call. An agent that finished its turn makes no model call, so the result of a
 * `run_in_background` command used to sit un-notified until the user typed something. The registry
 * now reports which jobs actually just finished (`finished`), and the owning agent starts a turn
 * for an idle session so that push happens on its own.
 *
 * What this validator locks down:
 *  1. Only a TERMINAL transition is news. `create` / eviction / restore notifications carry an
 *     empty `finished`, so resuming a session can never start a turn by itself.
 *  2. The wake decision: idle ⇒ one turn; live pump, approval park (`waiting` / `awaiting_user`),
 *     manual compaction and plan review ⇒ no turn (the notification rides the next model call of
 *     the run that is already there, which is the previous behavior).
 *  3. A subagent is never woken: it has no user, and its turn belongs to its parent.
 *  4. The wake does not consume the notification. Delivery and the notified flag stay with the
 *     middleware — a wake that marked the job would race the injection and lose the output.
 *  5. End to end (section 8), with the SHIPPED middleware pipeline and a capturing text adapter:
 *     the wake really starts a turn, the notification reaches the model, and the job is marked
 *     notified exactly once. Sections 1-7 stub the pump, because they assert the DECISION.
 *
 * Run: pnpm --filter @codent/core run validate:background-wake
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { clearCoreEnv, registerCoreEnv } from "../dist/dev.mjs";
import { AgentManager } from "../dist/index.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

// ============================================================================
// Fixture
// ============================================================================

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "background-wake-"));
const toAbs = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));

/** `onExit` handles of the jobs this fixture started, in start order. */
const exits = [];

registerCoreEnv({
  rootPath,
  getPlatform: async () => "linux",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => rootPath,
  fs: {
    readFile: async (p, encoding) => fs.promises.readFile(toAbs(p), encoding),
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
        return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
      } catch {
        return [];
      }
    },
    stat: async (p) => {
      const stat = await fs.promises.stat(toAbs(p));
      return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size, mtime: stat.mtime };
    },
    remove: async (p) => fs.promises.rm(toAbs(p), TEMP_RM_OPTIONS),
  },
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => new Response(),
  // The fixture drives the exit callback by hand instead of forking a process.
  startCommand: async (_command, handlers) => {
    exits.push(handlers);
    return { pid: 4242, kill: async () => {} };
  },
});

const manager = new AgentManager();
const managed = await manager.createManagedAgent({ name: "background-wake", model: "test-model" });
const chat = managed.initChat(manager);

/** Turn starts requested by the wake path — the pump itself is never run here. */
let wakes = 0;
chat.enqueueRunOnce = async () => {
  wakes += 1;
};

/** Let the wake path's `collectCompleted()` promise chain settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const commandService = managed.getCommandService();

/** Start a job and return its id (the exit callback waits in `exits`). */
async function startJob(command) {
  const { jobId } = await commandService.startBackground({
    command,
    toolCallId: `tc-${exits.length}`,
    coreEnv: managed.getCoreEnv(),
  });
  return jobId;
}

/** Finish the most recently started job and let the resulting notification settle. */
async function finishLastJob(exitCode = 0) {
  exits.at(-1).onExit(exitCode);
  await flush();
}

/** Start + finish a job in one step, returning its id. */
async function runJob(command) {
  const jobId = await startJob(command);
  await finishLastJob(0);
  return jobId;
}

// ============================================================================
// 1. An idle session is woken, and the notification is left for the middleware
// ============================================================================

const firstJob = await startJob("npm run build");
assert.equal(wakes, 0, "starting a job is not a completion and must not start a turn");

await finishLastJob(0);
assert.equal(wakes, 1, "a job finishing while the agent is idle starts exactly one turn");
assert.deepEqual(
  (await commandService.collectCompleted()).map((job) => job.id),
  [firstJob],
  "the wake peeks — delivery (and the notified flag) still belong to the middleware"
);

// With nothing left to deliver, a wake is a no-op rather than a bare model turn.
await commandService.markNotified([firstJob]);
await managed.wakeForBackgroundJobs();
assert.equal(wakes, 1, "no un-notified completion ⇒ no turn");

// ============================================================================
// 2. A live pump keeps the old behavior (the notification rides its next call)
// ============================================================================

chat.pumpDepth = 1;
const duringRun = await runJob("npm test");
assert.equal(wakes, 1, "a finishing job never starts a second turn while one is running");
await commandService.markNotified([duringRun]);
chat.pumpDepth = 0;

// ============================================================================
// 3. A session parked on the user is not resumed behind their back
// ============================================================================

for (const parked of ["waiting", "awaiting_user"]) {
  managed.setStatus(parked, "validator");
  const jobId = await runJob(`parked ${parked}`);
  assert.equal(wakes, 1, `a ${parked} session is not woken (the answer's pump delivers instead)`);
  await commandService.markNotified([jobId]);
}

// ============================================================================
// 4. Manual compaction owns the transcript and is not a pump
// ============================================================================

managed.setStatus("compacting", "manual-compact");
const duringCompact = await runJob("npm run lint");
assert.equal(wakes, 1, "a turn is not started on top of a running compaction");
await commandService.markNotified([duringCompact]);
managed.setStatus("idle", "validator");

// ============================================================================
// 5. Plan review is an interactive pause: the user starts the next turn
// ============================================================================

managed.planMode.enable();
const applied = await managed.planMode.applyStructuredPlan({
  goal: "Ship the change",
  steps: ["Do the thing"],
  keyFiles: ["packages/core/src/index.ts"],
});
assert.equal(applied.ok, true, "fixture: the plan is in review");
assert.equal(managed.planMode.getPhase(), "ready");

const duringReview = await runJob("echo reviewed");
assert.equal(wakes, 1, "plan review is not woken — the model would revise the plan unprompted");
await commandService.markNotified([duringReview]);
managed.planMode.disable();
managed.setStatus("idle", "validator");

// ============================================================================
// 6. A subagent has no user to notify
// ============================================================================

managed.parentId = "parent-agent";
const fromWorker = await runJob("echo worker");
assert.equal(wakes, 1, "a subagent's completion never starts a turn");
await commandService.markNotified([fromWorker]);
delete managed.parentId;

// ============================================================================
// 7. Back to idle: the guard is a state, not a one-way latch
// ============================================================================

const afterAll = await runJob("echo done");
assert.equal(wakes, 2, "the session wakes again once it is idle and something is pending");
await commandService.markNotified([afterAll]);

// ============================================================================
// 8. End to end: the wake produces a real turn that delivers the notification
// ============================================================================

/** Capture what the adapter is handed, and produce one plain answer per call. */
function makeCapturingAdapter() {
  const calls = [];
  return {
    calls,
    config: {
      adapter: {
        kind: "text",
        name: "capturing",
        model: "capturing-model",
        "~types": {},
        chatStream(options) {
          calls.push(options.messages);
          return (async function* () {
            yield { type: "TEXT_MESSAGE_CONTENT", delta: "The build finished." };
            yield { type: "RUN_FINISHED", finishReason: "stop" };
          })();
        },
        async structuredOutput() {
          throw new Error("not implemented");
        },
      },
      model: "capturing-model",
      modelStyle: "openai",
    },
  };
}

{
  const e2e = await manager.createManagedAgent({ name: "background-wake-e2e", model: "capturing-model" });
  const { calls, config } = makeCapturingAdapter();
  // The real pipeline builds the runner from this adapter, so the middleware stack (and the
  // notification push inside it) is the shipped one — no stubs.
  e2e.setTextAdapter(config);
  const e2eChat = e2e.initChat(manager);
  e2eChat.getUIChannel().addUserMessage("start the build in the background");
  const e2eService = e2e.getCommandService();

  const started = await e2eService.startBackground({
    command: "npm run build",
    toolCallId: "tc-e2e",
    coreEnv: e2e.getCoreEnv(),
  });
  assert.equal(calls.length, 0, "no turn runs before the job finishes");

  exits.at(-1).onExit(0);
  await flush();
  // The wake enqueued a real pump; wait for it to finish rather than sleeping.
  await e2eChat.runChain;

  assert.ok(calls.length > 0, "the finished job started a real turn");
  const wire = calls.flat().map((message) => String(message.content ?? ""));
  assert.ok(
    wire.some((text) => text.includes(`Job ${started.jobId} finished with status completed`)),
    "the notification reaches the model on the wake turn"
  );
  assert.deepEqual(
    await e2eService.collectCompleted(),
    [],
    "the injected notification is marked notified, so it is delivered exactly once"
  );
  assert.equal(e2e.getStatus(), "completed", "the wake turn ends like any other turn");
  manager.destroyAgent(e2e.id);
}

// ============================================================================
// Cleanup
// ============================================================================

clearCoreEnv();
manager.destroyAgent(managed.id);
await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);

console.log("background wake validation passed");
