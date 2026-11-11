import { handlerFailureKey, reportContained } from "../../utils/contained-report.js";
import { Emitter } from "../../utils/emitter.js";
import { compareDispatchRank, resolveExtensionOrder } from "../dispatch-order.js";
import {
  EXTENSION_CALLBACK_TIMEOUT_MS,
  isCallbackTimeoutError,
  withCallbackTimeout,
} from "../extension/callback-timeout.js";
import { INTERNAL_EXTENSION_EVENTS } from "../extension/event-visibility.js";

import type {
  AgentEvent,
  AgentEventBus,
  AgentEventListener,
  AgentEventMetaInput,
  AgentEventType,
  AgentEventWildcardListener,
  EventInterceptor,
  InterceptableEvent,
} from "./types.js";
import type { DispatchRank } from "../dispatch-order.js";

// ============================================================================
// Scope node
// ============================================================================

/**
 * One node in the scope tree. Observer fan-out uses a per-node {@link Emitter}
 * (the synchronous multicast primitive); an event emitted at a node is delivered
 * to that node and every ancestor (so the root observes all, siblings stay
 * isolated, and subagent scopes up-flow to their parent).
 */
class EventBusScopeNode {
  readonly observers = new Emitter<Record<string, AgentEvent>>();
  /**
   * Wrapper objects, not raw functions: a `Set` keyed by the function collapsed two subscribers
   * that share a callback (a module-level handler, a re-mounted panel) into one entry, so the first
   * disposer silently cancelled both. `Emitter` was fixed for the same reason; wildcards were not.
   */
  readonly wildcards = new Set<{ listener: AgentEventWildcardListener }>();
  /**
   * Interceptors in **dispatch order** (declared order, then load sequence) — kept sorted on
   * mutation so the hot `intercept` walk stays a plain array scan. A registration that declares
   * no order carries the default, which preserves insertion sequence via the tie-break.
   */
  readonly interceptors: Array<{
    pattern: string;
    handler: EventInterceptor<InterceptableEvent>;
    rank: DispatchRank;
    /** Cleared by the disposer; a snapshot taken before an await must not run a removed entry. */
    active: boolean;
  }> = [];
  readonly retained = new Map<string, () => unknown>();

  constructor(
    readonly id: string,
    readonly parent: EventBusScopeNode | null
  ) {}
}

// ============================================================================
// Helpers
// ============================================================================

/** Match an interceptor key against a concrete event name (`prefix:*` supported). */
function interceptorMatches(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return false;
}

/**
 * Wall-clock budget for ONE `intercept` call, across the whole scope chain.
 *
 * `intercept` is awaited by the tool gate and the run lifecycle, and it is the one dispatch mode
 * that can HOLD a tool call. A handler that never settles used to freeze every call it matched
 * with no escape: `Esc` cancels the run, not this `await`. A per-handler bound is not enough (N
 * stuck handlers would cost N x the bound), so the budget is for the chain: the first hung handler
 * consumes the remainder and the chain stops.
 *
 * It uses the same budget as `EXTENSION_CALLBACK_TIMEOUT_MS` (one constant, so the two cannot drift):
 * a legitimate slow `session:shutdown` interceptor is not cut off before the teardown wrapper around
 * it would have given up.
 */
const INTERCEPTOR_CHAIN_TIMEOUT_MS = EXTENSION_CALLBACK_TIMEOUT_MS;

/**
 * Events whose interceptor chain stopped on a timeout.
 *
 * A timed-out handler is still running: the contract has no cancellation, so it can resolve later
 * and write `modifiedArgs` / `modifiedResult` into the shared event AFTER `intercept()` returned.
 * The bus clears those fields when the timeout fires, but a write that lands in the same microtask
 * turn as the caller's continuation would be read anyway. Consumers that trust a rewrite ask
 * {@link isInterceptorTimedOut} — the event is marked here, synchronously, before the caller resumes.
 *
 * `WeakSet`, so a consumer that drops the event does not keep it alive.
 */
const timedOutEvents = new WeakSet<object>();

/** Whether this event's interceptor chain stopped on a timeout (see {@link timedOutEvents}). */
export function isInterceptorTimedOut(event: object): boolean {
  return timedOutEvents.has(event);
}

