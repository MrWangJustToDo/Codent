/**
 * Cross-process session exclusivity.
 *
 * Two terminals resuming the same id both "claimed" it — `SessionOwnership` is process-local — and
 * appended to one JSONL, which `load()` folded into a merged transcript. The fix is a sidecar lock
 * whose content names the owner and whose mtime is the heartbeat.
 *
 * Cases:
 * 1. A live lock refuses a second owner, and names the holder.
 * 2. Release hands it over.
 * 3. A stale lock (mtime past the TTL) is taken over — a crash must not block the id forever.
 * 4. An unparsable file counts as stale (a truncated write is not a holder).
 * 5. The previous owner's release must NOT delete a lock someone else took over.
 * 6. One runtime holds one session at a time: acquiring another id releases the previous.
 * 7. Contenders elect one winner before the canonical file exists: an earlier foreign ticket beats
 *    a later one even when no lock file has been written yet.
 *
 * Run: pnpm --filter @codent/core run validate:session-lock
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  SESSION_LOCK_TTL_MS,
  SessionLock,
  SessionLockController,
  SessionLockedError,
  sessionLockPath,
} from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const root = mkdtempSync(join(tmpdir(), "codent-lock-"));
const lockPath = (id) => join(root, sessionLockPath(id));

/** A `ResolvedCoreEnv`-shaped object whose fs is the real one, rooted at the temp dir. */
function fakeEnv(base) {
  const resolve = (rel) => (rel.startsWith("/") ? rel : join(base, rel));
  return {
    rootPath: base,
    fs: {
      readFile: async (rel) => readFileSync(resolve(rel), "utf8"),
      writeFile: async (rel, content) => {
        mkdirSync(dirname(resolve(rel)), { recursive: true });
        writeFileSync(resolve(rel), content);
      },
      remove: async (rel) => {
        rmSync(resolve(rel), { force: true });
      },
      stat: async (rel) => {
        const s = statSync(resolve(rel));
        return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, mtime: s.mtime };
      },
      exists: async (rel) => existsSync(resolve(rel)),
      mkdir: async (rel) => mkdirSync(resolve(rel), { recursive: true }),
      readdir: async (rel) =>
        readdirSync(resolve(rel), { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        })),
    },
    path: { dirname, basename, join },
  };
}

const env = fakeEnv(root);

/** Write a lock file exactly as another PROCESS would have left it. */
function writeForeignLock(id, { instance = "other-instance", ageMs = 0, agent = "main", raw } = {}) {
  mkdirSync(dirname(lockPath(id)), { recursive: true });
  writeFileSync(
    lockPath(id),
    raw ??
      JSON.stringify({
        owner: `${instance}:${agent}`,
        instance,
        pid: 999_999,
        since: Date.now() - ageMs,
      })
  );
  if (ageMs > 0) {
    const seconds = (Date.now() - ageMs) / 1000;
    utimesSync(lockPath(id), seconds, seconds);
  }
}

// A lock path derived from an unsafe id must fail before any filesystem access.
assert.throws(() => sessionLockPath("../escape"), /Invalid session id/, "the lock path validates its id");

// ---------------------------------------------------------------------------
// 1. A live lock from another PROCESS refuses and names the holder
// ---------------------------------------------------------------------------
{
  // The file is written directly: `PROCESS_INSTANCE_ID` is per module instance, so a second lock in
  // this process can never impersonate another process — the on-disk record is the honest shape.
  writeForeignLock("ses-1");
  const owner = new SessionLock(env, "main");

  const refused = await owner.acquire("ses-1");
  assert.equal(refused.ok, false, "a live lock refuses another process");
  assert.ok(typeof refused.held?.owner === "string" && refused.held.owner.length > 0, "and names the holder");
  // Composed with a per-process instance, which is what separates two processes that both call their
  // root agent "main".
  assert.match(refused.held.owner, /:main$/, "the owner id carries the agent id of the holder");

  const error = new SessionLockedError("ses-1", refused.held);
  assert.match(error.message, /open in another process/, "the refusal is explainable to a user");
  assert.match(error.message, /ses-1/);
  owner.dispose();

  // 1b. Two instances in THIS process are the same owner: the in-process table arbitrates them, so
  // the file lock must not invent a conflict it cannot adjudicate.
  rmSync(lockPath("ses-1"), { force: true });
  const a = new SessionLock(env, "main");
  const b = new SessionLock(env, "another-agent");
  assert.deepEqual(await a.acquire("ses-1"), { ok: true }, "the first agent acquires");
  assert.deepEqual(await b.acquire("ses-1"), { ok: true }, "a second agent in the same process is not a conflict");
  // 1c. Re-acquiring the id it already holds is idempotent, not a self-conflict.
  assert.deepEqual(await a.acquire("ses-1"), { ok: true }, "self re-acquire is idempotent");
  await b.release();
  a.dispose();
  b.dispose();
}

