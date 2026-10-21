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
   * Session the caller intended to write. A queued persist may run after a `/resume`/`/clear`
   * has adopted a different session; refusing the stale target prevents the old transcript (or
   * mode/todo state) from landing in the new session.
   */
  sessionId?: string;
  /**
   * Allow `uiMessages: []` to be written.
   *
   * An empty list is normally refused (an empty persist must not erase a session
   * whose messages simply were not passed), but `/clear` must: it is the one
   * caller whose intent *is* "the transcript is now empty".
   */
  forceEmptyMessages?: boolean;
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
  setStore(store: SessionStore, config: { modelStyle: string; model: string }): void {
    this.store = store;
    this.config = config;
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
  private async saveToStore(emitEvent: EmitAgentTelemetryFn | undefined, target: string): Promise<boolean> {
    if (!this.store || !this.data) return false;
    try {
      await this.store.save(this.data);
      return true;
    } catch (err) {
      const errorMsg = errorMessage(err);
      emitEvent?.("session:save-error", { target, error: errorMsg });
      return false;
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
    const run = this.persistQueue.then(() => this.persistSessionInner(typeof input === "function" ? input() : input));
    // Keep the stored chain non-rejecting so one failure cannot stall later saves.
    this.persistQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async persistSessionInner(input: SessionPersistInput): Promise<boolean> {
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
    if (input.sessionId !== undefined && this.data.id !== input.sessionId) {
      // A write captured before a session switch must not be retargeted onto the new session.
      return false;
    }
    this.data.usage = { ...usage.getTotal() };
    this.data.cost = usage.getTotalCostUsd();
    this.data.contextTokens = usage.getContextFillTokens();

    if (todoManager) {
      this.data.todos = todoManager.getItems();
      this.data.todoTitle = todoManager.getTitle();
      this.data.todoPlanBound = todoManager.isPlanBound();
    }

    if (planMode !== undefined) {
      this.data.planMode = !planMode || planMode.phase === "off" ? null : { ...planMode, steps: [...planMode.steps] };
    }

    if (autoMode !== undefined) {
      this.data.autoMode = autoMode;
    }

    // `in` check: explicit undefined (e.g. `/models <model> off`) also clears the field.
    if ("reasoningEffort" in input) {
      this.data.reasoningEffort = reasoningEffort;
    }

    // `messagesPersisted` stays false when dehydrate fails: the messages (the
    // part the caller asked for) never reached `data.uiMessages`, so the caller
    // must not mark them persisted — otherwise the retry is suppressed too.
    let messagesPersisted = true;
    if (uiMessages !== undefined) {
      // An empty list is only written when the caller says so (`/clear`); every
      // other caller omits `uiMessages` entirely rather than passing an empty one,
      // so guarding here keeps a stray `[]` from erasing a real transcript.
      if (uiMessages.length === 0 && !input.forceEmptyMessages) {
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
            this.data.uiMessages = dehydrated;
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
    if (!this.data.name || this.data.name === "New Session") {
      const firstUserText = getFirstUserInput(uiMessages || []).trim();
      // A brand-new session is persisted *before* its first turn by state-only writes:
      // state-only persists carry no `uiMessages`, and `/clear` queues one (its mode
      // resets), whose lazily-resolved payload lands after the new session is adopted. There is
      // nothing to title at that point — an empty prompt produced a title with no conversation
      // behind it and a wasted side call (some providers reject the empty input outright, which
      // surfaced only as a `side-query` warn). Title only once a persist actually carries a
      // first user message.
      if (firstUserText) {
        // Capture the session identity: the title LLM call is async, and a /new or
        // /resume during it swaps `this.data`. Without this guard the old session's
        // title would be written into (and persisted to) the new session.
        const target = this.data;
        this.generateSessionTitle(firstUserText, { usage, resolveTextAdapter, log }).then((title) => {
          if (this.data !== target) return;
          const trimmed = title.trim();
          if (!trimmed) {
            // A whitespace-only provider reply. Keep "New Session" — and repair legacy
            // blank names so the UI never shows an empty label — until a later persist
            // regenerates the title.
            if (!target.name || !target.name.trim()) {
              target.name = "New Session";
              void this.saveToStore(emitEvent, "session-title");
            }
            return;
          }
          target.name = trimmed;
          // Broadcast the new display name so live UI / snapshots see the
          // auto-generated title (the write above only touches SessionData).
          onTitleResolved?.(trimmed);
          // Reuse the unified save path so a title-write failure also emits
          // `session:save-error` (target "session-title").
          void this.saveToStore(emitEvent, "session-title");
        });
      }
    }

    // A session reaches disk only once it has something to write. `/clear` starts a
    // brand-new session, and a mode/effort/model toggle issued before the first message
    // persists *state* against it — but an empty session that nothing can be resumed from
    // is not worth a file. Create it on the first save that carries a message; the state
    // computed above rides along with that write. This is also what keeps `/resume` free of
    // empty "New Session" rows. A skip is "nothing to write yet", not a failure — the caller
    // asked for state that is derived and will be written by the next content save.
    const store = this.store;
    if (store && this.data.uiMessages.length === 0 && !(await store.exists(this.data.id))) {
      return messagesPersisted;
    }

    const saveTarget = uiMessages !== undefined ? "session+uiMessages" : "session";
    // Await so callers that `await persistSession` observe durability; emit on
    // failure (do not rethrow — persist remains best-effort for fire-and-forget hosts).
    const saved = await this.saveToStore(emitEvent, saveTarget);
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

    this.setSessionData(session);
    await this.store.save(session);

    return {
      ...session,
      uiMessages: hydrated,
    };
  }
}
