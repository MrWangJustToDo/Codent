/**
 * {@link ExtensionUI} implementation.
 *
 * The unified bus is the single mechanism (no internal pub/sub registry), so every state change
 * is a `notify` call the session `extension-ui` channel projection can consume. Render slots are
 * retained so a host subscribing late can reconcile, and are attributed to an owner so disabling
 * an extension clears its slots.
 *
 * Extracted from `runner.ts` (which is at the file-size ceiling) and cohesive on its own: slots,
 * throttling, dedupe, and owner scoping are one concern, and the runner only constructs it, wraps
 * it per owner, and reads the retained slots.
 */

import { fingerprintOf, normalizePayload, slotId } from "./render-payload.js";

import type { ExtensionNotificationLevel, ExtensionRenderPayload, ExtensionUI, ExtensionUiContext } from "./types.js";
import type { AgentEventBus, AgentExtensionUiEvent } from "../agent-event-bus";

/** Throttle window for coalescing render notifications (ms). */
const RENDER_THROTTLE_MS = 100;

export class DefaultExtensionUI implements ExtensionUI {
  /** surface → key → payload (retained for late-subscriber reconciliation). */
  private readonly slots = new Map<string, Map<string, ExtensionRenderPayload>>();
  /** slot id → owning extension id, for owner-scoped teardown. */
  private readonly slotOwners = new Map<string, string>();
  /** Coalesced, not-yet-notified slot updates. */
  private readonly pending = new Map<
    string,
    { surface: string; key: string; payload: ExtensionRenderPayload | null }
  >();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;

  constructor(
    private readonly bus: AgentEventBus | null,
    private readonly buildContext: () => ExtensionUiContext
  ) {}

  /**
   * Publish an `extension:ui` observer event on the agent's scoped bus (the session
   * `extension-ui` channel projection consumes it). The internal pub/sub registry is gone — the
   * bus is the single mechanism.
   */
  emitEvent(event: AgentExtensionUiEvent): void {
    this.bus?.emit("extension:ui", event);
  }

  /**
   * Host-native, auto-clearing notification (the CLI renders it in its input feedback line).
   * Persistent content belongs in a {@link render} slot.
   */
  notify(message: string, level: ExtensionNotificationLevel = "info"): void {
    this.emitEvent({ type: "notify", message, level });
  }

  /**
   * Subscribe to one `extension:ui` notification type via the bus (facade over `extension:ui`
   * events; kept so `ctx.ui.subscribe` keeps its shape).
   */
  subscribe<T = unknown>(type: string, handler: (data: T) => void): () => void {
    if (!this.bus) return () => {};
    return this.bus.on("extension:ui", (event) => {
      if (event.payload.type === type) handler(event.payload as T);
    });
  }

  /**
   * Write a render payload into a surface slot. `ownerId` is supplied by `ExtensionRunner.wrapUi`
   * so a disabled extension's slots can be cleared later. Empty/whitespace raw strings,
   * non-renderable payloads, and payloads that are not JSON-serializable are all normalized to
   * `null` (remove the slot).
   */
  render(surface: string, key: string, payload: ExtensionRenderPayload | null, ownerId?: string): void {
    try {
      const next = normalizePayload(payload);
      const id = slotId(surface, key);
      // Identical payload: nothing to render, so do not notify the host at all.
      if (fingerprintOf(this.slots.get(surface)?.get(key) ?? null) === next.fingerprint) return;
      this.writeSlot(surface, key, next.value);
      if (ownerId !== undefined) {
        // Only existing slots are owned; a removed slot drops its owner entry so the ownership
        // map cannot grow without bound.
        if (next.value === null) this.slotOwners.delete(id);
        else this.slotOwners.set(id, ownerId);
      }
      this.queueNotify(surface, key, next.value);
    } catch {
      // Failure contained: a broken publish must not break the host UI or the agent loop.
    }
  }

  /** Retained slots (surface → key → payload); lets a late host reconcile. */
  getSlots(): Readonly<Record<string, Record<string, ExtensionRenderPayload>>> {
    const out: Record<string, Record<string, ExtensionRenderPayload>> = {};
    for (const [surface, slots] of this.slots) out[surface] = Object.fromEntries(slots);
    return out;
  }

  getContext(): ExtensionUiContext {
    return this.buildContext();
  }

  /**
   * Remove every slot owned by `ownerId` and notify the host, so a disabled extension's UI does
   * not linger.
   */
  clearSlotsByOwner(ownerId: string): void {
    for (const [id, owner] of Array.from(this.slotOwners)) {
      if (owner !== ownerId) continue;
      this.slotOwners.delete(id);
      const [surface, key] = id.split("\u0000");
      if (surface === undefined || key === undefined) continue;
      this.writeSlot(surface, key, null);
      this.queueNotify(surface, key, null);
    }
  }

  /** Remove all slots and notify the host. */
  clearAllSlots(): void {
    for (const [surface, slots] of this.slots) {
      for (const key of slots.keys()) this.queueNotify(surface, key, null);
    }
    this.slots.clear();
    this.slotOwners.clear();
    this.flush();
  }

  /** Flush coalesced notifications immediately (used on teardown). */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.size === 0) return;
    const updates = Array.from(this.pending.values());
    this.pending.clear();
    this.lastFlushAt = Date.now();
    for (const update of updates) {
      this.emitEvent({ type: "render", surface: update.surface, key: update.key, payload: update.payload });
    }
  }

  private writeSlot(surface: string, key: string, payload: ExtensionRenderPayload | null): void {
    if (payload === null) {
      const existing = this.slots.get(surface);
      if (!existing) return;
      existing.delete(key);
      if (existing.size === 0) this.slots.delete(surface);
      return;
    }
    let slots = this.slots.get(surface);
    if (!slots) {
      slots = new Map();
      this.slots.set(surface, slots);
    }
    slots.set(key, payload);
  }

  /**
   * Coalesce slot updates and notify at most once per {@link RENDER_THROTTLE_MS} window (leading
   * edge): rapid publishes collapse to the latest payload per slot instead of re-rendering the
   * host on every write.
   */
  private queueNotify(surface: string, key: string, payload: ExtensionRenderPayload | null): void {
    this.pending.set(slotId(surface, key), { surface, key, payload });
    const elapsed = Date.now() - this.lastFlushAt;
    if (elapsed >= RENDER_THROTTLE_MS) {
      this.flush();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, RENDER_THROTTLE_MS - elapsed);
    // Never keep a host process alive just to flush extension UI.
    (this.flushTimer as { unref?: () => void }).unref?.();
  }
}
