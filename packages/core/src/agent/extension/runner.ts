import { getEnv, hasCoreEnv } from "../../env";
// The extension exit-flush registry lives with the other process-exit guards, so a hard exit runs
// it on the same two hooks (fatal handler + `exit`) that already land the active logs.
import { errorMessage, toError } from "../../utils/errors.js";
import { createAgentEventBus } from "../agent-event-bus";
import { registerExtensionExitFlush } from "../agent-log/lifecycle-guards.js";

import { BusExtensionEventBus } from "./bus-extension-event-bus.js";
import { DefaultExtensionUI } from "./default-extension-ui.js";
import { compareDispatchRank, resolveExtensionOrder, sortByDispatchRank } from "./dispatch-order.js";
import { z } from "./extension-zod.js";
import { MessageTransformerRegistry } from "./message-transformer-registry.js";
import { createObserverSurface } from "./observer-surface.js";

import type { DispatchRank } from "./dispatch-order.js";
import type {
  ExtensionInstance,
  ExtensionAPI,
  ExtensionContext,
  ExtensionConfig,
  ExtensionToolDefinition,
  ExtensionCommand,
  InterceptableEvent,
  EventInterceptor,
  ExtensionEventBus,
  ExtensionObserverSurface,
  ExtensionUI,
  BeforeAgentStartEvent,
  ExtensionPromptAppends,
  ExtensionTurnContextSection,
  ExtensionContextProvider,
  ExtensionRegistrations,
  ExtensionInfo,
  ExtensionRenderPayload,
  ExtensionUiContext,
  MessageTransformContext,
  MessageTransformer,
} from "./types.js";
import type { CoreEnv } from "../../env";
import type { AgentEventBus } from "../agent-event-bus";
import type { AgentLog } from "../agent-log/agent-log.js";
import type { LogCategory, LogLevel } from "../agent-log/types.js";
import type { ModelMessage } from "@tanstack/ai";

// ============================================================================
// ExtensionRunner
// ============================================================================

/** Throttle window for coalescing pushed context snapshots (ms). */
const CONTEXT_THROTTLE_MS = 250;

export interface ExtensionRunnerOptions {
  getEnvVar: (key: string) => string | undefined;
  /**
   * Register a tool on the host. `rank` carries the extension's resolved dispatch position so the
   * host's authoritative tool stack can pick the live entry when a name is shadowed.
   */
  onRegisterTool?: (def: ExtensionToolDefinition, ownerId: string, rank: DispatchRank) => void;
  onRegisterCommand?: (cmd: ExtensionCommand) => void;
  /**
   * Drop one extension's registrations for a tool name.
   *
   * Called whether the extension still owns the name or was buried under a newer one: the
   * host removes this owner's entries and re-derives what is live, which is one operation for
   * both cases. The runner does not have to say which situation it is, because it cannot get
   * that distinction wrong if it does not exist.
   */
  onUnregisterTool?: (name: string, ownerId: string) => void;
  /** Unregister a previously registered command (used when disabling an extension). */
  onUnregisterCommand?: (name: string) => void;
  /** Working directory (rootPath) injected into {@link ExtensionContext.cwd}. */
  cwd?: string;
  /**
   * Resolve the runtime CoreEnv to inject into {@link ExtensionContext.coreEnv}.
   * Defaults to the globally registered CoreEnv (`getEnv()`).
   */
  getCoreEnv?: () => CoreEnv;
  /**
   * Scoped unified event bus backing extension interception and telemetry.
   * Extension lifecycle failures (activate / deactivate) are emitted as
   * `agent:extension-error` on it, surfacing in AgentLog / lifecycle channels
   * via the Event→Log bridge instead of being swallowed. Defaults to a
   * standalone bus for hosts that build an {@link ExtensionRunner} without an agent.
   */
  eventBus?: AgentEventBus;
  /**
   * Optional agent log to converge extension logging into. When provided,
   * `ctx.logger` and turn-context provider failures are written as structured
   * `hooks` entries instead of raw console output (console stays as a fallback
   * for standalone runner usage without an agent log).
   */
  log?: AgentLog | null;
  /**
   * Host-supplied overrides for the extension UI context snapshot (model /
   * status / usage / workspace / session name / mode). Omitted fields fall back
   * to retained bus state and the runner's own `cwd`.
   */
  getUiContext?: () => Partial<ExtensionUiContext>;
}

