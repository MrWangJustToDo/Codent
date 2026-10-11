/**
 * SessionStore - Append-only incremental session persistence.
 *
 * Each session is one JSONL log `.agents/sessions/{id}.session.jsonl` (source of
 * truth). Every line is one message plus the full non-message state snapshot at
 * that point. `save()` appends only what changed: one line per new/changed
 * UIMessage, or a re-emit of the last message when only state changed. `load()`
 * folds the log by message id (later line wins).
 *
 * Binary assets (images, audio, PDFs) are extracted from inline base64 and
 * stored as content-addressed files under `.agents/media/<hash>.<ext>`. The
 * session log stores only `media://<hash>` references in `source.value` and
 * a `MediaRef` in `metadata.mediaRef`. Hydrate/Dehydrate happens in
 * SessionService via `media-utils.ts`.
 */

import { getEnv } from "../../env";
import { generateId } from "../../utils/generate-id.js";
import { isToolCallPart } from "../stream/message-parts.js";

import {
  appendLogLines,
  foldLog,
  hasUserMessage,
  readApprovalUpdatedAt,
  readLastState,
  readLog,
  readMessageUpdatedAt,
  writeLog,
} from "./session-journal.js";
import { fingerprintUIMessage } from "./session-sync-tracker.js";
import {
  SESSION_DIR,
  SESSION_LOG_MESSAGE,
  SESSION_LOG_SUFFIX,
  SESSION_VERSION,
  isSupportedSessionVersion,
} from "./types.js";

import type {
  PersistedToolCallPart,
  PersistedUIMessage,
  SessionData,
  SessionLogLine,
  SessionMeta,
  SessionStateFields,
} from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/** Default empty token usage */
const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/**
 * How long a startup-reused empty session stays reserved before another
 * process may select it again. Cross-process live ownership is not shared, so
 * the reservation is the only cross-process signal; the window must cover
 * "launch two terminals back-to-back" while still releasing itself after a
 * crash (no stale locks to clean up).
 */
const EMPTY_SESSION_RESERVE_MS = 5 * 60_000;

/** What we remember about the last durable write, to compute the next delta. */
interface LastSaved {
  /** Message ids in order at the last write (prefix check for append-only). */
  ids: string[];
  /** id → fingerprint at the last write. */
  fingerprints: Map<string, string>;
  /** Content signature at the last write (state sans `updatedAt` + fingerprints). */
  signature: string;
  /**
   * id → the `message.updatedAt` value written to disk for that message. Reusing
   * this (instead of re-stamping) is what keeps a re-emitted line byte-identical
   * and an approval's decision time stable across a state-only re-emit.
   */
  stamps: Map<string, number>;
}

/** The timestamps frozen for one message in the upcoming write. */
interface TimestampSnapshot {
  updatedAt?: number;
  /** approvalId → decision time, for decided tool calls in this message. */
  approvals: Record<string, number>;
}

// ============================================================================
// SessionStore Class
// ============================================================================

export class SessionStore {
  /** Last durable write per session — drives delta computation and no-op dedupe. */
  private lastSaved: Map<string, LastSaved> = new Map();

  /** Known approval decision times per session (approvalId → epoch ms). */
  private statusStamps: Map<string, Record<string, number>> = new Map();

  /**
   * Per-session write lock to prevent concurrent saves from racing.
   */
  private saveLocks: Map<string, Promise<void>> = new Map();

