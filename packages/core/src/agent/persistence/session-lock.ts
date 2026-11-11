/**
 * Cross-process ownership of one persisted session log.
 *
 * The in-process claim (`SessionOwnership`) cannot see another process, so two terminals resuming
 * the same id both "claimed" it and appended to the same `<id>.session.jsonl`; `load()` folds by
 * message id, so the two conversations were merged into one transcript. The empty-session
 * reservation only ever protected "pick me a fresh session", which is why the same two terminals
 * could still collide on an explicit `--resume`.
 *
 * This is the cross-process half: a sidecar file next to the log (`<id>.session.lock`) whose
 * CONTENT names the owner and whose MTIME is the heartbeat. Two signals, deliberately:
 *
 * - **content** decides who holds it (a stale file is not "not held", it is "held by a dead
 *   process");
 * - **mtime** decides whether that holder is still alive, because a process that dies cannot clear
 *   anything. Staleness is advisory: a lock left by a crash blocks a resume for at most
 *   {@link SESSION_LOCK_TTL_MS} instead of forever, which is the same shape as the reservation TTL.
 *
 * One lock is held at a time (the session the agent is on). Acquiring a different id releases the
 * previous one, and the heartbeat only refreshes the current id — a `/resume` therefore hands the
 * departure over at the moment the target is read, which is before the switch commits. That window
 * is accepted: the departure is immediately re-acquired by the failed-load recovery, and a foreign
 * process would have to be resuming that exact id in those milliseconds.
 */

import { sessionLockPath } from "./types.js";

import type { ResolvedCoreEnv } from "../../env";

/** How long a lock stays valid without a heartbeat. */
export const SESSION_LOCK_TTL_MS = 120_000;
/** Heartbeat period. Must be well under the TTL so one delayed tick is not a false stale. */
const SESSION_LOCK_REFRESH_MS = 30_000;
/**
 * How long a contender waits before reading the ticket directory.
 *
 * `writeFile` has no exclusive-create flag, so an "inspect then write" claim let two processes both
 * see a free lock and both write it. Every contender publishes a unique ticket, waits this window,
 * and only the earliest fresh ticket may write the canonical file.
 */
const SESSION_LOCK_SETTLE_MS = 25;
/** Jitter so two contenders that start in the same millisecond rarely list before the other writes. */
const SESSION_LOCK_SETTLE_JITTER_MS = 25;

/** The queued-at timestamp encoded in a ticket file name (`<lock>.<timestamp36>-<seq>`). */
function parseTicketTime(name: string, prefix: string): number | null {
  const stamp = name.slice(prefix.length).split("-")[0];
  const value = Number.parseInt(stamp ?? "", 36);
  return Number.isFinite(value) ? value : null;
}

/**
 * Distinguishes two processes that call their agent the same thing.
 *
 * Generated once per process, deliberately not derived from the pid: the pid is meaningless for a
 * lock written through a remote CoreEnv (it would name the CLIENT process while the file lives on
 * the server). The field is recorded for diagnostics only and never compared across hosts.
 */
const PROCESS_INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The recorded holder. */
export interface SessionLockRecord {
  /** Which runtime holds it — `instanceId:agentId`, unique across processes. */
  owner: string;
  /**
   * The writing PROCESS (not the agent). Two agents inside one process are the same instance: the
   * in-process ownership table is what arbitrates them, and refusing here would duplicate that
   * arbitration with a worse error. The file lock's job is only the case the table cannot see.
   */
  instance?: string;
  /** Owning OS process when the host can report one (diagnostics only). */
  pid?: number;
  /** Epoch ms when the holder acquired it. */
  since: number;
}

export type SessionLockAcquisition = { ok: true } | { ok: false; held: SessionLockRecord };

/** A session log an owner refused to share. Thrown out of the restore read, so the switch's own
 * failure path (abort the claim, re-open the departure) handles it like any other failed load. */