/**
 * Drop an interceptor's rewrite wherever this event keeps it.
 *
 * `modifiedArgs` is a top-level field, but `ToolAfterPayload.modifiedResult` lives INSIDE `payload`
 * (`agent/extension/types.ts`). Clearing only the top level left a half-executed `tool:after`
 * rewrite readable by the caller, and nothing but an opt-in `isInterceptorTimedOut` check stood
 * between it and the model's tool result.
 */
function clearPayloadRewrite(event: object): void {
  try {
    const payload = (event as { payload?: { modifiedResult?: unknown } }).payload;
    if (payload && typeof payload === "object") payload.modifiedResult = undefined;
  } catch {
    // Best-effort cleanup: a frozen/foreign payload must not turn a contained timeout into a throw.
  }
}

// ============================================================================
// DefaultAgentEventBus
// ============================================================================

/**
 * Unified event bus implementation. One registry, two dispatch modes:
 * - observer `emit` / `on` (synchronous, error-isolated, retained replay);
 * - interceptor `intercept` / `onIntercept` (async, ordered, shared mutable
 *   event, cancel short-circuit).
 */
export interface HandlerFailureInfo {
  pattern: string;
  event: string;
  /** Scope the interceptor was registered on (an agent id for scoped buses). */
  scopeId: string;
  error: unknown;
  /** Which dispatch mode failed. Absent means interceptor (the original caller shape). */
  kind?: "interceptor" | "observer";
}

export class DefaultAgentEventBus implements AgentEventBus {
  /** First failure per (scope, event, pattern); a broken handler would otherwise flood stderr. */
  private readonly reportedFailures = new Set<string>();
  /** Types already warned about a replaced retained provider (the map keeps exactly one owner). */
  private readonly reportedRetainedConflicts = new Set<string>();
  private readonly reporter: (info: HandlerFailureInfo) => void;

  constructor(
    private readonly node: EventBusScopeNode,
    /**
     * Reports an interceptor/observer that threw. Interceptors are the channel third-party
     * extensions write most, so an exception there must not fail the tool call or turn it wraps —
     * but silently swallowing it hides a broken extension. The host wires this to its log; without
     * it the failure is reported to stderr (once per scope/event/pattern) instead of vanishing:
     * a root-scoped host listener has no agent log to fall back to.
     */
    private readonly onInterceptorError?: (info: HandlerFailureInfo) => void,
    /**
     * Envelope fields resolved from the owning agent when the caller supplied none.
     *
     * A fact's run/session identity belongs to the agent, so every emitter gets the same answer —
     * including the domain objects that emit straight on their scoped bus instead of going through
     * the telemetry funnel (`plan`, `ui`, `stream-hub`, the extension runner).
     */
    private readonly resolveMeta?: (agentId: string) => { runId?: string; sessionId?: string } | undefined,
    /**
     * Budget for one `intercept` chain. Injectable so a validator can exercise the bound without
     * waiting a minute, and so a host with a different teardown contract can widen it.
     */
    private readonly interceptorTimeoutMs: number = INTERCEPTOR_CHAIN_TIMEOUT_MS
  ) {
    this.reporter =
      onInterceptorError ??
      ((info) => {
        const key = handlerFailureKey(info);
        if (this.reportedFailures.has(key)) return;
        if (this.reportedFailures.size >= 100) this.reportedFailures.clear();
        this.reportedFailures.add(key);
        console.error(
          `[agent:event] ${info.kind ?? "interceptor"} handler failed for "${info.event}" (scope ${info.scopeId}):`,
          info.error
        );
      });
  }

  get scopeId(): string {
    return this.node.id;
  }

  // --------------------------------------------------------------------------
  // Observer mode
  // --------------------------------------------------------------------------