// ---------------------------------------------------------------------------
// 2. A released lock is free
// ---------------------------------------------------------------------------
{
  const owner = new SessionLock(env, "main");
  assert.deepEqual(await owner.acquire("ses-2"), { ok: true });
  await owner.release();
  assert.equal(existsSync(lockPath("ses-2")), false, "release removes the file it owns");
  const next = new SessionLock(env, "main");
  assert.deepEqual(await next.acquire("ses-2"), { ok: true }, "the id is free after release");
  next.dispose();
  owner.dispose();
}

// ---------------------------------------------------------------------------
// 3. A stale lock (past the TTL) is taken over — a crash must not block the id
// ---------------------------------------------------------------------------
{
  writeForeignLock("ses-stale", { instance: "dead-process", ageMs: SESSION_LOCK_TTL_MS + 5_000 });
  const alive = new SessionLock(env, "live-process");
  assert.deepEqual(await alive.acquire("ses-stale"), { ok: true }, "an expired lock is adopted, not honoured");
  const content = JSON.parse(readFileSync(lockPath("ses-stale"), "utf8"));
  assert.equal(content.owner.endsWith(":live-process"), true, "the file now names the new holder");

  // 5. Another owner's release must not undo the takeover: `release` deletes only the file it can
  // prove it wrote.
  const zombie = new SessionLock(env, "crashed-agent");
  await zombie.release("ses-stale");
  assert.equal(existsSync(lockPath("ses-stale")), true, "a foreign release cannot delete the current lock");
  alive.dispose();
  zombie.dispose();
  rmSync(lockPath("ses-stale"), { force: true });
}

// ---------------------------------------------------------------------------
// 3. A stale lock (past the TTL) is taken over — a crash must not block the id
// ---------------------------------------------------------------------------
{
  const dead = new SessionLock(env, "dead-process");
  const alive = new SessionLock(env, "live-process");
  assert.deepEqual(await dead.acquire("ses-stale"), { ok: true });
  dead.dispose();
  // `dispose` stops the heartbeat without releasing: exactly the crash shape. Age the file past the
  // TTL so the takeover branch is what answers.
  const old = (Date.now() - SESSION_LOCK_TTL_MS - 5_000) / 1000;
  utimesSync(lockPath("ses-stale"), old, old);

  assert.deepEqual(await alive.acquire("ses-stale"), { ok: true }, "an expired lock is adopted, not honoured");
  const content = JSON.parse(readFileSync(lockPath("ses-stale"), "utf8"));
  assert.equal(content.owner.endsWith(":live-process"), true, "the file now names the new holder");

  // 5. The previous owner's teardown must not undo the takeover.
  await dead.release("ses-stale");
  assert.equal(existsSync(lockPath("ses-stale")), true, "a stale owner cannot delete the current lock");
  assert.equal(
    JSON.parse(readFileSync(lockPath("ses-stale"), "utf8")).owner.endsWith(":live-process"),
    true,
    "and the file still belongs to the new holder"
  );
  alive.dispose();
  rmSync(lockPath("ses-stale"), { force: true });
}

// ---------------------------------------------------------------------------
// 4. An unparsable lock file counts as stale, not as a holder
// ---------------------------------------------------------------------------
{
  mkdirSync(dirname(lockPath("ses-garbage")), { recursive: true });
  writeFileSync(lockPath("ses-garbage"), "{ truncated");
  const lock = new SessionLock(env, "after-garbage");
  assert.deepEqual(
    await lock.acquire("ses-garbage"),
    { ok: true },
    "a half-written file is a crashed writer, not an owner"
  );
  lock.dispose();
}

// ---------------------------------------------------------------------------
// 5b. Contenders elect one winner BEFORE the canonical file exists
//
// `writeFile` has no exclusive create. A foreign ticket that queued earlier must win even when the
// canonical lock is absent, and a ticket that queued later must lose to us.
// ---------------------------------------------------------------------------
{
  const id = "ses-race";
  mkdirSync(dirname(lockPath(id)), { recursive: true });
  const ticket = (queuedAt) => `${lockPath(id)}.${queuedAt.toString(36)}-foreign`;

  const earlierTicket = ticket(Date.now() - 1_000);
  writeFileSync(
    earlierTicket,
    JSON.stringify({ owner: "other-process:main", instance: "other-process", since: Date.now() - 1_000 })
  );
  const late = new SessionLock(env, "late-process");
  const refused = await late.acquire(id);
  assert.equal(refused.ok, false, "an earlier foreign contender wins the election");
  assert.equal(refused.held?.owner, "other-process:main", "and the refusal names it");
  late.dispose();
  rmSync(earlierTicket, { force: true });

  // A later contender cannot block us: our ticket is the earliest fresh one.
  rmSync(lockPath(id), { force: true });
  const future = `${lockPath(id)}.${(Date.now() + 60_000).toString(36)}-later`;
  writeFileSync(future, JSON.stringify({ owner: "later-process:main", instance: "later-process", since: Date.now() }));
  const early = new SessionLock(env, "early-process");
  assert.deepEqual(await early.acquire(id), { ok: true }, "an earlier ticket wins over a later one");
  assert.equal(existsSync(lockPath(id)), true, "the winner published the canonical lock");
  rmSync(future, { force: true });
  assert.equal(
    readdirSync(dirname(lockPath(id))).some((name) => name.startsWith(`${id}.session.lock.`)),
    false,
    "no contender tickets are left behind by this process"
  );
  early.dispose();
  rmSync(lockPath(id), { force: true });
}