export class SessionLockedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly held: SessionLockRecord
  ) {
    const since = new Date(held.since);
    const age = Math.max(0, Math.round((Date.now() - held.since) / 1000));
    super(
      `Session "${sessionId}" is open in another process (${held.owner}, held for ${age}s since ${since.toISOString()}). ` +
        `Close it there, or try again in ${Math.ceil(SESSION_LOCK_TTL_MS / 60_000)} minutes if that process is gone.`
    );
    this.name = "SessionLockedError";
  }
}

/** Parse a lock file defensively: a truncated/foreign file is treated as stale, not as a fatal. */
function parseLock(text: string): SessionLockRecord | null {
  try {
    const value = JSON.parse(text) as Partial<SessionLockRecord>;
    if (typeof value?.owner !== "string" || !value.owner) return null;
    return {
      owner: value.owner,
      ...(typeof value.instance === "string" ? { instance: value.instance } : {}),
      ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
      since: typeof value.since === "number" ? value.since : 0,
    };
  } catch {
    return null;
  }
}

export class SessionLock {
  /** The one session this runtime is on. */
  private current: string | undefined;
  /** Makes this process's tickets unique within the process. */
  private ticketSeq = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Set when a refresh found the file taken by someone else: stop pretending to hold it. */
  private lost = false;

  constructor(
    private readonly env: ResolvedCoreEnv,
    ownerId: string,
    /** Called at most once per lost lock, so a repeated refresh does not spam the timeline. */
    private readonly onLost?: (sessionId: string) => void
  ) {
    this.owner = `${PROCESS_INSTANCE_ID}:${ownerId}`;
  }

  /** The composed owner id (`<process instance>:<agent id>`). */
  private readonly owner: string;

  /** The session this lock currently protects (undefined when it holds none). */
  getSessionId(): string | undefined {
    return this.lost ? undefined : this.current;
  }

  /**
   * Take the lock for `sessionId`, handing over the previous one.
   *
   * Idempotent for the id already held (it refreshes instead of consulting the file, so a slow
   * heartbeat cannot make an owner reject itself).
   */
  async acquire(sessionId: string): Promise<SessionLockAcquisition> {
    if (!this.lost && this.current === sessionId) {
      await this.write(sessionId, Date.now());
      return { ok: true };
    }
    const taken = await this.inspect(sessionId);
    // A holder in THIS process is not a conflict: the in-process `SessionOwnership` already
    // arbitrates between agents (and two runtime harnesses in one process share that table or
    // deliberately do not). Only another PROCESS can corrupt the log behind our back.
    if (taken && taken.owner !== this.owner && !this.isSameProcess(taken)) return { ok: false, held: taken };

    // An absent/stale canonical file is not enough: `writeFile` cannot create exclusively, so two
    // processes inspecting "free" would both write and both believe they own it. Elect one
    // contender first, then let only the winner publish the canonical file.
    const contest = await this.contest(sessionId);
    if (!contest.ok) return { ok: false, held: contest.held };
    try {
      const previous = this.current;
      await this.write(sessionId, taken?.since ?? Date.now());
      this.current = sessionId;
      this.lost = false;
      this.startHeartbeat();
      if (previous !== undefined && previous !== sessionId) await this.release(previous);
      return { ok: true };
    } finally {
      // The winner's ticket stays on disk until the canonical write has happened, so a late
      // contender's settle window still sees it; then it is removed.
      await this.env.fs.remove(contest.ticket).catch(() => undefined);
    }
  }