  private get fs() {
    return getEnv().fs;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Create a new empty session and return its SessionData.
   * Does NOT write to disk — the first call to save() writes the log.
   */
  create(options: { modelStyle: string; model: string; name?: string }): SessionData {
    const id = generateId("ses");
    const now = Date.now();

    return {
      id,
      name: options.name || "New Session",
      version: SESSION_VERSION,
      modelStyle: options.modelStyle === "anthropic" ? "anthropic" : "openai",
      model: options.model,
      uiMessages: [],
      usage: { ...EMPTY_USAGE },
      todos: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Build a new session by copying `source`'s messages (optionally truncated) and
   * model settings. Per-session work state is reset (usage/todos/plan/auto) and the
   * source is recorded as `forkedFrom`. The caller persists the result.
   *
   * `upToIndex` copies messages strictly before that index (`/fork`); omit it to
   * copy all messages (`/clone`). `messages` overrides `source.uiMessages` so a
   * caller can branch from the live channel (including unsaved turns).
   */
  branchFrom(
    source: SessionData,
    options: { upToIndex?: number; name?: string; messages?: PersistedUIMessage[] } = {}
  ): SessionData {
    const all = (options.messages ?? source.uiMessages) as PersistedUIMessage[];
    const messages = options.upToIndex === undefined ? all.slice() : all.slice(0, options.upToIndex);
    const now = Date.now();
    const name = options.name?.trim();
    return {
      id: generateId("ses"),
      name: name && name.length > 0 ? name : source.name,
      version: SESSION_VERSION,
      modelStyle: source.modelStyle,
      model: source.model,
      uiMessages: messages as SessionData["uiMessages"],
      usage: { ...EMPTY_USAGE },
      todos: [],
      forkedFrom: source.id,
      ...(source.reasoningEffort ? { reasoningEffort: source.reasoningEffort } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Save a session: append only the messages whose content changed since the
   * last write, plus a full state snapshot on each appended line. State-only
   * changes re-emit the last message line. Skips all IO when nothing changed.
   * Serializes concurrent saves per session.
   */
  async save(session: SessionData): Promise<void> {
    const prev = this.saveLocks.get(session.id) ?? Promise.resolve();
    // Run doSave after the previous lock; return the rejecting promise to callers
    // so failures surface (session:save-error). Keep the stored lock chain
    // non-rejecting so one failure does not permanently stall later saves.
    const run = prev.then(() => this.doSave(session));
    this.saveLocks.set(
      session.id,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  /**
   * Load a full session by ID by folding its log. Returns null when the log is
   * missing or holds no usable lines.
   */
  async load(id: string): Promise<SessionData | null> {
    const logPath = this.getLogPath(id);
    if (!(await this.fs.exists(logPath))) return null;

    const lines = await readLog(this.fs, logPath);
    if (lines.length === 0) return null;

    const { state, uiMessages, approvalAt } = foldLog(lines);
    if (!state) return null;
    // A log written by a newer schema may fold into a wrong session, so treat it as
    // unreadable (same as a legacy/corrupt file) rather than guessing.
    if (!isSupportedSessionVersion(state.version)) return null;

    const data: SessionData = { ...state, uiMessages };
    if (Object.keys(approvalAt).length > 0) data.approvalTimes = approvalAt;
    // The log's file name is the session identity (what list/delete/rename address),
    // so take it over a stale `state.id` — otherwise a later save would write a
    // second file under the embedded id and leave this one behind.
    if (data.id !== id) data.id = id;
    // Prime the delta baseline so the first save after a resume appends only
    // what actually changed instead of re-appending the whole history.
    this.primeCache(data);
    return data;
  }

  /**
   * List all sessions (metadata only, sorted by updatedAt descending). Reads only
   * the newest line's state of each log, so message bodies are never folded. Logs
   * written by a newer schema version are skipped (not listed as resumable).
   */
  async list(): Promise<SessionMeta[]> {
    const dirExists = await this.fs.exists(SESSION_DIR);
    if (!dirExists) return [];

    const entries = await this.fs.readdir(SESSION_DIR);
    const sessions: SessionMeta[] = [];

    for (const entry of entries) {
      if (entry.type !== "file" || !entry.name.endsWith(SESSION_LOG_SUFFIX)) continue;

      // The file name IS the session identity: `load`/`delete`/`rename` all address
      // the log by it, so listing must not substitute a possibly-stale `state.id`
      // (a copied/renamed log would then be un-loadable).
      const id = entry.name.slice(0, -SESSION_LOG_SUFFIX.length);
      if (!id) continue;

      try {
        const state = await readLastState(this.fs, `${SESSION_DIR}/${entry.name}`);
        if (!state || !isSupportedSessionVersion(state.version)) continue;

        sessions.push({
          id,
          name: state.name,
          version: state.version,
          modelStyle: state.modelStyle,
          model: state.model,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
        });
      } catch {
        // Skip corrupted files
      }
    }

    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Get the most recently updated session.
   */
  async getLatest(): Promise<SessionData | null> {
    const metas = await this.list();
    if (metas.length === 0) return null;
    return this.load(metas[0].id);
  }

  /**
   * Find the most recently updated session that has never been used (contains
   * no user messages) and is not currently reserved by a concurrent live agent.
   * Lets hosts reuse the leftover empty session from a previous startup instead
   * of creating a fresh one, without racing another process onto the same id.
   */
  async getLatestEmpty(): Promise<SessionData | null> {
    const metas = await this.list();
    const now = Date.now();
    for (const meta of metas) {
      // Cheap check first: scan the log from the top for a user message instead of
      // folding every message of every candidate.
      if ((await hasUserMessage(this.fs, this.getLogPath(meta.id))) !== false) continue;
      const state = await readLastState(this.fs, this.getLogPath(meta.id));
      if (!state) continue;
      if (state.reservedAt && now - state.reservedAt < EMPTY_SESSION_RESERVE_MS) continue;
      // Only the chosen candidate is folded in full.
      const data = await this.load(meta.id);
      if (!data || data.uiMessages.some((m) => m.role === "user")) continue;
      return data;
    }
    return null;
  }

  /**
   * Mark a still-empty session as taken by this live agent so a second
   * process/agent does not select the same id during startup reuse. The mark
   * persists to disk and expires after {@link EMPTY_SESSION_RESERVE_MS},
   * self-healing if the reserving process crashes. No-op when the session is
   * no longer empty (then it is simply never selected again).
   */
  async reserveSession(id: string): Promise<void> {
    const session = await this.load(id);
    if (!session || session.uiMessages.some((m) => m.role === "user")) return;
    session.reservedAt = Date.now();
    await this.save(session);
  }

  /**
   * Clear a still-empty session's startup reservation so a later launch can
   * reuse it again. Called on graceful agent teardown; a crash instead leaves
   * the reservation to expire on its own ({@link EMPTY_SESSION_RESERVE_MS}).
   * No-op when the session is no longer empty (it is never selected again) or
   * was never reserved.
   */
  async releaseReservation(id: string): Promise<void> {
    const session = await this.load(id);
    if (!session || session.uiMessages.some((m) => m.role === "user")) return;
    if (session.reservedAt === undefined) return;
    delete session.reservedAt;
    await this.save(session);
  }

  /**
   * Find sessions by name (partial match, case-insensitive).
   */
  async findByName(query: string): Promise<SessionMeta[]> {
    const all = await this.list();
    const lower = query.toLowerCase();
    return all.filter((s) => s.name.toLowerCase().includes(lower));
  }

  /**
   * Delete a session by ID (its log; there is no separate snapshot file).
   */
  async delete(id: string): Promise<boolean> {
    const logPath = this.getLogPath(id);
    if (!(await this.fs.exists(logPath))) return false;
    await this.fs.remove(logPath);
    this.lastSaved.delete(id);
    this.statusStamps.delete(id);
    return true;
  }

  /**
   * Update session name.
   */
  async rename(id: string, name: string): Promise<void> {
    const session = await this.load(id);
    if (!session) return;
    session.name = name;
    await this.save(session);
  }

  /**
   * Clear in-memory delta/approval bookkeeping for a session.
   */
  clearCache(id: string): void {
    this.lastSaved.delete(id);
    this.statusStamps.delete(id);
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  private async doSave(session: SessionData): Promise<void> {
    const prev = this.lastSaved.get(session.id);

    // Snapshot the message list (and everything derived from it) before the first
    // await: a concurrent persist may swap `session.uiMessages` while we wait on
    // IO, which would desync the fingerprints from the lines we append.
    const messages = session.uiMessages as PersistedUIMessage[];
    const fingerprints = new Map(messages.map((m) => [m.id, fingerprintUIMessage(m)]));
    // Timestamps are resolved BEFORE the no-op check and are deliberately not part
    // of it (they are derived from what changed): a message keeps the stamp it was
    // first written with, so an unchanged save still writes nothing and a re-emit
    // reproduces the previous line byte for byte.
    const stamps = resolveMessageStamps(messages, prev, fingerprints);

    // Track newly-decided approvals so their times survive a later rewrite. Taken
    // before the message stamps so a message that changed for an unrelated reason
    // cannot move its approval's decision time; a decision made through the
    // channel carries its own time on the part.
    const knownTimes = this.statusStamps.get(session.id) ?? {};
    if (collectApprovalStamps(messages, knownTimes)) {
      this.statusStamps.set(session.id, knownTimes);
    }
    const snapshot = snapshotTimestamps(messages, stamps, knownTimes);

    const { uiMessages: _uiMessages, approvalTimes: _approvalTimes, ...stateFields } = session;
    const signature = contentSignature(stateFields, messages, fingerprints);

    // Fingerprint BEFORE stamping `updatedAt`, so an unchanged save is a true
    // no-op (no IO, no timestamp bump).
    if (prev && prev.signature === signature) return;

    await this.ensureDir();
    session.updatedAt = Date.now();
    stateFields.updatedAt = session.updatedAt;

    const ids = messages.map((m) => m.id);
    // `prev === undefined` means we have no delta baseline for this id: either the
    // first save of a brand-new session (nothing durable yet — a rewrite is
    // equivalent) or a session/store that was never primed by `load()`. In the
    // latter case the file may already hold content this session does not describe
    // (e.g. `load()` refused a newer-version log, or the store was recreated), so
    // treat it as structural and rewrite to converge on the truth rather than
    // blindly appending into an unknown log.
    const structuralChange = prev === undefined || !isAppendOnlyCompatible(prev.ids, ids);

    if (structuralChange || messages.length === 0) {
      // Non-empty → empty, partial truncation, or the initial empty save:
      // rewrite the file (one line per message; a single `message: null` when empty).
      await this.rewriteLog(messages, stateFields, snapshot);
    } else {
      const lines: SessionLogLine[] = [];
      for (const message of messages) {
        if (prev?.fingerprints.get(message.id) === fingerprints.get(message.id)) continue;
        lines.push(buildLine(message, stateFields, snapshot));
      }
      // State-only change: re-emit the last message line with the new state.
      if (lines.length === 0) {
        const last = messages[messages.length - 1];
        if (last) lines.push(buildLine(last, stateFields, snapshot));
      }
      if (lines.length > 0) {
        const appended = await appendLogLines(this.fs, this.getLogPath(session.id), lines);
        if (!appended) {
          // Env fs has no `appendFile` (optional primitive). Degrade to a full
          // rewrite so this save is not silently lost — otherwise the delta
          // baseline below would dedupe every later save into nothing.
          await this.rewriteLog(messages, stateFields, snapshot);
        }
      }
    }

    this.lastSaved.set(session.id, { ids, fingerprints, signature, stamps });
  }

  /** Rewrite the log to its compacted form: one line per message (or a single null line). */
  private async rewriteLog(
    messages: PersistedUIMessage[],
    stateFields: SessionStateFields,
    snapshot: Map<string, TimestampSnapshot>
  ): Promise<void> {
    const lines: SessionLogLine[] =
      messages.length === 0
        ? [buildLine(null, stateFields, snapshot)]
        : messages.map((message) => buildLine(message, stateFields, snapshot));
    await writeLog(this.fs, this.getLogPath(stateFields.id), lines);
  }

  /** Seed the delta baseline from a loaded session (resume path). */
  private primeCache(session: SessionData): void {
    const messages = session.uiMessages as PersistedUIMessage[];
    const fingerprints = new Map(messages.map((m) => [m.id, fingerprintUIMessage(m)]));
    // Only messages that already carry a stamp are seeded: a v6 line has none, and
    // the next write must be free to mint one that the *live* message can keep.
    const stamps = new Map<string, number>();
    for (const message of messages) {
      const stamp = readMessageUpdatedAt(message);
      if (stamp !== undefined) stamps.set(message.id, stamp);
    }
    const { uiMessages: _uiMessages, approvalTimes, ...stateFields } = session;
    this.lastSaved.set(session.id, {
      ids: messages.map((m) => m.id),
      fingerprints,
      signature: contentSignature(stateFields, messages, fingerprints),
      stamps,
    });
    if (approvalTimes) {
      this.statusStamps.set(session.id, { ...approvalTimes });
    }
  }

  private getLogPath(id: string): string {
    return `${SESSION_DIR}/${id}${SESSION_LOG_SUFFIX}`;
  }

  private async ensureDir(): Promise<void> {
    if (!(await this.fs.exists(SESSION_DIR))) {
      await this.fs.mkdir(SESSION_DIR);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Content signature used for no-op detection: state (timestamp-normalized) + messages. */
function contentSignature(
  stateFields: SessionStateFields,
  messages: PersistedUIMessage[],
  fingerprints: Map<string, string>
): string {
  const state = JSON.stringify({ ...stateFields, updatedAt: 0 });
  return `${state}\u0000${messages.map((m) => `${m.id}:${fingerprints.get(m.id)}`).join("\u0001")}`;
}

/** Whether `ids` preserves `prevIds` as an in-order prefix (pure append). */
function isAppendOnlyCompatible(prevIds: string[], ids: string[]): boolean {
  if (ids.length < prevIds.length) return false;
  for (let i = 0; i < prevIds.length; i++) {
    if (ids[i] !== prevIds[i]) return false;
  }
  return true;
}

/**
 * Resolve the `message.updatedAt` each message will be written with.
 *
 * A message whose content changed is stamped now; an unchanged one keeps the
 * stamp it already carries (from disk or from the last write) so re-emitting its
 * line stays byte-identical. A message the log has never carried is stamped now —
 * the store, not the caller, owns this timestamp.
 */
function resolveMessageStamps(
  messages: PersistedUIMessage[],
  prev: LastSaved | undefined,
  fingerprints: Map<string, string>
): Map<string, number> {
  const now = Date.now();
  const stamps = new Map<string, number>();
  for (const message of messages) {
    const changed = prev === undefined || prev.fingerprints.get(message.id) !== fingerprints.get(message.id);
    const known = readMessageUpdatedAt(message) ?? prev?.stamps.get(message.id);
    stamps.set(message.id, changed || known === undefined ? now : known);
  }
  return stamps;
}

/**
 * Record decision times for approvals that are newly decided in `messages`.
 * Returns true when the map gained a new entry.
 *
 * A decision made through the channel already carries its own time on the part;
 * anything else (a decision replayed from a legacy log, or a non-channel path)
 * falls back to this save's time.
 */
function collectApprovalStamps(messages: PersistedUIMessage[], knownTimes: Record<string, number>): boolean {
  let changed = false;
  const now = Date.now();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isToolCallPart(part)) continue;
      const approval = part.approval;
      if (!approval?.id || approval.approved === undefined) continue;
      if (knownTimes[approval.id] !== undefined) continue;
      knownTimes[approval.id] = readApprovalUpdatedAt(part as unknown as PersistedToolCallPart) ?? now;
      changed = true;
    }
  }
  return changed;
}

/** Freeze the timestamps each message will be written with, keyed by message id. */
function snapshotTimestamps(
  messages: PersistedUIMessage[],
  stamps: Map<string, number>,
  knownTimes: Record<string, number>
): Map<string, TimestampSnapshot> {
  const out = new Map<string, TimestampSnapshot>();
  for (const message of messages) {
    const approvals: Record<string, number> = {};
    if (message.role === "assistant") {
      for (const part of message.parts) {
        if (!isToolCallPart(part)) continue;
        const approval = part.approval;
        if (!approval?.id || approval.approved === undefined) continue;
        const at = readApprovalUpdatedAt(part as unknown as PersistedToolCallPart) ?? knownTimes[approval.id];
        if (at !== undefined) approvals[approval.id] = at;
      }
    }
    const updatedAt = stamps.get(message.id);
    out.set(message.id, updatedAt === undefined ? { approvals } : { updatedAt, approvals });
  }
  return out;
}

/**
 * Build one log line for `message` (or `null` for the initial empty-session line).
 *
 * Timestamps are applied here, at write time only: the live channel messages are
 * never mutated (a mid-run UI patch would otherwise have to reason about fields
 * it does not own).
 */
function buildLine(
  message: PersistedUIMessage | null,
  state: SessionStateFields,
  snapshot: Map<string, TimestampSnapshot>
): SessionLogLine {
  return {
    t: SESSION_LOG_MESSAGE,
    message: message ? applyTimestamps(message, snapshot.get(message.id)) : null,
    state,
  };
}

/** Return a copy of `message` carrying its write-time and approval decision stamps. */
function applyTimestamps(message: PersistedUIMessage, stamp: TimestampSnapshot | undefined): PersistedUIMessage {
  const next: PersistedUIMessage = { ...message };
  if (stamp?.updatedAt !== undefined) next.updatedAt = stamp.updatedAt;

  const approvalIds = Object.keys(stamp?.approvals ?? {});
  if (approvalIds.length === 0) return next;

  const parts = message.parts.map((part) => {
    if (!isToolCallPart(part)) return part;
    const approval = part.approval;
    const at = approval?.id ? stamp?.approvals[approval.id] : undefined;
    if (!approval || at === undefined) return part;
    return { ...part, approval: { ...approval, updatedAt: at } } as typeof part;
  });
  return { ...next, parts };
}
