/**
 * BridgeRuntime — wires a {@link ChatAdapter} onto AgentSessions.
 *
 * Inbound:  message → allowlist → session resolver → dispatch send/steer
 *           (steer while the agent pump is running, send when idle). Images the
 *           adapter downloaded ride along as multimodal `ContentPart[]`.
 * Outbound: subscribe messages/state per reply cycle → RunRenderer posts
 *           assistant text as its own message and collapses consecutive tool
 *           calls into ONE message edited in place (see RunRenderer) — in
 *           actual part order. Interaction messages (approval / ask_user, whose
 *           buttons ride on the tool call's own message) update in place too.
 *
 * The runtime is transport-agnostic: adapters translate platforms, the runtime
 * owns orchestration. Sessions are remote (`createRemoteAgentSessionHost`) by
 * default — the same path as the CLI's `--remote-session`.
 */

import { BUILTIN_TOOL_NAMES, isActiveStatus } from "@codent/core";
import { createRemoteAgentSessionHost } from "@codent/server/client";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { AccessControl } from "./access.js";
import { decodeButtonPayload, PendingInteractionStore, type PendingRecord } from "./interaction/pending.js";
import { currentRunMessages, scanPendingInteractions } from "./interaction/render.js";
import { createLocalSessionHost } from "./local-host.js";
import { SessionResolver, sessionKeyOf } from "./session-resolver.js";
import { RunRenderer } from "./streaming/run-renderer.js";

import type { BridgeConfig } from "./config.js";
import type { ButtonCallback, ChatAdapter, ChatTarget, InboundMessage } from "./types.js";
import type { AgentSession, AgentSessionCommand, AgentSessionHost } from "@codent/core";
import type { ContentPart, UIMessage } from "@tanstack/ai";

export interface BridgeRuntimeOptions {
  config: BridgeConfig;
  adapter: ChatAdapter;
  /** Host override for tests; defaults to `createRemoteAgentSessionHost({ baseUrl })`. */
  host?: AgentSessionHost;
  onError?: (error: unknown) => void;
}

interface ReplyCycle {
  chatKey: string;
  chat: ChatTarget;
  /** User that started the cycle — allowed to answer its interactions. */
  userId: string;
  /** null while the "⏳" placeholder is in flight; buffered events sync once it resolves. */
  renderer: RunRenderer | null;
  /** Latest messages payload while `renderer` is null. */
  bufferedMessages: UIMessage[] | null;
  /** Retired (finalized / healed over) — late events and edits are ignored. */
  closed: boolean;
  unsubscribe: () => void;
  finalizeTimer: ReturnType<typeof setTimeout> | null;
  /** Periodic sendChatAction while the run works but nothing posted yet. */
  typingTimer: ReturnType<typeof setInterval> | null;
  /** Interaction ids already registered as buttons on this cycle. */
  registered: Set<string>;
}

const IDLE_FINALIZE_DELAY_MS = 500;

/**
 * Statuses that mean a run has really finished.
 *
 * NOT everything ≠ "running", and NOT "idle": the server emits a reconcile
 * `idle` right after the user message lands (BEFORE the pump flips to
 * `running`), and mid-run it flickers through `thinking` / `responding` /
 * `waiting` / `awaiting_user` (ask_user pause) / `compacting`. Finalizing on
 * any of those freezes the placeholder and tears down the subscription while
 * the run is still producing content, so the reply only surfaces one message
 * later (stale snapshot on the next cycle).
 */
function isRunFinished(status: string): boolean {
  return status === "completed" || status === "error" || status === "aborted";
}
export class BridgeRuntime {
  private readonly config: BridgeConfig;
  private readonly adapter: ChatAdapter;
  private readonly host: AgentSessionHost;
  private readonly access: AccessControl;
  private readonly resolver: SessionResolver;
  private readonly pending: PendingInteractionStore;
  private readonly onError: (error: unknown) => void;