  /**
   * Elect one contender for the canonical lock.
   *
   * Each contender writes a UNIQUE ticket (`<lock>.<timestamp36>-<seq>`), waits a short settle
   * window, and lists the directory: the earliest fresh FOREIGN ticket wins. Same-process tickets
   * are ignored (the in-process ownership table arbitrates those), and a later contender sees the
   * earlier ticket and loses. The winner keeps its ticket until the canonical write completes.
   */
  private async contest(
    sessionId: string
  ): Promise<{ ok: true; ticket: string } | { ok: false; held: SessionLockRecord }> {
    const canonical = sessionLockPath(sessionId);
    const dir = this.env.path.dirname(canonical);
    // A fresh session's directory may not exist yet; the ticket write below would fail and silently
    // skip the election. `write()` ensures this too, but the order is inspect → CONTEST → write.
    await this.ensureDir(dir);
    const prefix = `${this.env.path.basename(canonical)}.`;
    const queuedAt = Date.now();
    const ticket = `${canonical}.${queuedAt.toString(36)}-${(this.ticketSeq += 1).toString(36)}`;
    const mine = this.env.path.basename(ticket);
    try {
      await this.env.fs.writeFile(ticket, JSON.stringify(this.record(queuedAt)));
    } catch {
      // Cannot publish a ticket (read-only dir / embedded host): degrade to the direct canonical
      // claim. Blocking the session instead would be worse than the residual race.
      return { ok: true, ticket };
    }

    await new Promise((resolve) =>
      setTimeout(resolve, SESSION_LOCK_SETTLE_MS + Math.floor(Math.random() * SESSION_LOCK_SETTLE_JITTER_MS))
    );

    let entries;
    try {
      entries = await this.env.fs.readdir(dir);
    } catch {
      return { ok: true, ticket };
    }

    let winner: { name: string; at: number } = { name: mine, at: queuedAt };
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix)) continue;
      const ticketPath = this.env.path.join(dir, entry.name);
      let mtime = 0;
      try {
        mtime = (await this.env.fs.stat(ticketPath)).mtime.getTime();
      } catch {
        mtime = 0;
      }
      if (!Number.isFinite(mtime) || Date.now() - mtime > SESSION_LOCK_TTL_MS) {
        if (entry.name !== mine) void this.env.fs.remove(ticketPath).catch(() => undefined);
        continue;
      }
      let record: SessionLockRecord | null = null;
      try {
        record = parseLock(await this.env.fs.readFile(ticketPath));
      } catch {
        record = null;
      }
      // A truncated ticket is a crashed writer, not a contender; a same-process ticket is handled
      // by the in-process table.
      if (!record || this.isSameProcess(record)) continue;
      const at = parseTicketTime(entry.name, prefix);
      if (at === null) continue;
      if (at < winner.at || (at === winner.at && entry.name < winner.name)) winner = { name: entry.name, at };
    }

    if (winner.name === mine) return { ok: true, ticket };
    await this.env.fs.remove(ticket).catch(() => undefined);
    const winnerPath = this.env.path.join(dir, winner.name);
    let held: SessionLockRecord | null = null;
    try {
      held = parseLock(await this.env.fs.readFile(winnerPath));
    } catch {
      held = null;
    }
    return { ok: false, held: held ?? { owner: winner.name, since: winner.at } };
  }

  /** Drop one session's lock if this runtime holds it (idempotent). */
  async release(sessionId?: string): Promise<void> {
    const target = sessionId ?? this.current;
    if (target === undefined) return;
    if (target === this.current) this.current = undefined;
    if (this.current === undefined) this.stopHeartbeat();
    try {
      const held = await this.inspect(target);
      // Only delete our own file: a takeover (stale lock claimed by another process) must not be
      // undone by the previous owner's teardown.
      if (held && held.owner !== this.owner) return;
      await this.env.fs.remove(sessionLockPath(target));
    } catch {
      // Best-effort: the TTL expires it.
    }
  }

  /** Release whatever is held (teardown). */
  async releaseAll(): Promise<void> {
    await this.release();
  }

  /** Stop the heartbeat without touching disk (the store is going away). */
  dispose(): void {
    this.stopHeartbeat();
    this.current = undefined;
  }

  /**
   * Read the current holder, treating an expired file as absent.
   *
   * `stat` is the freshness source: a host whose fs cannot report mtime cannot distinguish a live
   * owner from a dead one, so it reports "not held" and the feature degrades to the old behaviour
   * (in-process only) rather than blocking every resume.
   */
  private async inspect(sessionId: string): Promise<SessionLockRecord | null> {
    const path = sessionLockPath(sessionId);
    let text: string;
    try {
      text = await this.env.fs.readFile(path);
    } catch {
      return null;
    }
    let mtimeMs: number;
    try {
      mtimeMs = (await this.env.fs.stat(path)).mtime.getTime();
    } catch {
      return null;
    }
    if (!Number.isFinite(mtimeMs)) return null;
    if (Date.now() - mtimeMs > SESSION_LOCK_TTL_MS) return null;
    const record = parseLock(text);
    if (!record) return null;
    return record;
  }

  private record(since: number): SessionLockRecord {
    return {
      owner: this.owner,
      instance: PROCESS_INSTANCE_ID,
      ...(typeof process !== "undefined" && typeof process.pid === "number" ? { pid: process.pid } : {}),
      since,
    };
  }

  private async write(sessionId: string, since: number): Promise<void> {
    const path = sessionLockPath(sessionId);
    // A FRESH session has no directory yet — the store creates it on the first save, and a create
    // now takes the lock BEFORE that write. Without this, startup failed with ENOENT on the lock.
    await this.ensureDir(this.env.path.dirname(path));
    await this.env.fs.writeFile(path, JSON.stringify(this.record(since)));
  }

  /** Best-effort `mkdir` for the lock's directory (a read-only host degrades at the write). */
  private async ensureDir(dir: string): Promise<void> {
    try {
      if (this.env.fs.mkdir) await this.env.fs.mkdir(dir);
      else this.env.fs.mkdirSync?.(dir);
    } catch {
      // Best-effort: the caller's write reports the real failure.
    }
  }

  /**
   * Whether `held` was written by this very process.
   *
   * `instance` is the direct evidence. A file without one (hand-written, or produced by an older
   * build) falls back to the pid, which is the same fact observed a weaker way.
   */
  private isSameProcess(held: SessionLockRecord): boolean {
    if (held.instance !== undefined) return held.instance === PROCESS_INSTANCE_ID;
    return typeof held.pid === "number" && typeof process !== "undefined" && held.pid === process.pid;
  }

  private startHeartbeat(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.beat(), SESSION_LOCK_REFRESH_MS);
    // Never keep a process alive for a heartbeat.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Re-verify ownership once and refresh the heartbeat.
   *
   * Public so a validation can drive the takeover path without waiting for the 30 s tick; the timer
   * calls exactly this method. Returns `"lost"` when a peer took the lock over (the heartbeat stops
   * and `onLost` fires once).
   */
  async refreshOwnership(): Promise<"held" | "lost"> {
    const sessionId = this.current;
    if (this.lost) return "lost";
    if (sessionId === undefined) return "held";
    try {
      // Re-verify ownership before refreshing: another process may have taken over after a stale
      // window, and rewriting the file would silently steal the session back mid-run.
      const held = await this.inspect(sessionId);
      if (held && held.owner !== this.owner && !this.isSameProcess(held)) {
        this.lost = true;
        this.current = undefined;
        this.stopHeartbeat();
        this.onLost?.(sessionId);
        return "lost";
      }
      await this.write(sessionId, held?.since ?? Date.now());
      return "held";
    } catch {
      // A failed beat is not a lost lock: the next tick retries, and the TTL is generous.
      return "held";
    }
  }

  private async beat(): Promise<void> {
    await this.refreshOwnership();
  }
}

