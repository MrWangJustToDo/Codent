/* eslint-disable max-lines -- the extension runner co-locates activation, dispatch ordering, registration rollback, and context construction; splitting it would duplicate the shared registration lifecycle. */
import { getEnv, hasCoreEnv } from "../../env";
// The extension exit-flush registry lives with the other process-exit guards, so a hard exit runs
// it on the same two hooks (fatal handler + `exit`) that already land the active logs.
import { errorMessage, toError } from "../../utils/errors.js";
import { createAgentEventBus } from "../agent-event-bus";
import { registerExtensionExitFlush } from "../agent-log/lifecycle-guards.js";

import { BusExtensionEventBus } from "./bus-extension-event-bus.js";
import { DefaultExtensionUI } from "./default-extension-ui.js";
import { compareDispatchRank, resolveExtensionOrder, sortByDispatchRank } from "./dispatch-order.js";
import { ExtensionLlmError } from "./extension-llm-error.js";
import { z } from "./extension-zod.js";
import { MessageTransformerRegistry } from "./message-transformer-registry.js";
import { createObserverSurface } from "./observer-surface.js";

import type { DispatchRank } from "./dispatch-order.js";
import type {
  ExtensionInstance,
  ExtensionRuntimeAccess,
  ExtensionLlm,
  ExtensionLlmRequest,
  ExtensionLlmResult,
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
  ExtensionContextSectionProvider,
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
import type { ToModelOutputDecorator } from "../tools/runtime/contract.js";
import type { ModelMessage } from "@tanstack/ai";

// ============================================================================
// ExtensionRunner
// ============================================================================

/** Throttle window for coalescing pushed context snapshots (ms). */
const CONTEXT_THROTTLE_MS = 250;

/**
 * Allowed section names: a slug. The name becomes part of the `<ctx kind="id:name">` shell, and the
 * kind is recovered from message text by splitting on whitespace, so anything outside this set (a
 * space, a quote, `>`) corrupts the envelope and breaks per-kind admission.
 */
const SECTION_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;

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
  /** Register an agent-scoped model-output decorator. */
  onRegisterToolOutputDecorator?: (
    toolName: string,
    decorator: ToModelOutputDecorator,
    ownerId: string
  ) => (() => void) | void;
  /** Fallback cleanup for a host whose registration callback returns no disposer. */
  onRemoveToolOutputDecoratorOwner?: (ownerId: string) => void;
  /** Called once after an extension activation finishes registering its tools. */
  onToolRegistrationBatchComplete?: () => void;
  /** Called after a tool registered outside activation (runtime registration). */
  onToolRegistrationComplete?: () => void;
  cwd?: string;
  agentId?: string;
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
  /**
   * Live access to the agent runtime backing this runner: session id, run signal, messages, context
   * fill, system prompt and one-shot model completions.
   *
   * A function (not a value) because the facts are per run and per session. Omitted by standalone
   * runners (validation scripts, hosts building a runner without an agent): the context then reports
   * idle/empty facts and `ctx.llm` rejects with a typed error.
   */
  getRuntime?: () => ExtensionRuntimeAccess | undefined;
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
  /** Extension ids currently inside activate(); runtime registrations publish immediately. */
  private readonly activating = new Set<string>();
  private commandRegistry = new Map<string, ExtensionCommand>();
  private commandOwners = new Map<string, string>();
  /** Per-extension context injection (extension id → provider and its rank). */
  private contextProviders = new Map<string, { provider: ExtensionContextProvider; rank: DispatchRank }>();
  /** Live context per active extension — the object handed to every handler of that extension. */
  private contexts = new Map<string, ExtensionContext>();
  /** Providers already warned about a bad/duplicate section name (one row, not one per turn). */
  private warnedSectionProviders = new WeakSet<object>();
  /**
   * Wrapped interceptor per (handler, extension). `ctx.events.off(handler)` must unregister the
   * wrapper that was actually registered, not the caller's original function.
   */
  private interceptorWrappers = new WeakMap<object, Map<string, EventInterceptor<InterceptableEvent>>>();
  /**
   * Per-extension model-message transform. The registry owns the map, the chaining order
   * and the ownership copy; the runner only wires lifecycle into it.
   */
  private readonly messageTransformers = new MessageTransformerRegistry({
    reportTransformerFailure: (extensionId, err) => this.reportTransformerFailure(extensionId, err),
    getContext: (extensionId) => this.contexts.get(extensionId),
  });
  /**
   * Persistent "this extension is disabled" notices keyed by extension id
   * (captured from a provider's `disabledContent` at disable time, since destroy
   * unsubscribes the provider). Cleared when the extension is re-enabled.
   */
  private disabledExtensionNotices = new Map<string, string>();
  /** Disabled notices for named sections, keyed by the section kind, stamped with its owner. */
  private disabledSectionNotices = new Map<string, { extensionId: string; content: string }>();
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
        this.ui.emitEvent({ type: "context", context: this.ui.getContext() });
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
      {
        bus: this.rawBus,
        reportFailure: (err) => this.reportObserverFailure(ownerId, err),
        // Looked up per dispatch: the context is registered right after construction and reads live.
        getContext: () => this.contexts.get(ownerId),
      },
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
      const ctx = this.contexts.get(id);
      try {
        const value = await provider.content?.(ctx);
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

      // Named sections: each is its own `<ctx kind="<id>:<name>">` block, so a change in one never
      // re-injects another. A failing producer is contained to its own section.
      //
      // Duplicate names keep the LAST registration (matching how a replaced provider behaves) and are
      // reported once, rather than emitting two blocks under the same kind — admission is keyed by
      // kind, so two producers would fight over one slot and re-inject each other every turn.
      const byName = new Map<string, ExtensionContextSectionProvider>();
      for (const section of provider.sections ?? []) {
        // The name is interpolated into the `<ctx kind="id:name">` shell, whose identity recovery
        // splits on whitespace — so an unconstrained name silently breaks independent admission.
        if (!SECTION_NAME_RE.test(section.name)) {
          this.warnSectionOnce(provider, id, `invalid context section name "${section.name}" — skipped`);
          continue;
        }
        if (byName.has(section.name)) {
          this.warnSectionOnce(provider, id, `duplicate context section "${section.name}" — the last one wins`);
        }
        byName.set(section.name, section);
      }
      for (const [name, section] of byName) {
        try {
          const body = await section.content?.(ctx);
          if (body?.trim()) turnContextSections.push({ id: this.sectionKind(id, name), content: body.trim() });
        } catch (err) {
          const message = errorMessage(err);
          this.options.eventBus?.emit("agent:extension-error", {
            extensionId: id,
            phase: "turn-context",
            error: `section "${name}": ${message}`,
          });
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
    for (const [id, notice] of this.disabledSectionNotices) {
      if (notice.content.trim()) turnContextSections.push({ id, content: notice.content.trim() });
    }

    return { turnContextSections };
  }

  async loadExtension(api: ExtensionAPI, config?: ExtensionConfig): Promise<ExtensionInstance> {
    // The loader dedupes discovered FILES by basename, but a module declares the id. Two files
    // can therefore yield the same id; without this replacement the second instance is active but
    // `setEnabled(id, false)` always targets the first one, leaving a permanently "on" copy.
    const duplicate = this.extensions.find((entry) => entry.api.id === api.id);
    if (duplicate) {
      await this.destroyExtension(duplicate);
      this.extensions = this.extensions.filter((entry) => entry !== duplicate);
      this.ranks.delete(api.id);
      this.disabledExtensionNotices.delete(api.id);
      this.clearSectionNotices(api.id);
    }

    const registrations: ExtensionRegistrations = {
      tools: [],
      commands: [],
      unsubInterceptors: [],
      unsubObservers: [],
      unsubTurnContext: [],
      toolOutputDecoratorDisposers: [],
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
    this.contexts.set(api.id, ctx);

    const instance: ExtensionInstance = {
      api,
      context: ctx,
      state: "inactive",
      registrations,
    };

    this.extensions.push(instance);
    this.activating.add(api.id);

    try {
      await api.activate(ctx);
      instance.state = "active";
      this.options.onToolRegistrationBatchComplete?.();
    } catch (err) {
      const error = toError(err);
      // Release anything acquired before the throw (MCP clients, LSP servers). Artifact rollback
      // alone leaves those live and a retry stacks a second copy on top of them.
      await this.deactivateExtension(instance);
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
    } finally {
      this.activating.delete(api.id);
    }

    return instance;
  }

  async destroyExtension(instance: ExtensionInstance): Promise<void> {
    // Flush phase first: land anything the extension buffered (behind a timer or debounce) while
    // the resources it writes through are still held. Not folded into `deactivate()` — deactivate
    // *releases* the extension, and a fire-and-forget teardown would drop the last batch. A
    // failing flush is reported and the sequence continues (the extension still gets deactivated).
    await this.flushExtension(instance);
    await this.deactivateExtension(instance);
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
      await flush(this.contexts.get(instance.api.id));
    } catch (err) {
      const error = toError(err);
      this.rawBus.emit("agent:extension-error", {
        extensionId: instance.api.id,
        phase: "flush",
        error: error.message,
      });
    }
  }

  /**
   * Release an extension's resources. Runs before artifact rollback/unregistration so a
   * `deactivate()` can still use the registrations it owns, and is safe after a failed
   * `activate()` — the extension contract makes teardown idempotent.
   */
  private async deactivateExtension(instance: ExtensionInstance): Promise<void> {
    if (!instance.api.deactivate) return;
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
    this.disabledSectionNotices.clear();
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
    if (!enabled && instance.state === "inactive") return { ok: true, message: `Extension "${id}" already disabled` };

    if (enabled) {
      this.activating.add(instance.api.id);
      // `unregisterInstanceArtifacts` drops the context on disable; re-activation must put the same
      // object back, or every per-dispatch lookup (tools, commands, sections, observers, interceptors)
      // silently receives `undefined` for the rest of the session.
      this.contexts.set(instance.api.id, instance.context);
      try {
        await instance.api.activate(instance.context);
        instance.state = "active";
        instance.error = undefined;
        this.disabledExtensionNotices.delete(instance.api.id);
        this.clearSectionNotices(instance.api.id);
        this.options.onToolRegistrationBatchComplete?.();
        return { ok: true, message: `Extension "${id}" enabled` };
      } catch (err) {
        const error = toError(err);
        // A retry of an errored instance must release whatever the failed attempt acquired
        // before rolling back its registrations; otherwise each retry stacks another copy.
        await this.deactivateExtension(instance);
        // Roll back any artifacts registered before the failure.
        this.unregisterInstanceArtifacts(instance);
        instance.state = "error";
        instance.error = error;
        return { ok: false, message: `Failed to enable "${id}": ${error.message}` };
      } finally {
        this.activating.delete(instance.api.id);
      }
    }

    // Capture the provider's disabledContent BEFORE destroy (destroy unsubscribes
    // it). Undefined/absent falls back to a generic notice so non-customizing
    // extensions stay informative; an empty string explicitly opts out.
    const provider = this.contextProviders.get(instance.api.id)?.provider;
    const ctxForDisable = this.contexts.get(instance.api.id);
    const custom =
      provider?.disabledContent === undefined
        ? undefined
        : ((await provider.disabledContent(ctxForDisable)) ?? undefined);
    const sectionNotices: Array<[string, string]> = [];
    for (const section of provider?.sections ?? []) {
      const body =
        section.disabledContent === undefined
          ? undefined
          : ((await section.disabledContent(ctxForDisable)) ?? undefined);
      if (body?.trim()) sectionNotices.push([`${instance.api.id}:${section.name}`, body.trim()]);
    }

    await this.destroyExtension(instance);
    const notice =
      custom === undefined
        ? `Extension "${instance.api.name ?? id}" is disabled — its tools and commands are unavailable.`
        : custom.trim();
    if (notice) this.disabledExtensionNotices.set(instance.api.id, notice);
    else this.disabledExtensionNotices.delete(instance.api.id);
    for (const [key, body] of sectionNotices) {
      this.disabledSectionNotices.set(key, { extensionId: instance.api.id, content: body });
    }
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
    for (const dispose of [...instance.registrations.toolOutputDecoratorDisposers]) {
      dispose();
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
    instance.registrations.toolOutputDecoratorDisposers.length = 0;
    instance.registrations.messageTransformers.length = 0;
    // One flush per extension, and the sync one is registered process-wide too — so releasing it
    // here is what stops a destroyed extension from running on `process.on("exit")`.
    instance.registrations.flush = null;
    instance.registrations.exitFlushRef?.();
    instance.registrations.exitFlushRef = null;
    this.contexts.delete(instance.api.id);
    instance.registrations.exitFlush = null;
  }

  /** One warning per provider, not one per turn (a duplicate name would otherwise log every turn). */
  private warnSectionOnce(provider: object, extensionId: string, message: string): void {
    if (this.warnedSectionProviders.has(provider)) return;
    this.warnedSectionProviders.add(provider);
    this.writeExtensionLog("warn", extensionId, message);
  }

  /** Drop every disabled notice belonging to one extension's named sections. */
  private clearSectionNotices(extensionId: string): void {
    for (const [key, entry] of this.disabledSectionNotices) {
      if (entry.extensionId === extensionId) this.disabledSectionNotices.delete(key);
    }
  }

  /** The context kind of one named section: `<extensionId>:<sectionName>`. */
  private sectionKind(extensionId: string, name: string): string {
    return `${extensionId}:${name}`;
  }

  /** The live context of an active extension, for dispatch sites outside the runner. */
  contextFor(extensionId: string): ExtensionContext | undefined {
    return this.contexts.get(extensionId);
  }

  /** The live context that owns a registered command (commands are dispatched by the session). */
  contextForCommand(name: string): ExtensionContext | undefined {
    const owner = this.commandOwners.get(name);
    return owner ? this.contexts.get(owner) : undefined;
  }

  /**
   * Wrap an interceptor so it receives the extension's live context as its second argument.
   * Memoized per handler+extension: `events.on` / `events.off` must agree on the identity.
   */
  private wrapInterceptor(
    extensionId: string,
    handler: EventInterceptor<InterceptableEvent>
  ): EventInterceptor<InterceptableEvent> {
    let byExtension = this.interceptorWrappers.get(handler);
    if (!byExtension) {
      byExtension = new Map();
      this.interceptorWrappers.set(handler, byExtension);
    }
    const existing = byExtension.get(extensionId);
    if (existing) return existing;
    const wrapped: EventInterceptor<InterceptableEvent> = (event) => handler(event, this.contexts.get(extensionId));
    byExtension.set(extensionId, wrapped);
    return wrapped;
  }

  private async completeViaRuntime(extensionId: string, request: ExtensionLlmRequest): Promise<ExtensionLlmResult> {
    const runtime = this.options.getRuntime?.();
    if (!runtime) {
      throw new ExtensionLlmError(
        "no-adapter",
        `Extension "${extensionId}" cannot call a model: this extension host has no agent runtime attached.`
      );
    }
    return runtime.complete(extensionId, request);
  }

  private createContext(
    api: ExtensionAPI,
    config?: ExtensionConfig,
    registrations?: ExtensionRegistrations
  ): ExtensionContext {
    const runtime = () => this.options.getRuntime?.();

    return {
      id: api.id,
      agentId: this.options.agentId ?? "standalone",
      env: this.resolveEnv(api.id, config?.config),
      z,
      cwd: this.options.cwd ?? "",
      coreEnv: this.resolveCoreEnv(),

      // Live facts: read through the runtime on every access, never captured. A handler that runs
      // after a session switch must see the new session, not the activation-time one.
      get sessionId() {
        return runtime()?.sessionId() ?? null;
      },
      isIdle: () => runtime()?.isIdle() ?? true,
      get mode() {
        return runtime()?.mode() ?? "normal";
      },
      get model() {
        return runtime()?.model();
      },
      get signal() {
        return runtime()?.signal();
      },
      getContextUsage: () => runtime()?.contextUsage(),
      getSystemPrompt: () => runtime()?.systemPrompt() ?? "",
      getMessages: () => runtime()?.messages() ?? [],
      // Overloads cannot be expressed by an object literal, so the single runtime entry point is
      // cast to the public shape; the implementation narrows on presence of `schema`.
      llm: {
        complete: (request: ExtensionLlmRequest) => this.completeViaRuntime(api.id, request),
      } as ExtensionLlm,
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
        // Activation publishes one catalog after ALL tools are in. A runtime registration has no
        // such batch boundary, so publish immediately after it lands.
        if (!this.activating.has(api.id)) this.options.onToolRegistrationComplete?.();
      },

      registerToolOutputDecorator: (toolName, decorator) => {
        const ownerId = `${this.options.agentId ?? "standalone"}:${api.id}`;
        const disposeOwned =
          this.options.onRegisterToolOutputDecorator?.(toolName, decorator, ownerId) ??
          (() => this.options.onRemoveToolOutputDecoratorOwner?.(ownerId));
        let active = true;
        const dispose = () => {
          if (!active) return;
          active = false;
          const index = registrations?.toolOutputDecoratorDisposers.indexOf(dispose) ?? -1;
          if (index >= 0) registrations!.toolOutputDecoratorDisposers.splice(index, 1);
          disposeOwned();
        };
        registrations?.toolOutputDecoratorDisposers.push(dispose);
        return dispose;
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
        // The context is looked up at dispatch time: it is registered on the runner right after
        // construction, and activation (where handlers are declared) happens after that.
        const unsub = this.eventBus.on(
          eventType,
          this.wrapInterceptor(api.id, handler as EventInterceptor<InterceptableEvent>) as EventInterceptor<T>,
          this.rankOf(api.id)
        );
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

      registerFlush: (flush: (ctx?: ExtensionContext) => Promise<void> | void): (() => void) => {
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
        on: (type, handler) => {
          const unsub = this.eventBus.on(
            type,
            this.wrapInterceptor(api.id, handler as EventInterceptor<InterceptableEvent>) as typeof handler,
            this.rankOf(api.id)
          );
          // Same bookkeeping as `registerInterceptor`: without it, an interceptor registered through
          // this entry point kept firing (and cancelling tools) after the extension was disabled.
          registrations?.unsubInterceptors.push(unsub);
          return unsub;
        },
        off: (type, handler) =>
          this.eventBus.off(
            type,
            this.wrapInterceptor(api.id, handler as EventInterceptor<InterceptableEvent>) as typeof handler
          ),
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