  on<T extends AgentEventType>(type: T, listener: AgentEventListener<T>, options?: { replay?: boolean }): () => void;
  on(type: "*", listener: AgentEventWildcardListener): () => void;
  on(
    type: AgentEventType | "*",
    listener: AgentEventListener | AgentEventWildcardListener,
    options?: { replay?: boolean; includeParents?: boolean }
  ): () => void {
    if (type === "*") {
      // One wrapper per registration, so the same function subscribed twice stays two entries and
      // each disposer removes only its own.
      const entry = { listener: listener as AgentEventWildcardListener };
      this.node.wildcards.add(entry);
      return () => {
        this.node.wildcards.delete(entry);
      };
    }

    const typed = listener as AgentEventListener;
    const unsub = this.node.observers.on(type, typed);

    // Retained replay: late subscribers synchronously receive the current value.
    // Callers that reconcile retained values themselves opt out via `replay:false`.
    if (options?.replay !== false) {
      const retained = this.findRetained(type, options?.includeParents === true);
      if (retained) {
        // Two independent failure sources, two different owners: a throwing PROVIDER belongs to the
        // node that holds the value (an `includeParents` replay carries a parent's payload), while a
        // throwing LISTENER belongs to this node — `scopeId` is what routes the report to a log.
        let payload: unknown;
        try {
          payload = retained.provider();
        } catch (error) {
          reportContained(() =>
            this.reporter({
              pattern: type,
              event: type,
              scopeId: retained.node.id,
              error,
              kind: "observer",
            })
          );
          return unsub;
        }
        try {
          const event = this.buildEventAt(retained.node, type, payload as never, undefined, false);
          const result = (typed as (value: AgentEvent) => unknown)(event);
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            void Promise.resolve(result).catch((error) =>
              reportContained(() =>
                this.reporter({
                  pattern: type,
                  event: type,
                  scopeId: this.node.id,
                  error,
                  kind: "observer",
                })
              )
            );
          }
        } catch (error) {
          // A retained replay is still a listener notification. Without this guard a throwing
          // handler escaped `on()` AFTER the subscription was registered, so the caller never
          // received a disposer and leaked the listener.
          reportContained(() =>
            this.reporter({
              pattern: type,
              event: type,
              scopeId: this.node.id,
              error,
              kind: "observer",
            })
          );
        }
      }
    }

