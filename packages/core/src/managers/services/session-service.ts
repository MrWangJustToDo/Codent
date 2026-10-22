/**
 * SessionService — session persistence.
 * `uiMessages` are written only when callers pass them (app `useChat` layer).
 * When uiMessages are provided, they are dehydrated (base64 → `media://` refs)
 * before writing to disk. Runtime (hydrated) messages are never mutated.
 */

import { getFirstUserInput } from "../../agent/compaction/message-utils.js";
import { dehydrateUIMessages, hydrateUIMessages, type MediaHydrationMiss } from "../../agent/media/media-utils.js";
import { runSideTextQuery } from "../../models/adapter/side-text-query.js";
import { errorMessage } from "../../utils/errors.js";

import type { AgentLog } from "../../agent/agent-log";
import type { SessionStore } from "../../agent/persistence/session-store.js";
import type { SessionData } from "../../agent/persistence/types.js";
import type { PlanModeState } from "../../agent/plan/plan-mode-controller.js";
import type { TodoManager } from "../../agent/todo";
import type { TextAdapterConfig } from "../../models/adapter/adapter-factory.js";
import type { ModelStyle, ReasoningEffort } from "../../models/types.js";
import type { EmitAgentTelemetryFn } from "../telemetry/emit-agent-telemetry.js";
import type { UsageTracker } from "../telemetry/usage-tracker.js";
import type { UIMessage } from "@tanstack/ai";

export interface SessionPersistInput {
  usage: UsageTracker;
  todoManager: TodoManager | null;
  /** Current plan-mode snapshot; null/undefined when off. */
  planMode?: PlanModeState | null;
  /** Auto-approve (skip all tool approvals) flag. */
  autoMode?: boolean;
  /** Reasoning effort level to persist with this session. */
  reasoningEffort?: ReasoningEffort;
  resolveTextAdapter?: () => Promise<TextAdapterConfig | null>;
  emitEvent?: EmitAgentTelemetryFn;
  /**
   * Agent log for the async side queries this service runs on its own (session
   * title generation). Without it those failures are invisible: the title path
   * falls back to a truncated first message, which looks like a normal title.
   */
  log?: AgentLog;
  /**
   * Invoked when the async auto-title resolves, so the agent can broadcast the
   * new display name (the title lands on `SessionData.name` first).
   */
  onTitleResolved?: (name: string) => void;
  uiMessages?: UIMessage[];
  /**
   * Session the caller intended to write. A queued persist may run after a `/resume`/`/new`
   * has adopted a different session; refusing the stale target prevents the old transcript (or
   * mode/todo state) from landing in the new session.
   */
  sessionId?: string;
}

export interface SessionRestoreInput {
  usage: UsageTracker;
  todoManager: TodoManager | null;
  /** Report media refs that could not be hydrated from disk (read-side of media IO failure). */
  onMissingMedia?: (miss: MediaHydrationMiss) => void;
}

export class SessionService {
  private store: SessionStore | null = null;
  private data: SessionData | null = null;
  private config: { modelStyle: string; model: string } | null = null;
  /**
   * Per-session persist serialization. See {@link persistSession}.
   */
  private persistQueue: Promise<void> = Promise.resolve();
  /**
   * Set by {@link close} (session deletion / teardown). Once closed, no new write may reach the
   * store: a queued `pump-complete` save or an async title resolution would otherwise recreate a
   * session file that `deleteSession` just removed.
   */
  private closed = false;
  /** In-flight {@link saveToStore} writes, including the async title write that bypasses the queue. */
  private readonly pendingSaves = new Set<Promise<boolean>>();
  setStore(store: SessionStore, config: { modelStyle: string; model: string }): void {
    this.store = store;
    this.config = config;
  }

  /**
   * Close this session's writer and wait for writes already in flight.
   *
   * The deletion path must call this before removing the log file: a persist queued by the
   * cancelled pump, or an async title resolution, otherwise lands after `SessionStore.delete`
   * and resurrects the deleted session. Closing is intentionally irreversible here — a
   * `SessionService` belongs to one agent, and an agent whose session was deleted is destroyed.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.persistQueue;
    // A title save is a direct `saveToStore` call, not part of `persistQueue`; wait for those
    // too. Loop because a queued save can start another one while we await.
    while (this.pendingSaves.size > 0) {
      await Promise.allSettled([...this.pendingSaves]);
    }
  }

  /** Whether {@link close} has refused further writes. */
  isClosed(): boolean {
    return this.closed;
  }