/**
 * The per-agent facade over {@link SessionLock}.
 *
 * Session persistence needs four operations (name the owner, take the lock a commit landed on,
 * hand it back after a failed read, release on close) and no knowledge of the election or the
 * heartbeat. Keeping that here keeps `SessionService` under its size budget and lets a duck-typed
 * host without the required fs capability degrade to the in-process claim in one place.
 */
export class SessionLockController {
  private lock: SessionLock | null = null;
  private ownerId: string | undefined;
  /** Set when a heartbeat found the lock taken over by another process. */
  private lostSessionId: string | undefined;
  private lostHandler: ((sessionId: string) => void) | undefined;

  setOwner(ownerId: string): void {
    // The previous lock's heartbeat interval would otherwise outlive every reference to it.
    this.lock?.dispose();
    this.lock = null;
    this.ownerId = ownerId;
    this.lostSessionId = undefined;
  }

  /**
   * Register the one handler that learns about a lost lock.
   *
   * A lock can be taken over after a stale window (a long event-loop block, a paused debugger), and
   * the heartbeat is the only place that can notice. Reporting it is not optional bookkeeping:
   * without it this process keeps appending to a log another process now owns, which is the exact
   * merged-transcript failure the lock exists to prevent.
   */
  setLostHandler(handler: ((sessionId: string) => void) | undefined): void {
    this.lostHandler = handler;
  }

