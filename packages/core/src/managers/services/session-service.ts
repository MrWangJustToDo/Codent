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
   * Report a title attempt's outcome (`session:title`).
   *
   * Injected as a fact emitters rather than an `AgentLog`: a failed title used to be written as a
   * `side-query` warning, so "no title" and "the model call broke" were one row and neither said the
   * title was missing.
   */
  emitSessionTitle?: (payload: { ok: boolean; name?: string; error?: string }) => void;
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
  /** Report media refs that could not be hydrated from disk (read-side of media IO failure). */
  onMissingMedia?: (miss: MediaHydrationMiss) => void;
}

/**
 * A session read from disk, but not yet adopted.
 *
 * The read and the adoption are two steps on purpose: a session switch is `unload → load`, and
 * everything that can fail during a load (metadata refresh, plan-file read, a throwing host hook)
 * happens BETWEEN them. Until {@link SessionService.adoptRestoredSession} runs, `getSessionData()`
 * still points at the session the agent was actually running — so a failed load leaves a coherent
 * agent instead of half of each session.
 */
export interface RestoredSessionRead {
  /** Canonical form (media refs dehydrated) — what `setSessionData` holds after adoption. */
  session: SessionData;
  /** Hydrated messages for the UI channel, approvals and the sync tracker. */
  uiMessages: UIMessage[];
}