// ---------------------------------------------------------------------------
// 6. One session at a time: acquiring another id releases the previous
// ---------------------------------------------------------------------------
{
  const lock = new SessionLock(env, "single-slot");
  assert.deepEqual(await lock.acquire("ses-a"), { ok: true });
  assert.equal(existsSync(lockPath("ses-a")), true);
  assert.deepEqual(await lock.acquire("ses-b"), { ok: true }, "a switch acquires the target");
  assert.equal(existsSync(lockPath("ses-a")), false, "and hands the departure back in the same step");
  assert.equal(lock.getSessionId(), "ses-b", "the slot follows the active session");
  lock.dispose();

  // The heartbeat must not keep a host alive: a lock that is disposed leaves no live interval.
  // (Asserted structurally — the timer is unref'd, so this process exits on its own.)
  rmSync(lockPath("ses-b"), { force: true });
}

// ---------------------------------------------------------------------------
// 7. The CONTROLLER path: fresh create, refusal, IO degradation, takeover recovery
// ---------------------------------------------------------------------------
{
  // A brand-new session has no `.agents/sessions/` directory yet; create now takes the lock BEFORE
  // the first persist, so the sidecar write must create it instead of failing create with ENOENT.
  const freshRoot = mkdtempSync(join(tmpdir(), "codent-lock-fresh-"));
  const freshEnv = fakeEnv(freshRoot);
  const fresh = new SessionLockController();
  fresh.setOwner("fresh-agent");
  await fresh.lockSession("ses-fresh", freshEnv);
  assert.equal(
    existsSync(join(freshRoot, sessionLockPath("ses-fresh"))),
    true,
    "a fresh session's lock directory is created by the lock, not required beforehand"
  );
  await fresh.releaseAll();
  assert.equal(
    existsSync(join(freshRoot, sessionLockPath("ses-fresh"))),
    false,
    "and the lock is released with its own record"
  );
  rmSync(freshRoot, TEMP_RM_OPTIONS);
}

{
  // A live foreign holder refuses a controller-level acquire with the explainable error.
  writeForeignLock("ses-controller-held");
  const contender = new SessionLockController();
  contender.setOwner("contender");
  await assert.rejects(
    () => contender.lockSession("ses-controller-held", env),
    (error) => error instanceof SessionLockedError && /open in another process/.test(error.message),
    "the controller surfaces SessionLockedError for a live holder"
  );
  await contender.releaseAll();
  rmSync(lockPath("ses-controller-held"), { force: true });
}

{
  // A read-only / full disk must DEGRADE, not fail: the lock is advisory, and create now takes it
  // on every startup.
  const brokenEnv = {
    ...env,
    fs: {
      ...env.fs,
      writeFile: async () => {
        throw new Error("EROFS");
      },
    },
  };
  const readonly = new SessionLockController();
  readonly.setOwner("readonly-agent");
  await assert.doesNotReject(
    () => readonly.lockSession("ses-readonly", brokenEnv),
    "an unwritable sidecar degrades to the in-process claim"
  );
  await readonly.releaseAll();
}

{
  // A peer takes over (fresh foreign file), the heartbeat notices, the lost handler fires, writes are
  // refused, and the next message recovers once the peer is gone.
  const tracked = new SessionLockController();
  tracked.setOwner("lost-agent");
  const notices = [];
  tracked.setLostHandler((sessionId) => notices.push(sessionId));

  await tracked.lockSession("ses-lost", env);
  assert.equal(tracked.hasLost("ses-lost"), false, "a held lock is not lost");

  writeForeignLock("ses-lost", { instance: "peer", agent: "main" });
  assert.equal(await tracked.refreshOwnership(env), "lost", "the heartbeat detects a foreign takeover");
  assert.deepEqual(notices, ["ses-lost"], "and reports it exactly once");
  assert.equal(tracked.hasLost("ses-lost"), true, "writes are refused from here on");

  // The peer exits: the next write-path recovery re-acquires instead of staying read-only forever.
  rmSync(lockPath("ses-lost"), { force: true });
  assert.equal(await tracked.reacquireLost(env), true, "recovery re-acquires a free lock");
  assert.equal(tracked.hasLost("ses-lost"), false, "and writes are allowed again");
  await tracked.releaseAll();
}

rmSync(root, TEMP_RM_OPTIONS);
console.log("session-lock validation passed");