  /** Whether this runtime lost the cross-process lock for `sessionId` (so writes must stop). */
  hasLost(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.lostSessionId === sessionId;
  }

  /** Take the lock, or no-op when the host cannot support one. Throws `SessionLockedError`. */
  async lockSession(sessionId: string, env: ResolvedCoreEnv | null | undefined): Promise<void> {
    const lock = this.current(env);
    if (!lock) return;
    let acquired: SessionLockAcquisition;
    try {
      acquired = await lock.acquire(sessionId);
    } catch {
      // The sidecar cannot be written (read-only mount, full disk, an embedded host whose fs cannot
      // persist it). The lock is advisory: degrading to the in-process claim is the same rule the
      // rest of `SessionLock` follows (missing mtime, failed ticket). Blocking session creation here
      // turned a save-time warning into "the app does not start".
      return;
    }
    if (!acquired.ok) throw new SessionLockedError(sessionId, acquired.held);
    // Re-acquiring is how a lost holder legitimately recovers (the other process closed, the TTL
    // expired): stop refusing writes for that id.
    if (this.lostSessionId === sessionId) this.lostSessionId = undefined;
  }

  /**
   * Drive one ownership check (the heartbeat's own step).
   *
   * Public for validation: the timer ticks every 30 s, so the takeover path is otherwise untestable.
   */
  async refreshOwnership(env: ResolvedCoreEnv | null | undefined): Promise<"held" | "lost"> {
    const lock = this.current(env);
    if (!lock) return "held";
    return lock.refreshOwnership();
  }

  /**
   * Try to take the lock back after a heartbeat found it taken over.
   *
   * Without this, "writes are paused" was permanent until the process restarted: the only other
   * acquire paths are `/new`, `/resume` and create, and a user whose session is already open has no
   * reason to run one. Called before refusing a write, so a peer that has exited heals on the next
   * message instead of losing the rest of the conversation.
   */
  async reacquireLost(env: ResolvedCoreEnv | null | undefined): Promise<boolean> {
    const sessionId = this.lostSessionId;
    if (sessionId === undefined) return true;
    const lock = this.current(env);
    if (!lock) return true;
    try {
      const acquired = await lock.acquire(sessionId);
      if (!acquired.ok) return false;
      this.lostSessionId = undefined;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A restore read that throws still holds the target's lock (acquiring handed the departure over).
   * Put it back on the session the agent is actually on — the departure — or drop a target nobody
   * adopted. Best-effort: the TTL expires a stranded target lock.
   */
  async restoreAfterFailedRead(
    env: ResolvedCoreEnv | null | undefined,
    previousId: string | undefined,
    targetId: string
  ): Promise<void> {
    const lock = this.lock;
    if (!lock) return;
    try {
      if (previousId !== undefined && previousId !== targetId) await this.lockSession(previousId, env);
      else await lock.release(targetId);
    } catch {
      // Best-effort: the switch's recovery still re-opens the departure.
    }
  }

  /** Release and forget (close / teardown). Idempotent. */
  async releaseAll(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    if (!lock) return;
    try {
      await lock.releaseAll();
    } finally {
      lock.dispose();
    }
  }

  private current(env: ResolvedCoreEnv | null | undefined): SessionLock | null {
    if (!this.ownerId || !env?.path) return null;
    // The lock derives its sidecar path from the workspace path utilities. A duck-typed host double
    // may expose only `rootPath`; degrade to the in-process claim rather than throw on `basename`.
    if (!env.path.dirname || !env.path.basename || !env.path.join) return null;
    if (!env.fs?.writeFile || !env.fs.readFile || !env.fs.stat || !env.fs.remove || !env.fs.readdir) return null;
    this.lock ??= new SessionLock(env, this.ownerId, (sessionId) => {
      this.lostSessionId = sessionId;
      this.lostHandler?.(sessionId);
    });
    return this.lock;
  }
}