export interface SessionAdoptInput {
  usage: UsageTracker;
  todoManager: TodoManager | null;
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
   * Newest UI snapshot admitted behind the in-flight write (coalesced path).
   *
   * One model call can inject several synthetic messages (ctx sections, a todo nag, a repeat
   * nudge, background work), and each used to enqueue its own full-snapshot write. Only the
   * newest one is written now: the channel is append-only within a session, so the newest
   * snapshot is a superset of the ones it replaces.
   */
  private pendingUiPersist: (() => SessionPersistInput) | null = null;
  /** Drain promise for the coalesced UI path; every caller of the burst joins it. */
  private uiPersistDrain: Promise<boolean> | null = null;
  /**
   * Set by {@link close} (session deletion / teardown). Once closed, no new write may reach the
   * store: a queued `pump-complete` save or an async title resolution would otherwise recreate a
   * session file that `deleteSession` just removed.
   */
  private closed = false;
  /**
   * Stand-in session used while a target is being restored (see {@link setSessionDataPlaceholder}).
   * Present ⇒ writes are refused: the transcript it stands for is not loaded yet.
   */
  private restorePlaceholder: SessionData | null = null;
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
    // Snapshot the admitted tail before flipping the gate. `persistSession` refuses writes
    // submitted after this point, but writes already admitted must still run to completion.
    const admitted = this.persistQueue;
    this.closed = true;
    await admitted;
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
    // Adopting any other session ends a restore placeholder's life (see
    // {@link setSessionDataPlaceholder}).
    if (this.restorePlaceholder && this.restorePlaceholder !== data) this.restorePlaceholder = null;
  }

  /**
   * Adopt a stand-in for a session that is about to be restored.
   *
   * Bootstrap needs the id before the transcript is loaded: the log sink binds to
   * `.agents/logs/<id>/` while extensions are still being activated, and the session is read once the
   * runtime exists. The stand-in carries only the id and the creation-time model — it is NOT a
   * persistable target, and every write dispatched while it is active is refused.
   *
   * That refusal is the structural guarantee behind the restore ordering: the state carried over
   * before adoption (`/models`-style model, reasoning effort, plan phase, approvals) must reach the
   * *target*, and the target still has to be read. Writing at that moment used to be harmless only
   * because the write path also happened to compare session ids and object identity, which holds
   * exactly as long as nothing between the read and the adoption awaits. Any `await` added there
   * turned the stand-in into "the leaving session with an empty transcript".
   */
  setSessionDataPlaceholder(data: SessionData): void {
    this.data = data;
    this.restorePlaceholder = data;
  }

  /** Give up the stand-in without adopting anything (a failed restore). */
  clearRestorePlaceholder(): void {
    this.restorePlaceholder = null;
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
    input: Pick<SessionPersistInput, "usage" | "resolveTextAdapter" | "emitSessionTitle" | "emitEvent">
  ): Promise<string> {
    const { usage, resolveTextAdapter, emitSessionTitle, emitEvent } = input;
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
        purpose: "title",
        // The port's own facts reach the timeline like the manual `/title` path: without this, a
        // failed auto-title kept only `session:title{ok:false}` and lost mode/duration/raw/fallback
        // (the structured-mode retry was invisible).
        onEvent: (event) => {
          const { type, ...payload } = event;
          emitEvent?.(type, payload as never);
        },
      });

      if (queryUsage) {
        usage.addTotal(queryUsage);
      }

      return text.slice(0, 80) || userMessage.slice(0, 50);
    } catch (error) {
      // The port reports its own transport / model failures (`side-query:error`); this catch also
      // covers adapter resolution and any non-LLM throw. A failed title is its own fact, not a
      // side-query failure — the two answer different questions ("no title" vs "the model call
      // broke"), and `session:title` is what a reader greps for.
      emitSessionTitle?.({ ok: false, error: errorMessage(error) });
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
    target: string,
    options: { admitted?: boolean } = {}
  ): Promise<boolean> {
    const store = this.store;
    // A queued persist was admitted before `close()`; it must still land. Direct writers
    // (the async title save) are not admitted and must stop once the writer is closed.
    if ((this.closed && !options.admitted) || !store) return false;
    // Same rule for a restore stand-in: it is never a save target (see setSessionDataPlaceholder).
    if (this.restorePlaceholder && data === this.restorePlaceholder) return false;
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
  async persistSession(
    input: SessionPersistInput | (() => SessionPersistInput),
    options: { coalesceUiMessages?: boolean } = {}
  ): Promise<boolean> {
    if (this.closed) return false;
    // Refuse at DISPATCH, not at execution: the writes that ride a restore are admitted here, and
    // the queue would run them after adoption (when they look harmless). A placeholder means the
    // target's transcript is not loaded yet, so nothing this session writes can be its truth.
    if (this.restorePlaceholder) return false;
    const resolveInput = typeof input === "function" ? input : () => input;

    // State-only writes keep their own turn: they carry no transcript, so folding them into a
    // later UI snapshot would silently drop the write they were asked for.
    if (!options.coalesceUiMessages) {
      const run = this.persistQueue.then(() => this.persistSessionInner(resolveInput()));
      // Keep the stored chain non-rejecting so one failure cannot stall later saves.
      this.persistQueue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }

    // Coalesced path: the newest admitted snapshot wins, and the whole burst awaits one drain.
    this.pendingUiPersist = resolveInput;
    const existing = this.uiPersistDrain;
    if (existing) return existing;
    const drain = this.persistQueue.then(() => this.drainUiPersists());
    this.uiPersistDrain = drain;
    this.persistQueue = drain.then(
      () => undefined,
      () => undefined
    );
    return drain;
  }

  /**
   * Write the newest queued UI snapshot, repeating while another arrived meanwhile.
   *
   * The loop takes the pending snapshot *before* awaiting, so anything admitted during the
   * write becomes the next iteration's payload. A burst of injections therefore costs one
   * write (or two when the later ones land while the first is already dehydrating) instead of
   * one per injection.
   *
   * A failed write does not abort the burst: a newer snapshot may still converge, and when it
   * does the burst reports success (its content is the superset that reached disk). Only a
   * failure of the LAST attempt is rethrown, so the caller still reports `session:save-error`
   * when nothing landed.
   */
  private async drainUiPersists(): Promise<boolean> {
    let ok = false;
    let failure: unknown;
    try {
      while (this.pendingUiPersist) {
        const next = this.pendingUiPersist;
        this.pendingUiPersist = null;
        try {
          ok = await this.persistSessionInner(next());
          failure = undefined;
        } catch (error) {
          ok = false;
          failure = error;
        }
      }
    } finally {
      // Synchronous with the loop exit (no await between the check and here), so a caller
      // arriving afterwards starts a new drain instead of joining a finished one.
      this.uiPersistDrain = null;
    }
    if (failure !== undefined) throw failure;
    return ok;
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
    // Reaching here means `persistSession` admitted this write before `close()`. Drain it:
    // rejecting at execution time would silently drop the final pump-complete on teardown.
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
      emitSessionTitle,
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
    // Exact per-sample sum; see `SessionData.billedInputTokens` for why it is not derivable.
    data.billedInputTokens = usage.getBilledInputTokens();
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
        this.generateSessionTitle(firstUserText, {
          usage,
          resolveTextAdapter,
          ...(emitSessionTitle ? { emitSessionTitle } : {}),
          ...(emitEvent ? { emitEvent } : {}),
        }).then((title) => {
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
          // The generated name is the fact both readers look for. Only the FAILURE branch used to
          // emit, so the most common naming path (the first message) had no row while `/title` had
          // one — the same fact with two visibilities.
          emitSessionTitle?.({ ok: true, name: trimmed });
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
    const saved = await this.saveToStore(emitEvent, data, saveTarget, { admitted: true });
    return messagesPersisted && saved;
  }

  /**
   * Read + hydrate + canonicalize a persisted session, WITHOUT adopting it.
   *
   * The canonical form is written back to disk here (repairs stringified multimodal, blank names),
   * but `this.data` is untouched — see {@link RestoredSessionRead} for why the two are separate.
   */
  async readSessionForRestore(sessionId: string, input: SessionRestoreInput = {}): Promise<RestoredSessionRead> {
    if (!this.store) throw new Error("Session store not available");

    const session = await this.store.load(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

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
    // Repair legacy sessions whose name was overwritten to a blank string before
    // the empty-title guard existed. Reset to the default so the UI never shows
    // an empty label and the next persist retitles via auto-title.
    if (!session.name?.trim()) {
      session.name = "New Session";
    }

    // Persist the canonical rewrite BEFORE anyone adopts it: a save failure must leave the agent on
    // the session it was actually running, otherwise ownership/log/tracker and live state disagree.
    await this.store.save(session);

    return { session, uiMessages: hydrated };
  }

  /**
   * Adopt a session read by {@link readSessionForRestore} — the switch's COMMIT.
   *
   * Call this last and synchronously. It replaces the active session and its lifetime counters;
   * anything that can fail must run before it, or the agent ends up with one session's data and
   * another's transcript (the bug this split removes: the read used to adopt, so a failure in
   * `restoreManagedSession` after it left `getSessionData()` on the target while the channel still
   * held the previous transcript, and the next save rewrote the target's log with it).
   */
  adoptRestoredSession(restored: RestoredSessionRead, input: SessionAdoptInput): void {
    const { session } = restored;
    const { usage, todoManager } = input;

    usage.reset();
    if (session.usage) {
      // Carry the persisted exact count: re-deriving it from the aggregate changed the cache-hit
      // ratio across a resume (see `UsageTracker.restoreTotals`).
      usage.restoreTotals(session.usage, session.billedInputTokens);
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

    this.setSessionData(session);
  }
}