export class ExtensionRunner {
  private extensions: ExtensionInstance[] = [];
  /**
   * Monotonic load sequence, assigned at `loadExtension`. The tie-break within an equal
   * declared `order`, and the reason an undeclared extension keeps the exact sequence it had
   * before `order` existed. Assigned once per extension and restored on re-enable, never
   * re-derived from the loader's discovery order.
   */
  private loadSequence = 0;
  /** Resolved dispatch position per extension id (declared `order` + the load sequence). */
  private readonly ranks = new Map<string, DispatchRank>();
  /**
   * Per name, the extension tools registered with their owner and rank — bookkeeping that mirrors
   * what the host holds. The authoritative tool stack (which entry is live) lives in the host's
   * `ExtensionRegistryService`, which receives the same rank through `onRegisterTool`.
   */
  private toolStacks = new Map<string, Array<{ ownerId: string; def: ExtensionToolDefinition; rank: DispatchRank }>>();
  private commandRegistry = new Map<string, ExtensionCommand>();
  private commandOwners = new Map<string, string>();
  /** Per-extension context injection (extension id → provider and its rank). */
  private contextProviders = new Map<string, { provider: ExtensionContextProvider; rank: DispatchRank }>();
  /**
   * Per-extension model-message transform. The registry owns the map, the chaining order
   * and the ownership copy; the runner only wires lifecycle into it.
   */
  private readonly messageTransformers = new MessageTransformerRegistry({
    reportTransformerFailure: (extensionId, err) => this.reportTransformerFailure(extensionId, err),
  });
  /**
   * Persistent "this extension is disabled" notices keyed by extension id
   * (captured from a provider's `disabledContent` at disable time, since destroy
   * unsubscribes the provider). Cleared when the extension is re-enabled.
   */
  private disabledExtensionNotices = new Map<string, string>();
  private eventBus: BusExtensionEventBus;
  /** Raw scoped bus (interception + telemetry) behind the extension-facing facade. */
  private readonly rawBus: AgentEventBus;
  private ui: DefaultExtensionUI;
  private options: ExtensionRunnerOptions;
  /** Teardown callbacks for context-push subscriptions. */
  private readonly contextUnsubs: Array<() => void> = [];
  private contextTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ExtensionRunnerOptions) {
    this.options = options;
    const bus = options.eventBus ?? createAgentEventBus();
    this.rawBus = bus;
    this.eventBus = new BusExtensionEventBus(bus);
    this.ui = new DefaultExtensionUI(bus, () => this.buildUiContext());
    // Push a fresh context snapshot (throttled) whenever state extensions render
    // from changes, so they never have to poll `getContext()`.
    for (const type of ["agent:state", "session:usage", "session:mode"] as const) {
      this.contextUnsubs.push(bus.on(type, () => this.scheduleContextPush(), { replay: false }));
    }
  }

  getEventBus(): ExtensionEventBus {
    return this.eventBus;
  }

  /**
   * Whether any extension currently holds a message transformer.
   *
   * Fast-path guard for the wire seam: when this is false the caller must take the
   * unchanged (cached) path so an extension-free workspace pays nothing.
   */
  hasMessageTransformers(): boolean {
    return this.messageTransformers.has();
  }

  /**
   * Apply every registered message transformer in extension load order, chaining each
   * result into the next. Returns the messages to send for this call.
   *
   * Failure isolation: a transformer that throws, or returns something that is not a
   * message array, only costs its own contribution — the last valid message set is
   * kept and the remaining transformers still run. A broken extension must never abort
   * a run, so this method does not throw.
   */
  async applyMessageTransformers(ctx: MessageTransformContext): Promise<ModelMessage[]> {
    return this.messageTransformers.apply(ctx);
  }

  private reportTransformerFailure(extensionId: string, err: unknown): void {
    const message = errorMessage(err);
    this.writeExtensionLog("warn", extensionId, `message transformer failed (messages kept as last valid): ${message}`);
    this.rawBus.emit("agent:extension-error", {
      extensionId,
      phase: "message-transform",
      error: message,
    });
  }

  getUI(): ExtensionUI {
    return this.ui;
  }

  /**
   * Retained extension render slots (surface → key → payload). Lets a session
   * replay slots that were rendered before a host subscribed.
   */
  getUISlots(): Readonly<Record<string, Record<string, ExtensionRenderPayload>>> {
    return this.ui.getSlots();
  }

  /**
   * Assemble the context snapshot from retained bus state, overlaid with any
   * host-supplied overrides. Unknown values degrade to `null` / empty rather
   * than throwing — a snapshot is always returned.
   */
  private buildUiContext(): ExtensionUiContext {
    const override = this.options.getUiContext?.();
    const state = this.rawBus.retainedValue("agent:state");
    const usage = this.rawBus.retainedValue("session:usage");
    const mode = this.rawBus.retainedValue("session:mode");

    const modelId = override?.model?.id ?? state?.model ?? "";
    const displayName = override?.model?.displayName ?? state?.modelInfo?.name ?? modelId;

    return {
      model: override?.model ?? (modelId ? { id: modelId, displayName } : null),
      status: override?.status ?? state?.status ?? "unknown",
      usage:
        override?.usage ??
        (usage
          ? {
              percent: usage.percent,
              tokenLimit: usage.tokenLimit,
              windowTokens: usage.contextFillTokens,
              costUsd: usage.cost,
            }
          : null),
      workspace: override?.workspace ?? { root: this.options.cwd ?? "", branch: null },
      sessionName: override?.sessionName ?? null,
      mode: override?.mode ?? mode?.mode ?? null,
    };
  }

  /** Coalesced `context` push so subscribers see changes without polling. */
  private scheduleContextPush(): void {
    if (this.contextTimer) return;
    this.contextTimer = setTimeout(() => {
      this.contextTimer = null;
      try {
        this.ui.emitEvent("context", { context: this.ui.getContext() });
      } catch {
        // Failure contained: context pushes are best-effort.
      }
    }, CONTEXT_THROTTLE_MS);
    (this.contextTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Wrap the shared UI for a single extension so render slots are attributed to
   * that extension (used to clear its slots when it is disabled). Every other
   * member (notify / subscribe / getContext) is shared.
   */
  private wrapUi(ownerId: string): ExtensionUI {
    return {
      notify: (message, level) => this.ui.notify(message, level),
      subscribe: (type, handler) => this.ui.subscribe(type, handler),
      render: (surface, key, payload) => this.ui.render(surface, key, payload, ownerId),
      getContext: () => this.ui.getContext(),
    };
  }

  /**
   * Build the observer half of one extension's event surface (`observe` /
   * `observeAny` / `retained`). See {@link createObserverSurface} for what it adds on top of
   * the bus's observer dispatch mode.
   */
  private createObserverSurface(ownerId: string, registrations?: ExtensionRegistrations): ExtensionObserverSurface {
    return createObserverSurface(
      { bus: this.rawBus, reportFailure: (err) => this.reportObserverFailure(ownerId, err) },
      registrations
    );
  }

  private reportObserverFailure(extensionId: string, err: unknown): void {
    const message = errorMessage(err);
    this.writeExtensionLog("warn", extensionId, `event observer failed: ${message}`);
    this.rawBus.emit("agent:extension-error", {
      extensionId,
      phase: "event-observer",
      error: message,
    });
  }

  /**
   * Emit `session:start` to registered interceptors (per-agent ExtensionEventBus).
   * Distinct from the telemetry `session:start` emitted via the unified bus —
   * this one is interceptable by extensions.
   */
  emitSessionStart(cwd: string, sessionId: string): void {
    // Fire-and-forget interception: interceptor errors must not surface as
    // unhandled rejections or break session bootstrap.
    this.eventBus
      .emit({
        type: "session:start",
        payload: { cwd, sessionId },
        defaultReturn: undefined,
      })
      .catch(() => {});
  }

  /**
   * Emit `session:shutdown` to registered interceptors before teardown.
   *
   * Awaited by the caller (the teardown sequence) because the hook exists so an extension
   * can release resources — kill an LSP daemon, disconnect a client, land buffered writes.
   * Dropping the promise meant `destroyAll()` could unregister the interceptor while its
   * async handler was still running. Rejections are swallowed here: a failing interceptor
   * must not break teardown.
   */
  async emitSessionShutdown(sessionId: string): Promise<void> {
    await this.eventBus
      .emit({
        type: "session:shutdown",
        payload: { sessionId },
        defaultReturn: undefined,
      })
      .catch(() => {});
  }

  /** The extension tools this runner still holds, one per name — a mirror of what the host holds,
   * re-derived from each stack's highest rank (the resolution reading of dispatch order). */
  getTools(): ExtensionToolDefinition[] {
    return Array.from(
      this.toolStacks.values(),
      (stack) => stack.reduce((top, entry) => (compareDispatchRank(entry.rank, top.rank) > 0 ? entry : top)).def
    );
  }

  getCommands(): ExtensionCommand[] {
    return Array.from(this.commandRegistry.values());
  }

  getTool(name: string): ExtensionToolDefinition | undefined {
    const stack = this.toolStacks.get(name);
    if (!stack || stack.length === 0) return undefined;
    return stack.reduce((top, entry) => (compareDispatchRank(entry.rank, top.rank) > 0 ? entry : top)).def;
  }

  /**
   * Emit `before_agent_start` to each interceptor (observable event), then run
   * registered context providers. Returns per-extension turn-context sections.
   */
  async collectBeforeAgentStart(prompt: string, sessionId: string): Promise<ExtensionPromptAppends> {
    // Dispatch through intercept (shared mutable event, ordered, awaited);
    // handlers that append turn context do so on the event without cancelling.
    const event: BeforeAgentStartEvent = {
      type: "before_agent_start",
      payload: { prompt, sessionId },
      defaultReturn: undefined,
    };
    await this.eventBus.emit(event);

    // Each enabled extension with content becomes its own section (kind = id), ordered by
    // declared dispatch order so the section sequence is declarable rather than load-determined.
    const turnContextSections: ExtensionTurnContextSection[] = [];
    const orderedProviders = sortByDispatchRank(Array.from(this.contextProviders, ([id, entry]) => ({ id, ...entry })));
    for (const { id, provider } of orderedProviders) {
      try {
        const value = await provider.content?.();
        if (value?.trim()) turnContextSections.push({ id, content: value.trim() });
      } catch (err) {
        const message = errorMessage(err);
        // Converge into the agent log via the existing `agent:extension-error`
        // rule (error/system) rather than a bare console write; console stays
        // as a fallback for standalone runners without an injected bus.
        if (this.options.eventBus) {
          this.rawBus.emit("agent:extension-error", {
            extensionId: id,
            phase: "turn-context",
            error: message,
          });
        } else {
          this.writeExtensionLog("error", id, `turn context provider failed: ${message}`);
        }
      }
    }
    // Surface runtime-disabled extensions under the same tag so the model knows
    // their tools are gone (symmetric to the enable-side section). A disabled
    // extension's providers were already unsubscribed on destroy, so its id never
    // also appears above.
    for (const [id, notice] of this.disabledExtensionNotices) {
      if (notice?.trim()) turnContextSections.push({ id, content: notice.trim() });
    }

    return { turnContextSections };
  }

  async loadExtension(api: ExtensionAPI, config?: ExtensionConfig): Promise<ExtensionInstance> {
    const registrations: ExtensionRegistrations = {
      tools: [],
      commands: [],
      unsubInterceptors: [],
      unsubObservers: [],
      unsubTurnContext: [],
      messageTransformers: [],
      flush: null,
      exitFlush: null,
      exitFlushRef: null,
    };
    // Assign the load sequence once, at load; re-enable reuses the stored rank so an extension
    // returns to its position instead of moving to the end (see `ranks`).
    if (!this.ranks.has(api.id)) {
      this.ranks.set(api.id, { order: resolveExtensionOrder(api.order), seq: this.loadSequence++ });
    }
    const ctx = this.createContext(api, config, registrations);

    const instance: ExtensionInstance = {
      api,
      context: ctx,
      state: "inactive",
      registrations,
    };

    this.extensions.push(instance);

    try {
      await api.activate(ctx);
      instance.state = "active";
    } catch (err) {
      const error = toError(err);
      // Roll back any artifacts registered before the failure so a later re-enable
      // starts clean (no duplicate registrations).
      this.unregisterInstanceArtifacts(instance);
      instance.state = "error";
      instance.error = error;
      ctx.logger.error(`Failed to activate extension "${api.id}": ${error.message}`);
      this.rawBus.emit("agent:extension-error", {
        extensionId: api.id,
        phase: "activate",
        error: error.message,
      });
    }

    return instance;
  }

  async destroyExtension(instance: ExtensionInstance): Promise<void> {
    // Flush phase first: land anything the extension buffered (behind a timer or debounce) while
    // the resources it writes through are still held. Not folded into `deactivate()` — deactivate
    // *releases* the extension, and a fire-and-forget teardown would drop the last batch. A
    // failing flush is reported and the sequence continues (the extension still gets deactivated).
    await this.flushExtension(instance);
    if (instance.api.deactivate) {
      try {
        await instance.api.deactivate();
      } catch (err) {
        // Do not swallow: surface deactivation failures for observability.
        const error = toError(err);
        this.rawBus.emit("agent:extension-error", {
          extensionId: instance.api.id,
          phase: "deactivate",
          error: error.message,
        });
      }
    }
    this.unregisterInstanceArtifacts(instance);
    // Clear any surface slots this extension rendered so they do not linger
    // after the extension is disabled (e.g. a status line it published into the
    // footer surface).
    this.ui.clearSlotsByOwner(instance.api.id);
    instance.state = "inactive";
  }

  /**
   * Run an extension's registered flush phase, reporting a failure as `agent:extension-error`
   * with phase `flush` rather than letting it skip the remaining teardown phases.
   */
  private async flushExtension(instance: ExtensionInstance): Promise<void> {
    const flush = instance.registrations.flush;
    if (!flush) return;
    try {
      await flush();
    } catch (err) {
      const error = toError(err);
      this.rawBus.emit("agent:extension-error", {
        extensionId: instance.api.id,
        phase: "flush",
        error: error.message,
      });
    }
  }

  async destroyAll(): Promise<void> {
    for (const instance of this.extensions) {
      await this.destroyExtension(instance);
    }
    this.extensions = [];
    this.toolStacks.clear();
    this.commandRegistry.clear();
    this.commandOwners.clear();
    this.contextProviders.clear();
    this.messageTransformers.clearAll();
    this.disabledExtensionNotices.clear();
    this.ui.clearAllSlots();
    if (this.contextTimer) {
      clearTimeout(this.contextTimer);
      this.contextTimer = null;
    }
    for (const unsub of this.contextUnsubs) unsub();
    this.contextUnsubs.length = 0;
  }

  /** Read-only snapshot of loaded extensions for management commands, in **dispatch order**. */
  getExtensionInfos(): ExtensionInfo[] {
    return this.extensions
      .slice()
      .sort((a, b) => compareDispatchRank(this.rankOf(a.api.id), this.rankOf(b.api.id)))
      .map((instance) => ({
        id: instance.api.id,
        name: instance.api.name,
        version: instance.api.version,
        description: instance.api.description,
        enabled: instance.state === "active",
        state: instance.state,
        error: instance.error?.message,
        order: this.rankOf(instance.api.id).order,
        declaredOrder:
          typeof instance.api.order === "number" && Number.isFinite(instance.api.order)
            ? instance.api.order
            : undefined,
        tools: [...instance.registrations.tools],
        // Expose whether each command has a secondary menu (getOptions) so the app
        // can treat pure-display commands (e.g. /lsp, /mcp) without an options menu.
        commands: instance.registrations.commands.map((name) => ({
          name,
          hasOptions: Boolean(this.commandRegistry.get(name)?.getOptions),
          description: this.commandRegistry.get(name)?.description ?? "",
        })),
      }));
  }

  /** The resolved dispatch position for an extension id, defaulting for an unloaded id. */
  private rankOf(id: string): DispatchRank {
    return this.ranks.get(id) ?? { order: resolveExtensionOrder(undefined), seq: Number.MAX_SAFE_INTEGER };
  }

  /**
   * Enable or disable an extension at runtime. Disabling deactivates it and unregisters
   * its tools/commands/interceptors/turn-context providers; enabling re-activates it.
   * Returns a result describing what happened.
   */
  async setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; message: string }> {
    const instance = this.extensions.find((e) => e.api.id === id);
    if (!instance) return { ok: false, message: `Extension "${id}" not loaded` };

    const already = instance.state === "active";
    if (enabled && already) return { ok: true, message: `Extension "${id}" already enabled` };
    if (!enabled && !already) return { ok: true, message: `Extension "${id}" already disabled` };

    if (enabled) {
      try {
        await instance.api.activate(instance.context);
        instance.state = "active";
        instance.error = undefined;
        this.disabledExtensionNotices.delete(instance.api.id);
        return { ok: true, message: `Extension "${id}" enabled` };
      } catch (err) {
        const error = toError(err);
        // Roll back any artifacts registered before the failure.
        this.unregisterInstanceArtifacts(instance);
        instance.state = "error";
        instance.error = error;
        return { ok: false, message: `Failed to enable "${id}": ${error.message}` };
      }
    }

    // Capture the provider's disabledContent BEFORE destroy (destroy unsubscribes
    // it). Undefined/absent falls back to a generic notice so non-customizing
    // extensions stay informative; an empty string explicitly opts out.
    const provider = this.contextProviders.get(instance.api.id)?.provider;
    const custom =
      provider?.disabledContent === undefined ? undefined : ((await provider.disabledContent()) ?? undefined);

    await this.destroyExtension(instance);
    const notice =
      custom === undefined
        ? `Extension "${instance.api.name ?? id}" is disabled — its tools and commands are unavailable.`
        : custom.trim();
    if (notice) this.disabledExtensionNotices.set(instance.api.id, notice);
    else this.disabledExtensionNotices.delete(instance.api.id);
    return { ok: true, message: `Extension "${id}" disabled` };
  }

  /**
   * Unregister all artifacts an extension registered during activate().
   * Tools/commands are removed from the registry and the host; interceptors and
   * turn-context providers are unsubscribed.
   */
  private unregisterInstanceArtifacts(instance: ExtensionInstance): void {
    // No ownership test: a per-runner map cannot tell whose tool was the one taken (two agents
    // loading the same extension share an id), and it does not need to — the host's per-name stack
    // answers "is this still mine?" itself, the same way whether this owner was on top or buried.
    // The mirror goes first because the callback may read `getTools()`.
    for (const name of instance.registrations.tools) {
      const stack = this.toolStacks.get(name);
      if (stack) {
        const remaining = stack.filter((entry) => entry.ownerId !== instance.api.id);
        if (remaining.length === 0) this.toolStacks.delete(name);
        else this.toolStacks.set(name, remaining);
      }
      this.options.onUnregisterTool?.(name, instance.api.id);
    }
    for (const name of instance.registrations.commands) {
      if (this.commandOwners.get(name) !== instance.api.id) continue;
      this.commandOwners.delete(name);
      this.commandRegistry.delete(name);
      this.options.onUnregisterCommand?.(name);
    }
    for (const unsub of instance.registrations.unsubInterceptors) {
      unsub();
    }
    for (const unsub of instance.registrations.unsubObservers) {
      unsub();
    }
    for (const unsub of instance.registrations.unsubTurnContext) {
      unsub();
    }
    // Transformer slot is keyed by owner id, so only clear it when this extension
    // still holds it — a re-registered instance may have replaced the entry.
    for (const id of instance.registrations.messageTransformers) {
      this.messageTransformers.clearExtension(id);
    }
    // Clear in place (`.length = 0`) rather than reassigning: the `createContext`
    // closures reference `registrations` and may read/capture these arrays at call
    // time. Reassigning would silently desync re-enabled registrations from the
    // instance, leaking them on a later disable.
    instance.registrations.tools.length = 0;
    instance.registrations.commands.length = 0;
    instance.registrations.unsubInterceptors.length = 0;
    instance.registrations.unsubObservers.length = 0;
    instance.registrations.unsubTurnContext.length = 0;
    instance.registrations.messageTransformers.length = 0;
    // One flush per extension, and the sync one is registered process-wide too — so releasing it
    // here is what stops a destroyed extension from running on `process.on("exit")`.
    instance.registrations.flush = null;
    instance.registrations.exitFlushRef?.();
    instance.registrations.exitFlushRef = null;
    instance.registrations.exitFlush = null;
  }

  private createContext(
    api: ExtensionAPI,
    config?: ExtensionConfig,
    registrations?: ExtensionRegistrations
  ): ExtensionContext {
    return {
      id: api.id,
      env: this.resolveEnv(api.id, config?.config),
      z,
      cwd: this.options.cwd ?? "",
      coreEnv: this.resolveCoreEnv(),
      registerTool: (def: ExtensionToolDefinition) => {
        const rank = this.rankOf(api.id);
        const stack = this.toolStacks.get(def.name);
        if (!stack) this.toolStacks.set(def.name, [{ ownerId: api.id, def, rank }]);
        else {
          const own = stack.findIndex((entry) => entry.ownerId === api.id);
          if (own === -1) stack.push({ ownerId: api.id, def, rank });
          else stack[own] = { ownerId: api.id, def, rank };
        }
        registrations?.tools.push(def.name);
        // The rank travels with the registration: the authoritative tool stack (which entry is
        // live) lives in the host's registry, which cannot see the extension's own order.
        this.options.onRegisterTool?.(def, api.id, rank);
      },

      registerCommand: (cmd: ExtensionCommand) => {
        this.commandRegistry.set(cmd.name, cmd);
        this.commandOwners.set(cmd.name, api.id);
        registrations?.commands.push(cmd.name);
        this.options.onRegisterCommand?.(cmd);
      },

      registerInterceptor: <T extends InterceptableEvent>(
        eventType: string,
        handler: EventInterceptor<T>
      ): (() => void) => {
        const unsub = this.eventBus.on(eventType, handler, this.rankOf(api.id));
        registrations?.unsubInterceptors.push(unsub);
        return unsub;
      },

      registerContextProvider: (provider: ExtensionContextProvider): (() => void) => {
        this.contextProviders.set(api.id, { provider, rank: this.rankOf(api.id) });
        const unsub = () => {
          if (this.contextProviders.get(api.id)?.provider === provider) this.contextProviders.delete(api.id);
        };
        registrations?.unsubTurnContext.push(unsub);
        return unsub;
      },

      registerFlush: (flush: () => Promise<void> | void): (() => void) => {
        if (!registrations) return () => {};
        registrations.flush = flush;
        // Identity-checked: a stale disposer from a replaced flush must not clear
        // the newer registration (mirrors `registerContextProvider` above).
        return () => {
          if (registrations.flush === flush) registrations.flush = null;
        };
      },

      registerExitFlush: (flush: () => void): (() => void) => {
        if (!registrations) return () => {};
        registrations.exitFlush = flush;
        // Also registered process-wide: an exit with a live session never runs agent teardown,
        // and that is exactly the case where the final batch matters most.
        registrations.exitFlushRef = registerExtensionExitFlush(flush);
        return () => {
          if (registrations.exitFlush === flush) registrations.exitFlush = null;
          registrations.exitFlushRef?.();
          registrations.exitFlushRef = null;
        };
      },

      registerMessageTransformer: (transformer: MessageTransformer): (() => void) => {
        this.messageTransformers.register(api.id, transformer, this.rankOf(api.id));
        if (registrations && !registrations.messageTransformers.includes(api.id)) {
          registrations.messageTransformers.push(api.id);
        }
        // Identity-checked: a stale disposer from a replaced transformer must not
        // clear the newer registration (mirrors `registerContextProvider` above).
        return () => {
          this.messageTransformers.dispose(api.id, transformer);
        };
      },

      events: {
        // Delegate interception to the shared facade and add this extension's
        // observer accessors. Not a spread: `BusExtensionEventBus` keeps its
        // methods on the prototype, so spreading the instance would drop them.
        emit: (event) => this.eventBus.emit(event),
        // The `ctx.events.on` accessor is an interceptor registration equivalent to
        // `ctx.registerInterceptor`, so it must carry the same rank — otherwise an extension
        // ordering itself with `order` would get its declared position through one entry point
        // and the default through the other.
        on: (type, handler) => this.eventBus.on(type, handler, this.rankOf(api.id)),
        off: (type, handler) => this.eventBus.off(type, handler),
        ...this.createObserverSurface(api.id, registrations),
      },
      ui: this.wrapUi(api.id),

      logger: {
        info: (msg: string) => this.writeExtensionLog("info", api.id, msg),
        warn: (msg: string) => this.writeExtensionLog("warn", api.id, msg),
        error: (msg: string) => this.writeExtensionLog("error", api.id, msg),
        log: (level, category, msg) => this.writeExtensionLog(level, api.id, msg, category),
      },
    };
  }

  /**
   * Converge extension logging into the agent log (`hooks` category) when one
   * is wired; fall back to console for standalone runner usage (validation
   * scripts, hosts that build an ExtensionRunner without an agent).
   */
  private writeExtensionLog(level: LogLevel, extensionId: string, msg: string, category: LogCategory = "hooks"): void {
    const message = `[extension:${extensionId}] ${msg}`;
    const log = this.options.log;
    if (log) {
      // `category` is the caller's (defaults to `hooks`, the historical extension category);
      // `level` is passed through whole so `debug` is expressible rather than silently upgraded.
      if (level === "debug") log.debug(category, message);
      else if (level === "error") log.error(category, message);
      else if (level === "warn") log.warn(category, message);
      else log.info(category, message);
      return;
    }
    // No agent log wired (standalone runner): keep the pre-existing console behavior, which
    // prints debug/info through `log` and never emits to stderr for a non-warning.
    if (level === "error") console.error(message);
    else if (level === "warn") console.warn(message);
    else console.log(message);
  }

  private resolveCoreEnv(): CoreEnv {
    // Prefer the explicitly injected provider; else the globally registered CoreEnv if present;
    // else a minimal non-throwing stub so extension construction never fails in hosts that
    // build an ExtensionRunner standalone (e.g. validation scripts).
    if (this.options.getCoreEnv) return this.options.getCoreEnv();
    if (hasCoreEnv()) return getEnv();
    return {
      rootPath: this.options.cwd ?? "",
      getPlatform: async () => "unknown",
      getArch: async () => "unknown",
      getEnv: async () => ({}),
      homedir: async () => "",
      fs: {
        readFile: async () => {
          throw new Error("CoreEnv not registered");
        },
        stat: async () => {
          throw new Error("CoreEnv not registered");
        },
        readdir: async () => {
          throw new Error("CoreEnv not registered");
        },
        writeFile: async () => {
          throw new Error("CoreEnv not registered");
        },
        mkdir: async () => {
          throw new Error("CoreEnv not registered");
        },
        exists: async () => {
          throw new Error("CoreEnv not registered");
        },
        remove: async () => {
          throw new Error("CoreEnv not registered");
        },
      },
      runCommand: async () => {
        throw new Error("CoreEnv not registered");
      },
      exec: async () => {
        throw new Error("CoreEnv not registered");
      },
      fetch: async () => {
        throw new Error("CoreEnv not registered");
      },
    };
  }

  private resolveEnv(apiId: string, extConfig?: Record<string, unknown>): Record<string, string> {
    const env: Record<string, string> = {};

    if (extConfig) {
      for (const [key, value] of Object.entries(extConfig)) {
        if (typeof value === "string") {
          env[key] = value;
        }
      }
    }

    const apiKey = this.options.getEnvVar(`${apiId.toUpperCase()}_API_KEY`);
    if (apiKey) {
      env["API_KEY"] = apiKey;
    }

    return env;
  }
}