  /** Update the model used by this session and by new sessions (model switch via `ManagedAgent.setModel`). */
  setModelConfig(modelStyle: ModelStyle, model: string): void {
    if (this.config) {
      this.config.modelStyle = modelStyle;
      this.config.model = model;
    }
    // Mirror onto the active session record: previously only `store.create` wrote
    // the model, so a `/models` switch never reached disk and restoring always
    // fell back to the creation-time (default) model.
    if (this.data) {
      this.data.modelStyle = modelStyle;
      this.data.model = model;
    }
  }

  getStore(): SessionStore | null {
    return this.store;
  }

  setSessionData(data: SessionData): void {
    this.data = data;
  }

  getSessionData(): SessionData | null {
    return this.data;
  }

  private ensureSession(): void {
    if (this.data || !this.store || !this.config) return;
    this.data = this.store.create({
      modelStyle: this.config.modelStyle,
      model: this.config.model,
    });
  }

  /**
   * Ensure in-memory session data exists (allocates the stable `ses_` id without
   * writing to disk; the first `save()` writes the file). Used to fix a fresh
   * session's id before its first persist so file sinks keyed by sessionId have
   * a stable directory from the start.
   */
  ensureSessionData(): SessionData | null {
    this.ensureSession();
    return this.data;
  }

  private async generateSessionTitle(
    userMessage: string,
    input: Pick<SessionPersistInput, "usage" | "resolveTextAdapter" | "log">
  ): Promise<string> {
    const { usage, resolveTextAdapter, log } = input;
    // Nothing to title. An empty prompt made the side LLM invent a title for a conversation
    // that does not exist yet; some providers answer with a plausible-looking name and some
    // reject the request outright (400 → the caller's fallback is also empty). The persist
    // path gates on this before calling, and the guard lives here too so no caller can hand
    // the summarizer an empty conversation.
    if (!userMessage.trim()) return "";
    try {
      const textAdapter = (await resolveTextAdapter?.()) ?? null;
      if (!textAdapter) return userMessage.slice(0, 50);
      const { text, usage: queryUsage } = await runSideTextQuery(textAdapter, {
        systemPrompt:
          "Generate a concise title (3-8 words) for a conversation that starts with the following message. Return ONLY the title, no quotes or punctuation.",
        userPrompt: userMessage.slice(0, 500),
        maxOutputTokens: 30,
        log,
      });

      if (queryUsage) {
        usage.addTotal(queryUsage);
      }

      return text.slice(0, 80) || userMessage.slice(0, 50);
    } catch (error) {
      // The port logs its own transport / model failures, but this catch also
      // covers adapter resolution and any non-LLM throw, so the fallback stays
      // observable instead of being a bare swallow. Filed under `side-query` —
      // the category the port itself uses — so one filter shows the health of
      // every internal one-shot call.
      const reason = errorMessage(error);
      log?.warn("side-query", `Session title generation failed: ${reason}`);
      return userMessage.slice(0, 50);
    }
  }

  /**
   * Single save + error-emit path used by both the main persist and the
   * async title save, so a failure is always surfaced (never silently dropped).
   *
   * Returns whether the write landed. A caller that tracks persist state (the
   * session-sync fingerprint) must only mark content persisted on `true`: a
   * failed write that still marks it persisted suppresses every later retry of
   * the same content, so the loss never converges. `false` also covers
   * "no store / no data", where there is nothing to persist.
   */
  private async saveToStore(
    emitEvent: EmitAgentTelemetryFn | undefined,
    data: SessionData,
    target: string
  ): Promise<boolean> {
    const store = this.store;
    if (this.closed || !store) return false;
    if (store.isDeleted?.(data.id) === true) return false;
    // Track the direct write too: `generateSessionTitle` calls this outside `persistQueue`, and
    // `close()` must be able to wait for it before the log is deleted.
    const run = (async () => {
      try {
        await store.save(data);
        return true;
      } catch (err) {
        const errorMsg = errorMessage(err);
        emitEvent?.("session:save-error", { target, error: errorMsg });
        return false;
      }
    })();
    this.pendingSaves.add(run);
    try {
      return await run;
    } finally {
      this.pendingSaves.delete(run);
    }
  }