    return unsub;
  }

  retainedValue<T extends AgentEventType>(
    type: T,
    options?: { includeParents?: boolean }
  ): AgentEvent<T>["payload"] | undefined {
    const retained = this.findRetained(type, options?.includeParents === true);
    if (!retained) return undefined;
    try {
      return retained.provider() as AgentEvent<T>["payload"];
    } catch (error) {
      // Same containment as the `on()` replay: this is a user-facing read, and one faulty provider
      // must not turn `subscribe()` (which reconciles retained values) into a failed subscription.
      reportContained(() =>
        this.reporter({ pattern: type, event: type, scopeId: retained.node.id, error, kind: "observer" })
      );
      return undefined;
    }
  }

  /**
   * Whether this bus has a registered provider for a retained event.
   *
   * `retainedValue` cannot answer that: it returns `undefined` both for "no provider" and for "the
   * provider has no value yet". A `retained: true` channel with no provider is a silent failure
   * (new subscribers simply never get an initial frame), so the session subscriber uses this to say
   * so once instead of skipping in silence.
   */
  hasRetained<T extends AgentEventType>(type: T, options?: { includeParents?: boolean }): boolean {
    return this.findRetained(type, options?.includeParents === true) !== undefined;
  }

  emit<T extends AgentEventType>(type: T, payload: AgentEvent<T>["payload"], meta?: AgentEventMetaInput): void {
    const event = this.buildEvent(type, payload, meta) as AgentEvent;
    // Internal events are withheld from the wildcard fan-out: "internal" means "the caller must not
    // observe this", and wildcard delivery is an observation path, so the exclusion is applied
    // here rather than left to each subscriber's discipline. It also makes wildcard delivery equal
    // to `observeAny` (already "wildcard over the observable set") by construction. Typed observers
    // still receive internal events, so "internal" narrows *how* an event is consumed, never
    // whether it is emitted.
    const deliverToWildcards = !INTERNAL_EXTENSION_EVENTS.has(type);
    for (let node: EventBusScopeNode | null = this.node; node; node = node.parent) {
      // A live observer gets the same containment as a retained replay (see `on()`): one broken
      // subscriber loses its frame, not the notification, and the failure is reported instead of
      // vanishing in `Emitter`'s catch. Silence here was the worst case to debug — a projector or
      // log sink failing on every live frame with no diagnostic at all.
      node.observers.emit(type, event, (error) =>
        reportContained(() => this.reporter({ pattern: type, event: type, scopeId: node.id, error, kind: "observer" }))
      );
      if (!deliverToWildcards) continue;
      for (const { listener } of [...node.wildcards]) {
        try {
          // A wildcard listener typed `void` may still be async (`agentManager.on("*", …)` is a
          // public entry). Its rejection is not caught here, so attach a handler like `Emitter`.
          const result = (listener as (value: AgentEvent) => unknown)(event);
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            void Promise.resolve(result).catch((error) =>
              reportContained(() =>
                this.reporter({ pattern: "*", event: type, scopeId: node.id, error, kind: "observer" })
              )
            );
          }
        } catch (error) {
          reportContained(() =>
            this.reporter({ pattern: "*", event: type, scopeId: node.id, error, kind: "observer" })
          );
        }
      }
    }
  }

  retain<T extends AgentEventType>(type: T, provider: () => AgentEvent<T>["payload"]): () => void {
    const stored = provider as () => unknown;
    const existing = this.node.retained.get(type);
    // "One provider per type" is what makes a retained replay meaningful (one channel, one
    // snapshot owner). `Map.set` used to overwrite silently: a second module retaining the same
    // event left the first provider unreachable and the channel replaying someone else's snapshot,
    // with nothing to notice. Re-registering the SAME provider is silent (still one owner), but note
    // the map is keyed by type: either registration's disposer then drops the type for both.
    if (existing !== undefined && existing !== stored) {
      const key = `${this.node.id}\0${type}`;
      if (!this.reportedRetainedConflicts.has(key)) {
        // Bounded like `reportedFailures`: a long-lived process with many scopes must not grow it.
        if (this.reportedRetainedConflicts.size >= 100) this.reportedRetainedConflicts.clear();
        this.reportedRetainedConflicts.add(key);
        console.warn(
          `[agent:event] retained provider for "${type}" was replaced (scope ${this.node.id}); a channel has one retained owner`
        );
      }
    }
    this.node.retained.set(type, stored);
    return () => {
      // Only clear if this node still owns the same provider.
      if (this.node.retained.get(type) === stored) this.node.retained.delete(type);
    };
  }

  scope(id: string): AgentEventBus {
    // Child scopes share the parent's error sink and metadata resolver: a scoped bus is the same bus
    // with a narrower view, not a separate pipeline.
    return new DefaultAgentEventBus(
      new EventBusScopeNode(id, this.node),
      this.onInterceptorError,
      this.resolveMeta,
      this.interceptorTimeoutMs
    );
  }

  // --------------------------------------------------------------------------
  // Interceptor mode
  // --------------------------------------------------------------------------

  /**
   * Run an interceptable event through the interceptor chain, nearest scope first.
   *
   * **Cancel semantics:** `return false` / `event.skip = true` (and the deprecated
   * `event.skipDefault`) short-circuit the WHOLE chain — this scope's remaining interceptors AND
   * every ancestor scope's — and are normalized into `event.skip`, which is the single field a
   * consumer reads. That is the intended shape for `tool:before` ("already denied, do not ask
   * anyone else"), but it means a subagent-scoped interceptor can suppress a parent-scoped one. A
   * handler that only wants to observe must return `undefined`.
   *
   * **Failure semantics:** a handler that throws (or exceeds the budget) is reported and marked with
   * `event.handlerError`; the chain continues for non-timeout errors so one broken extension cannot
   * fail every call it touches. It is NOT an approval: gates that must fail closed read the flag
   * (see `emitToolBeforeHook`). A timeout additionally sets `skip`, because a half-executed handler
   * may still be running and cannot be asked again.
   *
   * The WHOLE chain is bounded (see `INTERCEPTOR_CHAIN_TIMEOUT_MS`): a hang is reported and the
   * chain stops, so a broken extension cannot freeze the tool call it wraps.
   */
  async intercept<T extends InterceptableEvent>(event: T): Promise<T["defaultReturn"] | undefined> {
    const deadline = Date.now() + this.interceptorTimeoutMs;
    // Attribution for the budget-exhausted report: the handler that consumed it, not the next one
    // (which never ran). Pattern and scope are kept as a PAIR so the report cannot name one
    // agent's pattern on another scope.
    let lastPattern = "*";
    let lastScopeId: string | undefined;
    outer: for (let node: EventBusScopeNode | null = this.node; node; node = node.parent) {
      // Snapshot: `node.interceptors` is mutated by onIntercept()/its disposer, and this loop
      // awaits between entries. Iterating the live array let an interceptor registered during
      // dispatch run twice and one unregistered during dispatch shift indices (skipping a later
      // interceptor, including one that would have cancelled).
      for (const registration of [...node.interceptors]) {
        // The disposer may have run while a previous interceptor was awaiting: the snapshot keeps
        // the entry alive, but it is no longer registered.
        if (!registration.active) continue;
        if (!interceptorMatches(registration.pattern, event.type)) continue;
        lastPattern = registration.pattern;
        lastScopeId = node.id;
        // Isolated like the observer wildcards: a throwing interceptor must not
        // propagate into the tool call it wraps (one broken extension would fail
        // every tool it touches). The observer/transformer/context-provider
        // channels are already isolated — this one is the most-written and was
        // the only one that was not.
        //
        // Bounded as well as contained: `await` alone let a handler that never settles hold the
        // tool call forever (`Esc` aborts the run, not this promise). The budget is per CHAIN, not
        // per handler: N stuck handlers would otherwise cost N x the bound.
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reportContained(() =>
            this.reporter({
              pattern: lastPattern,
              event: event.type,
              scopeId: lastScopeId ?? node.id,
              error: new Error(`interceptor chain exceeded ${this.interceptorTimeoutMs}ms`),
            })
          );
          // Same fail-closed verdict as a per-handler timeout: the chain stopped before later
          // interceptors ran, so a `tool:before` deny that would have been the next handler is not
          // evidence of approval. Without this the tool executed (fail OPEN) while the per-handler
          // timeout path failed closed — two timeout paths, two opposite answers.
          timedOutEvents.add(event);
          const mutable = event as {
            skip?: boolean;
            skipDefault?: boolean;
            handlerError?: boolean;
            modifiedArgs?: unknown;
            modifiedResult?: unknown;
          };
          mutable.modifiedArgs = undefined;
          mutable.modifiedResult = undefined;
          clearPayloadRewrite(event);
          mutable.skip = true;
          mutable.handlerError = true;
          break outer;
        }
        let result: unknown;
        try {
          // `registration.handler(event)` is evaluated EAGERLY: deferring it behind
          // `Promise.resolve().then(...)` put it on a microtask, so a fire-and-forget emitter
          // (`emitSessionShutdown` / `emitSessionBootstrap`) returned before the interceptor ran.
          result = await withCallbackTimeout(
            Promise.resolve(registration.handler(event as InterceptableEvent)),
            `interceptor "${registration.pattern}"`,
            remaining
          );
        } catch (error) {
          reportContained(() =>
            this.reporter({
              pattern: registration.pattern,
              event: event.type,
              scopeId: node.id,
              error,
            })
          );
          // A timed-out handler consumed the remaining budget and CANNOT be trusted to have
          // finished its work: a half-executed interceptor may have written `modifiedArgs` /
          // `modifiedResult` before hanging, and those are read by the caller. Drop the rewrites and
          // fail CLOSED (`skip`) — a handler that could not complete is not evidence of approval.
          if (isCallbackTimeoutError(error)) {
            timedOutEvents.add(event);
            const mutable = event as {
              skip?: boolean;
              skipDefault?: boolean;
              handlerError?: boolean;
              modifiedArgs?: unknown;
              modifiedResult?: unknown;
            };
            mutable.modifiedArgs = undefined;
            mutable.modifiedResult = undefined;
            clearPayloadRewrite(event);
            mutable.skip = true;
            mutable.handlerError = true;
            break outer;
          }
          // Any other throw: the handler that threw produced no verdict. Mark the event so a
          // fail-closed gate can deny, and keep going — one broken extension must not fail every
          // call it touches. A half-written rewrite is equally untrustworthy here (the timeout path
          // clears it for the same reason), so drop it rather than let the caller apply it.
          clearPayloadRewrite(event);
          (event as { handlerError?: boolean }).handlerError = true;
          continue;
        }
        // `cancel` = return false, or set `skip` / the deprecated `skipDefault`; stop the chain and
        // normalize the verdict onto `skip` so consumers read one field.
        if (result === false || (event as { skipDefault?: boolean }).skipDefault) {
          event.skip = true;
          return undefined;
        }
        if (event.skip === true) return undefined;
      }
    }
    return (event as { defaultReturn?: T["defaultReturn"] }).defaultReturn;
  }

  onIntercept<T extends InterceptableEvent>(
    pattern: string,
    handler: EventInterceptor<T>,
    rank?: DispatchRank
  ): () => void {
    const registration = {
      pattern,
      handler: handler as EventInterceptor<InterceptableEvent>,
      // Default when the caller supplies none (a non-extension interceptor): order 0, and a
      // sequence past every explicit one so insertion order is preserved as before.
      rank: rank ?? { order: resolveExtensionOrder(undefined), seq: Number.MAX_SAFE_INTEGER },
      active: true,
    };
    const list = this.node.interceptors;
    list.push(registration);
    // Sorted on mutation, not on dispatch: `intercept` runs on every tool call and must keep
    // walking a plain array. Ties keep insertion order via the rank's sequence tie-break.
    list.sort((a, b) => compareDispatchRank(a.rank, b.rank));
    return () => {
      registration.active = false;
      const index = list.indexOf(registration);
      if (index >= 0) list.splice(index, 1);
    };
  }

  hasInterceptors(name: string): boolean {
    for (let node: EventBusScopeNode | null = this.node; node; node = node.parent) {
      if (node.interceptors.some((registration) => interceptorMatches(registration.pattern, name))) {
        return true;
      }
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private buildEvent<T extends AgentEventType>(
    type: T,
    payload: AgentEvent<T>["payload"],
    meta?: AgentEventMetaInput
  ): AgentEvent<T> {
    return this.buildEventAt(this.node, type, payload, meta);
  }

  /** Build an event in the scope of `node` (its `agentId`/`parentId`, not the caller's). */
  private buildEventAt<T extends AgentEventType>(
    node: EventBusScopeNode,
    type: T,
    payload: AgentEvent<T>["payload"],
    meta?: AgentEventMetaInput,
    /** Retained replay must not inherit the CURRENT run/session of the node it came from. */
    resolveOwnMeta = true
  ): AgentEvent<T> {
    // A scope under another AGENT is a child scope; a scope under the synthetic root node is a root
    // agent (`AgentEventBusScope.of` scopes parent-less agents directly on the root bus). Deriving
    // it here is what makes EVERY emitter carry the parent — including the domain objects that
    // emit straight on the bus (`usage` / `todo` / `ui` / `stream-hub` / `plan`), which used to
    // produce child events with only `agentId`.
    const parentNode = node.parent;
    const parentId = meta?.parentId ?? (parentNode && parentNode.parent !== null ? parentNode.id : undefined);
    const agentId = meta?.agentId ?? node.id;
    // Resolve only what the caller left out: an explicit envelope always wins, and a retained
    // replay is a snapshot of the past (stamping it with the agent's current run would be a lie).
    const resolved =
      resolveOwnMeta && (meta?.runId === undefined || meta?.sessionId === undefined)
        ? this.resolveMeta?.(agentId)
        : undefined;
    const sessionId = meta?.sessionId ?? resolved?.sessionId;
    // `sessionId` and `runId` are one identity: an explicit session that is not the resolved one
    // (a late save for the session a `/resume` just left) must not inherit the CURRENT run. The
    // telemetry funnel already suppresses it; resolving it again here put it back.
    const runId =
      meta?.runId ??
      (meta?.sessionId !== undefined && resolved?.sessionId !== undefined && meta.sessionId !== resolved.sessionId
        ? undefined
        : resolved?.runId);
    return {
      type,
      ts: meta?.ts ?? Date.now(),
      agentId,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(runId !== undefined ? { runId } : {}),
      payload,
    } as AgentEvent<T>;
  }

  /**
   * Nearest retained provider for `type`, with the node that owns it.
   *
   * The owner matters for `includeParents` replay: the event must be stamped with the scope the
   * value came from, not the subscriber's.
   */
  private findRetained(
    type: string,
    includeParents = false
  ): { node: EventBusScopeNode; provider: () => unknown } | undefined {
    for (let node: EventBusScopeNode | null = this.node; node; node = includeParents ? node.parent : null) {
      const provider = node.retained.get(type);
      if (provider) return { node, provider };
    }
    return undefined;
  }
}

/** Create a root event bus (no parent scope). */
export function createAgentEventBus(
  id = "root",
  onInterceptorError?: (info: {
    pattern: string;
    event: string;
    scopeId: string;
    error: unknown;
    kind?: "interceptor" | "observer";
  }) => void,
  options?: {
    resolveMeta?: (agentId: string) => { runId?: string; sessionId?: string } | undefined;
    /** Override the per-chain interceptor budget (tests / a host with a different teardown bound). */
    interceptorTimeoutMs?: number;
  }
): AgentEventBus {
  return new DefaultAgentEventBus(
    new EventBusScopeNode(id, null),
    onInterceptorError,
    options?.resolveMeta,
    options?.interceptorTimeoutMs
  );
}