  /** chatKey → live session, used by button callbacks and TTL expiry. */
  private readonly activeSessions = new Map<string, AgentSession>();
  /** chatKey → live reply cycle (subscription established synchronously). */
  private readonly cycles = new Map<string, ReplyCycle>();
  private started = false;

  constructor(options: BridgeRuntimeOptions) {
    this.config = options.config;
    this.adapter = options.adapter;
    this.host = options.host ?? throwHostRequired();
    this.access = new AccessControl(options.config);
    this.resolver = new SessionResolver(this.host, options.config);
    this.onError = options.onError ?? (() => {});
    this.pending = new PendingInteractionStore(options.config.approvalTtlMs, (record) =>
      this.expireInteraction(record)
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.resolver.init();
    this.adapter.onMessage((msg) => {
      // Fire-and-forget: dispatch(send) blocks server-side until the whole run
      // finishes — awaiting it in the adapter's update loop would stall
      // steering and /stop for the run's entire duration.
      const handled = this.handleMessage(msg);
      handled.catch(() => {});
      return Promise.resolve();
    });
    this.adapter.onButton((cb) => this.handleButton(cb));
    await this.adapter.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.pending.clear();
    for (const cycle of this.cycles.values()) {
      cycle.closed = true;
      this.teardownCycle(cycle);
    }
    this.cycles.clear();
    await this.adapter.stop();
  }

  // ---------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------

  private async handleMessage(msg: InboundMessage): Promise<void> {
    try {
      if (!this.access.allows(msg)) {
        // Say nothing in groups (avoid noise); inform the user in DMs.
        if (msg.chat.chatType === "private") await this.safeSendText(msg.chat, "⛔ Not authorized.");
        return;
      }
      if (msg.command === "new") {
        // Stop an in-flight run first — finalizeCycleObject skips active runs
        // (see the stale-finalize guard there), so clearing must not race one.
        const active = this.activeSessions.get(sessionKeyOf(msg.platform, msg.chat));
        if (active && isActiveStatus(active.getSnapshot().status)) {
          await this.dispatch(active, { type: "stop" });
        }
        await this.finalizeCycle(msg.platform, msg.chat);
        await this.resolver.reset(msg.platform, msg.chat);
        await this.safeSendText(msg.chat, "🔄 Session cleared. Send a message to start a new one.");
        return;
      }
      if (msg.command === "stop") {
        const key = sessionKeyOf(msg.platform, msg.chat);
        const session = this.activeSessions.get(key);
        if (session) await this.dispatch(session, { type: "stop" });
        return;
      }

      // A plain text message while an ask_user is pending IS that interaction's
      // answer — this is the free-form reply path and the ONLY way to answer an
      // ask_user that carries no predefined options. Bridge commands are handled
      // above, so they never get swallowed as answers.
      const pendingAsk = this.pending.findPendingAskUser(sessionKeyOf(msg.platform, msg.chat));
      if (pendingAsk && msg.text.trim().length > 0 && this.pending.canAnswer(pendingAsk, msg.userId)) {
        await this.answerAskUser(pendingAsk, msg.text.trim());
        return;
      }

      // The dispatch payload is assembled ONCE: plain text normally, a
      // multimodal `ContentPart[]` when the message carries images (the same
      // shape the app / CLI send for pasted images). An empty payload (sticker /
      // voice / empty service message) would just burn a round-trip — drop it.
      const content = toDispatchContent(msg);
      if (typeof content === "string" && content.trim().length === 0) return;

      void this.adapter.setTyping?.(msg.chat).catch(() => {});

      const { session } = await this.resolveSession(msg);
      const status = session.getSnapshot().status;
      // Active-run detection mirrors the app layer: mid-run status flickers
      // through thinking/responding/waiting/compacting — steering into all of
      // them keeps ONE live stream instead of finalizing the cycle and
      // splitting the run across chat messages (with duplicate dead buttons).
      // `awaiting_user` is excluded: the agent is paused on a client tool, the
      // text is a new turn, not a steer into the paused pump.
      const running = isActiveStatus(status) && status !== "awaiting_user";
      if (running) {
        // Steer into the running cycle. Finalizing + a new placeholder here
        // would split one run across multiple chat messages AND re-register
        // its pending interactions as duplicate (dead) button rows — the old
        // buttons stay clickable-looking but resolve to "expired".
        const steer = await this.dispatch(session, { type: "steer", content });
        if (!steer.ok && (steer as { code?: string }).code === "not_found") {
          // Stale mapping (e.g. server restarted) — heal and start fresh
          // instead of silently swallowing every following message.
          this.resolver.invalidate(msg.platform, msg.chat);
          const healed = await this.resolveSession(msg);
          const cycle = this.beginReplyCycle(healed.session, msg);
          if (cycle) await this.dispatch(healed.session, { type: "send", content });
        }
        return;
      }
      await this.finalizeCycle(msg.platform, msg.chat);

      // The reply cycle — and its SSE subscription — must exist BEFORE the
      // dispatch: the server runs the agent synchronously, so dispatch(send)
      // resolves only when the whole run has finished. A subscription created
      // after dispatch would miss EVERY messages/state event of the run and
      // the placeholder would stay stale until the next message's resync.
      const cycle = this.beginReplyCycle(session, msg);
      if (cycle === null) {
        // A cycle is already live (double-message race) — inject as steer.
        await this.dispatch(session, { type: "steer", content });
        return;
      }

      const result = await this.dispatch(session, { type: "send", content });
      if (!result.ok && result.code === "not_found") {
        // Stale mapping (e.g. server restarted) — retire the premature cycle,
        // heal and retry once.
        await this.retireCycle(cycle, "⚠️ session expired, retrying…");
        this.resolver.invalidate(msg.platform, msg.chat);
        const healed = await this.resolveSession(msg);
        const healedCycle = this.beginReplyCycle(healed.session, msg);
        if (healedCycle) await this.dispatch(healed.session, { type: "send", content });
        return;
      }
      if (!result.ok) {
        // Transport failures (e.g. the blocking dispatch outlasting the HTTP
        // headers timeout) happen WHILE the run is live — the SSE cycle keeps
        // streaming, so only retire when no run is actually going (finished
        // OR never started — e.g. ECONNREFUSED while the snapshot was idle).
        const status = session.getSnapshot().status;
        if (isRunFinished(status) || !isActiveStatus(status)) {
          const detail = result.error ?? "dispatch failed";
          await this.retireCycle(cycle, `⚠️ ${detail.slice(0, 300)}`);
        }
      }
    } catch (error) {
      this.onError(error);
      await this.safeSendText(msg.chat, `⚠️ ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    }
  }

  private async resolveSession(msg: InboundMessage): Promise<{ session: AgentSession; chatKey: string }> {
    const { session } = await this.resolver.getOrCreate(msg.platform, msg.chat, msg.userId);
    const chatKey = sessionKeyOf(msg.platform, msg.chat);
    this.activeSessions.set(chatKey, session);
    return { session, chatKey };
  }

  private async dispatch(session: AgentSession, command: AgentSessionCommand) {
    try {
      return await session.dispatch(command);
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound (reply cycles)
  // ---------------------------------------------------------------------------

  private beginReplyCycle(session: AgentSession, msg: InboundMessage): ReplyCycle | null {
    const chatKey = sessionKeyOf(msg.platform, msg.chat);
    // One reply cycle per chat: an in-flight creation (double message, race
    // between sendText and the map insert) reuses the existing cycle instead
    // of spawning a second placeholder streaming the same run.
    if (this.cycles.has(chatKey)) return null;
    // Subscribe SYNCHRONOUSLY (before any dispatch) so no run event is missed;
    // the placeholder message goes out in parallel and buffered events flush
    // once it resolves.
    const cycle: ReplyCycle = {
      chatKey,
      chat: msg.chat,
      userId: msg.userId,
      renderer: null,
      bufferedMessages: null,
      closed: false,
      unsubscribe: session.subscribe((event) => this.onSessionEvent(cycle, event), {
        channels: ["messages", "state"],
      }),
      finalizeTimer: null,
      typingTimer: null,
      registered: new Set(),
    };
    this.cycles.set(chatKey, cycle);
    // Typing heartbeat: sendChatAction expires after ~5s — re-send for the
    // WHOLE run (until the cycle retires). Output is non-streaming, so content
    // posts are sparse: stopping at the first posted segment left the chat
    // looking dead through the LLM's long responding/tool stretches.
    if (this.adapter.setTyping) {
      cycle.typingTimer = setInterval(() => {
        if (cycle.closed) {
          if (cycle.typingTimer !== null) clearInterval(cycle.typingTimer);
          cycle.typingTimer = null;
          return;
        }
        void this.adapter.setTyping?.(cycle.chat).catch(() => {});
      }, 4_000);
    }
    void this.adapter
      .sendText(msg.chat, "⏳")
      .then((reply) => {
        const renderer = new RunRenderer({
          adapter: this.adapter,
          chat: msg.chat,
          placeholderRef: reply,
          onError: this.onError,
          onDebug: (message) => this.diag(message),
          // The answer TTL starts when the row is actually visible — a long run's
          // tool-line backlog must never expire an interaction the user never saw.
          onInteractionRendered: (segmentKey) => {
            const requestId = this.pending.markRenderedBySegment(segmentKey);
            if (requestId) this.diag(`interaction rendered segment=${segmentKey} r=${requestId}`);
          },
        });
        cycle.renderer = renderer;
        const buffered = cycle.bufferedMessages;
        cycle.bufferedMessages = null;
        if (buffered) renderer.sync(buffered);
        if (cycle.closed) {
          // The run finished while the placeholder was in flight — flush what
          // buffered; interactions can no longer be answered.
          void renderer.finalize().catch(() => {});
          return;
        }
        if (buffered) this.registerInteractions(cycle, buffered);
      })
      .catch((error) => {
        // The placeholder send failed (transient 429 flood control / blocked
        // bot). Keep the cycle alive: renderCycle keeps buffering into
        // `bufferedMessages`, and retireCycle delivers the final text directly —
        // the run's reply must not be silently lost because the placeholder
        // never landed.
        this.onError(error);
      });
    return cycle;
  }

  private onSessionEvent(cycle: ReplyCycle, event: { channel: string; payload: unknown }): void {
    if (cycle.closed) return;
    try {
      if (event.channel === "messages") {
        this.renderCycle(cycle, event.payload as UIMessage[]);
        return;
      }
      if (event.channel === "state") {
        // Trust the EVENT's status, not a fresh snapshot re-read: a new run's
        // first state event can arrive while the snapshot still holds the
        // PREVIOUS run's "completed" — re-reading here armed a finalize that
        // killed the just-started run's cycle (the "✅ done" bug).
        const status =
          (event.payload as { status?: string } | undefined)?.status ??
          this.activeSessions.get(cycle.chatKey)?.getSnapshot().status;
        if (status && isRunFinished(status)) this.scheduleFinalize(cycle);
      }
    } catch (error) {
      this.onError(error);
    }
  }

  private renderCycle(cycle: ReplyCycle, messages: UIMessage[]): void {
    if (cycle.closed) return;
    if (cycle.renderer === null) {
      // Placeholder still in flight — buffer; synced once it resolves.
      cycle.bufferedMessages = messages;
      return;
    }
    cycle.renderer.sync(messages);
    this.registerInteractions(cycle, messages);
  }

  /**
   * Register pending interactions as buttons ON their tool segment's message
   * (the same message that shows `… · ⏸️ awaiting approval`). Registration
   * is synchronous before the renderer's post lands, so a button click can
   * never race the pending record's creation.
   */
  private registerInteractions(cycle: ReplyCycle, messages: UIMessage[]): void {
    if (cycle.renderer === null) return;
    for (const interaction of scanPendingInteractions(currentRunMessages(messages))) {
      const id = interaction.kind === "approval" ? interaction.approvalId : interaction.toolCallId;
      if (cycle.registered.has(id)) continue;
      cycle.registered.add(id);
      // Cross-cycle dedup: during a retire/recreate window two cycles can both
      // receive events (each keeps its own `registered` set) — the interaction
      // must only ever be posted once.
      if (this.postedInteractionIds.has(id)) continue;
      this.rememberPostedInteraction(id);
      const requestId = this.pending.nextRequestId();
      const record = this.pending.register(
        interaction,
        {
          chatKey: cycle.chatKey,
          chat: cycle.chat,
          userId: cycle.userId,
          messageId: null,
        },
        requestId
      );
      cycle.renderer.setButtons(interaction.segmentKey, this.pending.buttonsFor(record));
      this.diag(
        `interaction registered id=${id} r=${requestId} segment=${interaction.segmentKey} kind=${interaction.kind}`
      );
    }
  }

  private scheduleFinalize(cycle: ReplyCycle): void {
    if (cycle.finalizeTimer !== null) return;
    cycle.finalizeTimer = setTimeout(() => {
      // Reset BEFORE running: a skipped finalize (new run started, see
      // finalizeCycleObject) must leave the timer re-armable for the run's own
      // completed event, and retireCycle only clears a PENDING timer.
      cycle.finalizeTimer = null;
      void this.finalizeCycleObject(cycle);
    }, IDLE_FINALIZE_DELAY_MS);
  }

  private async finalizeCycle(platform: string, chat: ChatTarget): Promise<void> {
    const cycle = this.cycles.get(sessionKeyOf(platform, chat));
    if (cycle) await this.finalizeCycleObject(cycle);
  }

  private async finalizeCycleObject(cycle: ReplyCycle): Promise<void> {
    // The finalize decision was made up to IDLE_FINALIZE_DELAY_MS ago —
    // re-check before retiring: a steer continuation or the next run may have
    // flipped the status back to active, and retiring now would kill the live
    // run and lose its output (rendered as the empty "✅ done").
    const status = this.activeSessions.get(cycle.chatKey)?.getSnapshot().status ?? "idle";
    if (isActiveStatus(status)) return;
    await this.retireCycle(cycle);
  }

  /**
   * Retire a cycle: flush the segments' final content (unsealed text, split
   * when over the platform limit), close the renderer, unsubscribe. Segments
   * are already posted in part order — the run's answer needs no separate
   * final dump.
   *
   * `fatalText` (transport failure / expired session) replaces the placeholder
   * with an error notice instead of flushing content.
   */
  private async retireCycle(cycle: ReplyCycle, fatalText?: string): Promise<void> {
    if (cycle.closed) return;
    cycle.closed = true;
    if (cycle.finalizeTimer !== null) {
      clearTimeout(cycle.finalizeTimer);
      cycle.finalizeTimer = null;
    }
    if (cycle.typingTimer !== null) {
      clearInterval(cycle.typingTimer);
      cycle.typingTimer = null;
    }
    // Detach from the event stream FIRST — the final flushes below can take
    // seconds (flood backoff), and a new cycle may be created in that window;
    // events must never reach the retiring cycle again.
    if (this.cycles.get(cycle.chatKey) === cycle) this.cycles.delete(cycle.chatKey);
    cycle.unsubscribe();
    const renderer = cycle.renderer;
    if (renderer === null) {
      // Placeholder never resolved (send failed) — deliver the text as a fresh
      // message instead of dropping the run's reply.
      await this.safeSendText(cycle.chat, fatalText ?? "✅ done");
      return;
    }
    try {
      if (fatalText !== undefined) await renderer.fail(fatalText);
      else await renderer.finalize();
    } catch (error) {
      this.onError(error);
    }
  }

  private teardownCycle(cycle: ReplyCycle): void {
    if (cycle.finalizeTimer !== null) clearTimeout(cycle.finalizeTimer);
    if (cycle.typingTimer !== null) clearInterval(cycle.typingTimer);
    cycle.unsubscribe();
  }

  // ---------------------------------------------------------------------------
  // Cross-cycle interaction dedup (explicit FIFO per repo cache convention)
  // ---------------------------------------------------------------------------

  private readonly postedInteractionIds = new Set<string>();
  private readonly postedInteractionOrder: string[] = [];
  private static readonly POSTED_INTERACTIONS_CAP = 300;

  private rememberPostedInteraction(id: string): void {
    if (this.postedInteractionIds.has(id)) return;
    this.postedInteractionIds.add(id);
    this.postedInteractionOrder.push(id);
    while (this.postedInteractionOrder.length > BridgeRuntime.POSTED_INTERACTIONS_CAP) {
      const oldest = this.postedInteractionOrder.shift();
      if (oldest !== undefined) this.postedInteractionIds.delete(oldest);
    }
  }

  // ---------------------------------------------------------------------------
  // Buttons (approval / ask_user)
  // ---------------------------------------------------------------------------

  private async handleButton(cb: ButtonCallback): Promise<void> {
    try {
      const payload = decodeButtonPayload(cb.data);
      if (!payload) {
        await cb.ack();
        return;
      }
      const record = this.pending.peek(payload.r);
      if (!record) {
        await cb.ack();
        await this.safeEditText(cb, "⏳ Expired or already answered.");
        return;
      }
      if (!this.pending.canAnswer(record, cb.userId)) {
        await cb.ack();
        return;
      }

      // Multi-select toggle: flip the option and re-render the SAME row — no
      // resolution, no dispatch. The Submit button commits the selection.
      if (payload.a === "t") {
        this.pending.toggleOption(record, payload.i);
        await cb.ack();
        const renderer = this.cycles.get(record.chatKey)?.renderer;
        renderer?.setButtons(record.pending.segmentKey, this.pending.buttonsFor(record));
        this.diag(`button toggle r=${payload.r} i=${payload.i} selected=[${[...record.selected].join(",")}]`);
        return;
      }

      // Resolve (and clear the TTL) BEFORE any async dispatch: a racing TTL
      // expiry must not double-answer.
      const resolved = this.pending.resolveById(payload.r);
      if (!resolved) {
        await cb.ack();
        return;
      }
      const session = this.activeSessions.get(resolved.chatKey);
      await cb.ack();
      // Feedback FIRST: applyInteraction's dispatch blocks until the rest of
      // the run finishes (local mode), and the run events that re-render the
      // line take another round-trip. Settle the row immediately (buttons
      // dropped + outcome shown) and submit in the background; failures
      // surface via onError.
      this.diag(
        `button click a=${payload.a} r=${payload.r} kind=${resolved.pending.kind} segment=${resolved.pending.segmentKey} session=${session ? "yes" : "no"}`
      );
      this.settleInteractionRow(resolved, this.outcomeFor(resolved, payload));
      void this.applyInteraction(session, resolved, payload).catch((error) => this.onError(error));
    } catch (error) {
      this.onError(error);
      await cb.ack();
    }
  }

  /**
   * Answer a pending ask_user with free-form text (a plain reply while the
   * question is pending). Also the only answer path when the tool was called
   * without options.
   */
  private async answerAskUser(record: PendingRecord, answer: string): Promise<void> {
    if (record.pending.kind !== BUILTIN_TOOL_NAMES.askUser) return;
    this.pending.resolveById(record.requestId);
    const preview = answer.length > 120 ? `${answer.slice(0, 119)}…` : answer;
    this.settleInteractionRow(record, `▸ ${preview}`);
    this.diag(`free-text answer r=${record.requestId} segment=${record.pending.segmentKey}`);
    const session = this.activeSessions.get(record.chatKey);
    if (!session) return;
    await this.dispatch(session, {
      type: "addToolResult",
      toolCallId: record.pending.toolCallId,
      output: {
        question: record.pending.question,
        answer,
        hasOptions: record.pending.options.length > 0,
        multiSelect: false,
        draft: answer,
        durationMs: this.elapsedSinceRendered(record),
        cachedOutputPath: null,
      },
    });
  }

  /** Row outcome label shown right after an answer. */
  private outcomeFor(record: PendingRecord, payload: NonNullable<ReturnType<typeof decodeButtonPayload>>): string {
    if (record.pending.kind === "approval") return payload.a === "y" ? "✅ approved" : "❌ denied";
    if (payload.a === "s") {
      const selected = this.pending.selectedOptions(record);
      return `▸ ${selected.length > 0 ? selected.join(", ") : "(no answer)"}`;
    }
    return `▸ ${record.pending.options[payload.i ?? -1] ?? "(no answer)"}`;
  }

  /** Milliseconds since the interaction row became visible (0 when unknown). */
  private elapsedSinceRendered(record: PendingRecord): number {
    return record.renderedAt !== null ? Date.now() - record.renderedAt : 0;
  }

  private async applyInteraction(
    session: AgentSession | undefined,
    record: PendingRecord,
    payload: NonNullable<ReturnType<typeof decodeButtonPayload>>
  ): Promise<void> {
    if (!session) return;
    if (record.pending.kind === "approval") {
      const approved = payload.a === "y";
      await this.dispatch(session, {
        type: "respondApproval",
        approvalId: record.pending.approvalId,
        approved,
        ...(approved ? {} : { reason: "denied via IM" }),
      });
      return;
    }
    const durationMs = this.elapsedSinceRendered(record);
    // Multi-select Submit: report the checked set structurally (option text may
    // itself contain commas, so a joined `answer` alone is ambiguous).
    if (payload.a === "s") {
      const selected = this.pending.selectedOptions(record);
      await this.dispatch(session, {
        type: "addToolResult",
        toolCallId: record.pending.toolCallId,
        output: {
          question: record.pending.question,
          answer: selected.length > 0 ? selected.join(", ") : "(no answer)",
          hasOptions: record.pending.options.length > 0,
          multiSelect: true,
          ...(selected.length > 0 ? { selected } : {}),
          durationMs,
          cachedOutputPath: null,
        },
      });
      return;
    }
    const option = record.pending.options[payload.i ?? -1] ?? "(no answer)";
    await this.dispatch(session, {
      type: "addToolResult",
      toolCallId: record.pending.toolCallId,
      output: {
        question: record.pending.question,
        answer: option,
        hasOptions: record.pending.options.length > 0,
        multiSelect: false,
        durationMs,
        cachedOutputPath: null,
      },
    });
  }

  /**
   * Settle an interaction row in place: buttons dropped + outcome shown on the
   * tool's own message (the only allowed in-place updates besides button
   * drops). No-op when the cycle/renderer is gone — the row stays as history.
   */
  private settleInteractionRow(record: PendingRecord, outcome: string): void {
    const pending = record.pending;
    // No leading state glyph here: the outcome already carries the status emoji
    // (✅/❌ for approvals) or `▸` (answer), so a second glyph would just read as noise.
    const line =
      pending.kind === "approval" ? `${pending.question} · ${outcome}` : `ask_user · ${pending.question} · ${outcome}`;
    const renderer = this.cycles.get(record.chatKey)?.renderer;
    const settled = renderer?.settle(pending.segmentKey, line) ?? false;
    this.diag(
      `settle ${pending.kind} segment=${pending.segmentKey} outcome=${JSON.stringify(outcome)} applied=${settled}${renderer ? "" : " renderer=absent"}`
    );
  }

  /**
   * Best-effort diagnostic line into `<dataDir>/bridge.log` — the daemon's
   * console is often unattended, and renderer-side edit failures surface only
   * here; without a file sink a frozen row is undiagnosable after the fact.
   */
  private diag(message: string): void {
    try {
      appendFileSync(join(this.config.dataDir, "bridge.log"), `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Diagnostics must never break the flow.
    }
  }

  /** TTL expiry → auto-deny (approval) / timeout answer (ask_user). */
  private async expireInteraction(record: PendingRecord): Promise<void> {
    try {
      // Row feedback is independent of session availability — buttons must
      // never linger on an expired interaction.
      if (record.pending.kind === "approval") this.settleInteractionRow(record, "❌ denied (timed out)");
      else this.settleInteractionRow(record, "▸ (timed out)");
      const session = this.activeSessions.get(record.chatKey);
      if (!session) return;
      if (record.pending.kind === "approval") {
        await this.dispatch(session, {
          type: "respondApproval",
          approvalId: record.pending.approvalId,
          approved: false,
          reason: "timed out",
        });
      } else {
        await this.dispatch(session, {
          type: "addToolResult",
          toolCallId: record.pending.toolCallId,
          output: {
            question: record.pending.question,
            answer: "(timed out)",
            hasOptions: record.pending.options.length > 0,
            multiSelect: record.pending.multiSelect,
            durationMs: this.config.approvalTtlMs,
            cachedOutputPath: null,
          },
        });
      }
    } catch (error) {
      this.onError(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async safeSendText(chat: ChatTarget, text: string): Promise<void> {
    try {
      await this.adapter.sendText(chat, text);
    } catch (error) {
      this.onError(error);
    }
  }

  private async safeEditText(cb: ButtonCallback, text: string): Promise<void> {
    try {
      await this.adapter.editMessage(cb.chat, cb.messageId, text);
    } catch (error) {
      this.onError(error);
    }
  }
}

function throwHostRequired(): never {
  throw new Error("BridgeRuntime requires a host (or use createImBridge which wires the remote host).");
}

/**
 * Build the dispatch content for an inbound message: plain text when nothing is
 * attached, otherwise a multimodal `ContentPart[]` (text + one image part per
 * attachment). Mirrors the app layer's `toChatContent` so a Telegram photo
 * reaches the model exactly like a pasted image from the CLI / extension.
 */
function toDispatchContent(msg: InboundMessage): string | ContentPart[] {
  const attachments = msg.attachments ?? [];
  if (attachments.length === 0) return msg.text;
  const parts: ContentPart[] = [];
  if (msg.text.trim().length > 0) parts.push({ type: "text", content: msg.text });
  attachments.forEach((attachment, index) => {
    parts.push({
      type: "image",
      source: { type: "url", value: attachment.dataUrl },
      metadata: { mediaType: attachment.mediaType, filename: attachment.filename, imageIndex: index + 1 },
    });
  });
  return parts;
}
/**
 * Create a bridge. Default wiring:
 * - `REMOTE_SESSION` set → remote host (the same session path as the CLI's
 *   `--remote-session`); pass `host` to override (tests / in-process core).
 * - no `REMOTE_SESSION` → local mode: in-process host with a local CoreEnv and
 *   a direct model provider resolved from `.env` (same bootstrap as the CLI's
 *   local mode).
 */
export async function createImBridge(options: BridgeRuntimeOptions): Promise<BridgeRuntime> {
  let { config, host } = options;
  if (!host) {
    if (config.remoteSession) {
      host = createRemoteAgentSessionHost({ baseUrl: config.remoteSession });
    } else {
      const local = await createLocalSessionHost(config);
      host = local.host;
      // Session-create defaults resolved at bootstrap (remote mode leaves them unset).
      config = {
        ...config,
        model: local.defaults.model,
        modelStyle: local.defaults.style,
        modelBaseURL: local.defaults.baseURL,
        modelApiKey: local.defaults.apiKey,
        modelInfo: local.defaults.modelInfo,
        systemPrompt: local.defaults.systemPrompt,
      };
    }
  }
  return new BridgeRuntime({ ...options, config, host });
}