  /**
   * Persist session MESSAGES and/or state.
   *
   * Accepts a thunk so the payload can be resolved when the queued write actually
   * runs. That matters for state-only persists: a mode switch dispatches one while
   * an earlier one is still queued (`dehydrateUIMessages` is async), and a payload
   * captured at dispatch time would write the *pre-switch* state over the newer
   * one. Resolving late means the last write always carries the newest state.
   *
   * Callers with a message snapshot that must not move (`saveSessionUIMessages`)
   * still pass the exact messages; only the ambient state is re-read.
   *
   * @returns whether everything the caller asked for reached disk. Callers that
   * mark the content persisted (see {@link saveToStore}) must gate on this.
   */
  async persistSession(input: SessionPersistInput | (() => SessionPersistInput)): Promise<boolean> {
    if (this.closed) return false;
    const run = this.persistQueue.then(() => this.persistSessionInner(typeof input === "function" ? input() : input));
    // Keep the stored chain non-rejecting so one failure cannot stall later saves.
    this.persistQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Wait for queued session writes to settle before switching the active transcript.
   *
   * A resume/branch replaces `this.data`; letting a queued write run afterward would make
   * a pre-switch payload race the new session even though `persistSessionInner` now
   * refuses a stale target. The explicit drain makes the switch ordering deterministic.
   */
  async awaitPersistIdle(): Promise<void> {
    while (true) {
      const pending = this.persistQueue;
      await pending;
      if (pending === this.persistQueue) return;
    }
  }

  private async persistSessionInner(input: SessionPersistInput): Promise<boolean> {
    if (this.closed) return false;
    const {
      usage,
      todoManager,
      planMode,
      autoMode,
      reasoningEffort,
      resolveTextAdapter,
      onTitleResolved,
      emitEvent,
      uiMessages,
      log,
    } = input;
    if (!this.store) return false;
    if (!this.data) {
      this.ensureSession();
      return this.persistSessionInner(input);
    }
    // Capture the target object for the whole write. `this.data` may be replaced by a
    // resume/new while dehydrate/save is awaiting, and a stale write must never be
    // retargeted onto the newly adopted session.
    const data = this.data;
    if (this.store.isDeleted?.(data.id) === true) return false;
    if (input.sessionId !== undefined && data.id !== input.sessionId) {
      // A write captured before a session switch must not be retargeted onto the new session.
      return false;
    }
    data.usage = { ...usage.getTotal() };
    data.cost = usage.getTotalCostUsd();
    data.contextTokens = usage.getContextFillTokens();

    if (todoManager) {
      data.todos = todoManager.getItems();
      data.todoTitle = todoManager.getTitle();
      data.todoPlanBound = todoManager.isPlanBound();
    }

    if (planMode !== undefined) {
      data.planMode = !planMode || planMode.phase === "off" ? null : { ...planMode, steps: [...planMode.steps] };
    }

    if (autoMode !== undefined) {
      data.autoMode = autoMode;
    }

    // `in` check: explicit undefined (e.g. `/models <model> off`) also clears the field.
    if ("reasoningEffort" in input) {
      data.reasoningEffort = reasoningEffort;
    }

    // `messagesPersisted` stays false when dehydrate fails: the messages (the
    // part the caller asked for) never reached `data.uiMessages`, so the caller
    // must not mark them persisted — otherwise the retry is suppressed too.
    let messagesPersisted = true;
    if (uiMessages !== undefined) {
      // An empty list is never written: an empty persist must not erase a session whose
      // messages simply were not passed. Starting a new conversation creates a new session
      // instead of blanking the old one.
      if (uiMessages.length === 0) {
        messagesPersisted = false;
      } else {
        // Dehydrate extracts base64 assets to the media store (disk writes). This
        // runs BEFORE saveToStore, so a media IO failure would reject persistSession
        // and — for fire-and-forget hosts (`void …persist…`) — escape as an
        // unhandled rejection. Keep persist best-effort: surface it like any save
        // failure and fall through with the previous messages, still saving the rest
        // of the session state.
        const store = this.store;
        if (!store) {
          messagesPersisted = false;
        } else {
          try {
            const dehydrated = await dehydrateUIMessages(uiMessages, { env: store.getEnv() });
            // A resume/new can replace `this.data` during the media write. Do not mutate or
            // save the newly adopted session with the old session's transcript.
            if (this.data !== data) return false;
            data.uiMessages = dehydrated;
          } catch (err) {
            messagesPersisted = false;
            emitEvent?.("session:save-error", {
              target: "session+uiMessages",
              error: errorMessage(err),
            });
          }
        }
      }
    }

    // Regenerate the title for blank names too, not just "New Session": legacy
    // sessions whose name was overwritten to "" before the empty-title guard
    // would otherwise never retitle again (name !== "New Session").
    if (!data.name || data.name === "New Session") {
      const firstUserText = getFirstUserInput(uiMessages || []).trim();
      // A brand-new session is persisted *before* its first turn by state-only writes:
      // state-only persists carry no `uiMessages`, and a new-session mode reset queues one,
      // whose lazily-resolved payload lands after the new session is adopted. There is
      // nothing to title at that point — an empty prompt produced a title with no conversation
      // behind it and a wasted side call (some providers reject the empty input outright, which
      // surfaced only as a `side-query` warn). Title only once a persist actually carries a
      // first user message.
      if (firstUserText) {
        // Capture the session identity: the title LLM call is async, and a /new or
        // /resume during it swaps `this.data`. Without this guard the old session's
        // title would be written into (and persisted to) the new session.
        const target = data;
        this.generateSessionTitle(firstUserText, { usage, resolveTextAdapter, log }).then((title) => {
          if (this.data !== target) return;
          const trimmed = title.trim();
          if (!trimmed) {
            // A whitespace-only provider reply. Keep "New Session" — and repair legacy
            // blank names so the UI never shows an empty label — until a later persist
            // regenerates the title.
            if (!target.name || !target.name.trim()) {
              target.name = "New Session";
              void this.saveToStore(emitEvent, target, "session-title");
            }
            return;
          }
          target.name = trimmed;
          // Broadcast the new display name so live UI / snapshots see the
          // auto-generated title (the write above only touches SessionData).
          onTitleResolved?.(trimmed);
          // Reuse the unified save path so a title-write failure also emits
          // `session:save-error` (target "session-title").
          void this.saveToStore(emitEvent, target, "session-title");
        });
      }
    }

    // A session reaches disk only once it has something to write. `/new` starts a
    // brand-new session, and a mode/effort/model toggle issued before the first message
    // persists *state* against it — but an empty session that nothing can be resumed from
    // is not worth a file. Create it on the first save that carries a message; the state
    // computed above rides along with that write. This is also what keeps `/resume` free of
    // empty "New Session" rows. A skip is "nothing to write yet", not a failure — the caller
    // asked for state that is derived and will be written by the next content save.
    const store = this.store;
    if (store && data.uiMessages.length === 0 && !(await store.exists(data.id))) {
      return messagesPersisted && this.data === data;
    }
    if (this.data !== data) return false;

    const saveTarget = uiMessages !== undefined ? "session+uiMessages" : "session";
    // Await so callers that `await persistSession` observe durability; emit on
    // failure (do not rethrow — persist remains best-effort for fire-and-forget hosts).
    const saved = await this.saveToStore(emitEvent, data, saveTarget);
    return messagesPersisted && saved;
  }

  /**
   * Restore usage, todos, and uiMessages from a persisted session.
   * Hydrates for the return value, then re-dehydrates into `this.data` and
   * writes the canonical form back to disk (repairs stringified multimodal, etc.).
   */
  async restoreFromStore(sessionId: string, input: SessionRestoreInput): Promise<SessionData> {
    if (!this.store) throw new Error("Session store not available");

    const session = await this.store.load(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const { usage, todoManager } = input;
    usage.reset();

    // Hydrate reads media files; canonicalize re-extracts media:// refs (writes).
    // Neither must abort a resume on media IO failure, so degrade to the stored
    // messages instead of throwing out of restore. Missing media is reported
    // through `onMissingMedia` so the silent data loss becomes observable.
    let hydrated: UIMessage[];
    try {
      hydrated = await hydrateUIMessages(session.uiMessages, {
        onMissing: input.onMissingMedia,
        env: this.store.getEnv(),
      });
      try {
        const dehydrated = await dehydrateUIMessages(hydrated, { env: this.store.getEnv() });
        session.uiMessages = dehydrated;
      } catch {
        // Canonicalize is best-effort; keep the stored form when media writes fail.
      }
    } catch {
      hydrated = session.uiMessages;
    }
    if (session.usage) {
      usage.addTotal(session.usage);
    }
    if (session.contextTokens) {
      // Set (do not accumulate) the window: the restored fill is already part of the
      // restored lifetime totals, so `updateWindowUsage` would double-count it.
      usage.setWindowUsage({
        inputTokens: session.contextTokens,
        outputTokens: 0,
        totalTokens: session.contextTokens,
      });
    }
    if (session.cost != null) {
      usage.setTotalCostUsd(session.cost);
    }

    if (todoManager) {
      if (session.todos?.length) {
        todoManager.restoreTodos(session.todos, {
          title: session.todoTitle,
          planBound: session.todoPlanBound,
        });
      } else {
        todoManager.reset();
      }
    }

    // Repair legacy sessions whose name was overwritten to a blank string before
    // the empty-title guard existed. Reset to the default so the UI never shows
    // an empty label and the next persist retitles via auto-title.
    if (!session.name?.trim()) {
      session.name = "New Session";
    }

    // Adopt only after the canonical rewrite landed. A save failure must leave the agent on the
    // session it was actually running, otherwise ownership/log/tracker and live state disagree.
    await this.store.save(session);
    this.setSessionData(session);

    return {
      ...session,
      uiMessages: hydrated,
    };
  }
}
