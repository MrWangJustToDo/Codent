/* eslint-disable max-lines -- lifecycle engine: load/activate/toggle/destroy, instance state and the host notifications that follow from them. The three self-contained surfaces are separate modules now — `context-factory.ts` (the `ctx` an extension registers through, including the registration lease), `registration-stacks.ts` (per-name tool/command ownership) and `turn-context.ts` (per-turn sections, providers and disabled notices) — so what remains here is the state machine that sequences them. */
import { getEnv, hasCoreEnv } from "../../env";
// The extension exit-flush registry lives with the other process-exit guards, so a hard exit runs
// it on the same two hooks (fatal handler + `exit`) that already land the active logs.
import { errorMessage, toError } from "../../utils/errors.js";
import { createAgentEventBus } from "../agent-event-bus";
import { compareDispatchRank, resolveExtensionOrder } from "../dispatch-order.js";

import { BusExtensionEventBus } from "./bus-extension-event-bus.js";
import { createExtensionContext, type ContextFactoryHost } from "./context-factory.js";
import { ExtensionLlmError } from "./extension-llm-error.js";
import { createExtensionUiBridge } from "./extension-ui-bridge.js";
import { MessageTransformerRegistry } from "./message-transformer-registry.js";
import { createObserverSurface } from "./observer-surface.js";
import { scopeExtensionOwnerId } from "./owner-id.js";
import { ExtensionRegistrationStacks } from "./registration-stacks.js";
import { ExtensionTurnContext } from "./turn-context.js";

import type { DispatchRank } from "../dispatch-order.js";
import type { ExtensionUiBridge } from "./extension-ui-bridge.js";
import type {
  ExtensionInstance,
  ExtensionRuntimeAccess,
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
  ExtensionPromptAppends,
  ExtensionRegistrations,
  ExtensionInfo,
  ExtensionRenderPayload,
  ExtensionUiContext,
  MessageTransformContext,
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

/**
 * Allowed identifiers — extension ids and section names alike.
 *
 * Both become part of the `<ctx kind="…">` shell, and the kind is recovered from message text by
 * splitting on whitespace, so anything outside this set (a space, a quote, `>`) corrupts the
 * envelope and breaks per-kind admission.
 */

/**
 * Extension ids additionally allow `/` — `author/name` is a common namespacing convention, and a
 * slash is safe inside a `<ctx kind>` tag (recovery splits on whitespace, not punctuation).
 */
const EXTENSION_ID_RE = /^[A-Za-z][A-Za-z0-9._/-]*$/;

/** Reserved namespace for extension-authored turn-context kinds (see {@link ExtensionRunner.sectionKind}). */

export interface ExtensionRunnerOptions {
  /**
   * Register a tool on the host. `rank` carries the extension's resolved dispatch position so the
   * host's authoritative tool stack can pick the live entry when a name is shadowed.
   */
  onRegisterTool?: (def: ExtensionToolDefinition, ownerId: string, rank: DispatchRank) => void;
  /**
   * Drop one extension's registrations for a tool name.
   *
   * Called whether the extension still owns the name or was buried under a newer one: the
   * host removes this owner's entries and re-derives what is live, which is one operation for
   * both cases. The runner does not have to say which situation it is, because it cannot get
   * that distinction wrong if it does not exist.
   */
  onUnregisterTool?: (name: string, ownerId: string) => void;
  /**
   * Observe the command that is now **live** for its name: called on a registration that wins, and
   * again on a survivor when the extension that shadowed it is disabled. Nothing in core needs it
   * (dispatch reads `getCommands()`); it exists for a host that mirrors commands into its own menu.
   */
  onRegisterCommand?: (cmd: ExtensionCommand) => void;
  /** The last live owner of a command name was disabled, so the name is gone. */
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
  /** Extension ids with an in-flight `setEnabled` call (a toggle is not re-entrant). */
  private readonly pendingToggles = new Set<string>();
  /**
   * Per-name tool/command registrations, with owner and rank.
   *
   * Resolution is one rule: the highest dispatch rank owns the name, so disabling an owner restores
   * whatever the name meant before it (an earlier extension's entry) instead of deleting it. The
   * stacks are pure bookkeeping — this runner owns the host notifications; see
   * {@link ExtensionRegistrationStacks}.
   */
  private readonly stacks = new ExtensionRegistrationStacks();
  /** Extension ids currently inside activate(); runtime registrations publish immediately. */
  private readonly activating = new Set<string>();
  /**
   * Extensions already warned about a registration attempted after being disabled.
   *
   * One row per revoke: a leaked timer that registers on every tick would otherwise fill the log
   * with the same sentence. Cleared when the extension is activated again.
   */
  private readonly refusedRegistrations = new Set<string>();
  /** Live context per active extension — the object handed to every handler of that extension. */
  private contexts = new Map<string, ExtensionContext>();
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
  private eventBus: BusExtensionEventBus;
  /** Raw scoped bus (interception + telemetry) behind the extension-facing facade. */
  private readonly rawBus: AgentEventBus;
  /** Per-extension view of the shared UI plus the context snapshot (see `extension-ui-bridge.ts`). */
  private readonly uiBridge: ExtensionUiBridge;
  private options: ExtensionRunnerOptions;
  /**
   * Operations the context factory builds an extension's `ctx` from.
   *
   * A narrow interface instead of passing `this`: the factory (a separate module) can then be read
   * as "the surface an extension author sees", and the runner stays the lifecycle engine. Built once
   * — every member reads live state (`rankOf`, `isLive`, the stacks), so activation-time capture
   * would be wrong.
   */
  private readonly contextHost: ContextFactoryHost;
  /** Per-turn extension context sections, their providers and the disabled notices. */
  private readonly turnContextSections: ExtensionTurnContext;

  constructor(options: ExtensionRunnerOptions) {
    this.options = options;
    const bus = options.eventBus ?? createAgentEventBus();
    this.rawBus = bus;
    this.eventBus = new BusExtensionEventBus(bus);
    this.uiBridge = createExtensionUiBridge({
      bus,
      ...(options.getUiContext ? { getUiContext: options.getUiContext } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      getSessionName: () => options.getRuntime?.()?.sessionName() ?? null,
      reportFailure: (extensionId, err, source) => this.reportObserverFailure(extensionId, err, source),
    });

    this.turnContextSections = new ExtensionTurnContext({
      getSessionId: () => this.options.getRuntime?.()?.sessionId() ?? null,
      getContext: (extensionId) => this.contexts.get(extensionId),
      emitBeforeAgentStart: async (event) => {
        // Awaited, not fired-and-forgotten: a handler that warms an index or reads the transcript
        // must finish before the first model call. Rejections are contained by the bus.
        await this.eventBus.emit(event);
      },
      reportFailure: (extensionId, phase, error) =>
        this.rawBus.emit("agent:extension-error", { extensionId, phase, error }),
      log: (level, extensionId, message) => this.writeExtensionLog(level, extensionId, message),
    });

    this.contextHost = {
      agentId: options.agentId ?? "standalone",
      cwd: options.cwd ?? "",
      getRuntime: () => this.options.getRuntime?.(),
      getCoreEnv: () => this.resolveCoreEnv(),
      extensionEnv: (config) => this.extensionEnv(config),
      completeLlm: (extensionId, request) => this.completeViaRuntime(extensionId, request),
      log: (level, extensionId, message, category) => this.writeExtensionLog(level, extensionId, message, category),

      isLive: (context) => this.isContextLive(context),
      refuse: (extensionId, operation) => this.refuseRegistration(extensionId, operation),

      rankOf: (extensionId) => this.rankOf(extensionId),
      registerTool: (extensionId, def, rank) => {
        this.stacks.registerTool(extensionId, def, rank);
        // The rank travels with the registration: the authoritative tool stack (which entry is
        // live) lives in the host's registry, which cannot see the extension's own order.
        this.options.onRegisterTool?.(def, extensionId, rank);
        // Activation publishes one catalog after ALL tools are in. A runtime registration has no
        // such batch boundary, so publish immediately after it lands.
        if (!this.activating.has(extensionId)) this.options.onToolRegistrationComplete?.();
      },
      registerToolOutputDecorator: (extensionId, toolName, decorator) => {
        const ownerId = scopeExtensionOwnerId(this.options.agentId ?? "standalone", extensionId);
        return (
          this.options.onRegisterToolOutputDecorator?.(toolName, decorator, ownerId) ??
          (() => this.options.onRemoveToolOutputDecoratorOwner?.(ownerId))
        );
      },
      registerCommand: (extensionId, cmd, rank) => {
        const displaced = this.stacks.registerCommand(extensionId, cmd, rank);
        if (displaced) {
          this.writeExtensionLog(
            "warn",
            extensionId,
            `Command "/${cmd.name}" is already registered by "${displaced}" — dispatch order decides which runs`
          );
        }
        // Notified only when this registration is the live one: a host observer maintaining a map
        // of commands must end up with what dispatch would run, not with every claim ever made.
        if (this.stacks.commandOwner(cmd.name) === extensionId) this.options.onRegisterCommand?.(cmd);
      },
      registerInterceptor: (extensionId, eventType, handler, rank) =>
        this.eventBus.on(
          eventType,
          this.wrapInterceptor(extensionId, eventType, handler as EventInterceptor<InterceptableEvent>),
          rank
        ),
      offInterceptor: (extensionId, eventType, handler) => {
        this.eventBus.off(
          eventType,
          this.wrapInterceptor(extensionId, eventType, handler as EventInterceptor<InterceptableEvent>)
        );
      },
      registerContextProvider: (extensionId, provider, rank) =>
        this.turnContextSections.register(extensionId, provider, rank),
      registerMessageTransformer: (extensionId, transformer, rank) => {
        this.messageTransformers.register(extensionId, transformer, rank);
      },
      disposeMessageTransformer: (extensionId, transformer) => {
        this.messageTransformers.dispose(extensionId, transformer);
      },
      eventBus: {
        emit: (event) => this.eventBus.emit(event),
        hasInterceptors: (type) => this.eventBus.hasInterceptors(type),
      },
      observerSurface: (extensionId, registrations, getContext) =>
        this.createObserverSurface(extensionId, registrations, getContext),
      ui: (extensionId, registrations, getContext) => this.wrapUi(extensionId, registrations, getContext),
    };
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
    // The event's log rule writes the row; a direct `writeExtensionLog` here made every failure two
    // rows with the same text.
    this.rawBus.emit("agent:extension-error", {
      extensionId,
      phase: "message-transform",
      error: message,
    });
  }

  getUI(): ExtensionUI {
    return this.uiBridge.ui;
  }

  /**
   * Retained extension render slots (surface → key → payload). Lets a session
   * replay slots that were rendered before a host subscribed.
   */
  getUISlots(): Readonly<Record<string, Record<string, ExtensionRenderPayload>>> {
    return this.uiBridge.getSlots();
  }

  /**
   * Wrap the shared UI for a single extension so render slots are attributed to
   * that extension (used to clear its slots when it is disabled). Every other
   * member (notify / subscribe / getContext) is shared.
   */
  private wrapUi(
    ownerId: string,
    registrations?: ExtensionRegistrations,
    getContext?: () => ExtensionContext
  ): ExtensionUI {
    return this.uiBridge.wrap(ownerId, registrations, getContext ? () => this.isContextLive(getContext()) : undefined);
  }

  /**
   * Build the observer half of one extension's event surface (`observe` /
   * `observeAny` / `retained`). See {@link createObserverSurface} for what it adds on top of
   * the bus's observer dispatch mode.
   *
   * `getContext` is a thunk because the context object is still being constructed when this is
   * called (the surface is a field of that same literal).
   */
  private createObserverSurface(
    ownerId: string,
    registrations?: ExtensionRegistrations,
    getContext?: () => ExtensionContext
  ): ExtensionObserverSurface {
    return createObserverSurface(
      {
        bus: this.rawBus,
        reportFailure: (err, eventType) => this.reportObserverFailure(ownerId, err, eventType),
        // Looked up per dispatch: the context is registered right after construction and reads live.
        getContext: () => this.contexts.get(ownerId),
        // Same lease as every other registration: a disabled extension's observer must not keep
        // receiving events for the rest of the session.
        ...(getContext
          ? {
              isLive: () => this.isContextLive(getContext()),
              onRefused: () => this.refuseRegistration(ownerId, "events.observe"),
            }
          : {}),
      },
      registrations
    );
  }

  private reportingObserverFailure = false;

  private reportObserverFailure(extensionId: string, err: unknown, eventType?: string): void {
    const message = errorMessage(err);
    // Reporting by emitting the event the failing handler observes is a recursion: an `observeAny`
    // handler that always throws turned one failure into ~1.2k `agent:extension-error` emissions
    // (verified), evicting every other buffered log entry and replacing the real error with a
    // swallowed stack overflow. In that case the direct row is the only record.
    if (eventType === "agent:extension-error" || this.reportingObserverFailure) {
      this.writeExtensionLog("warn", extensionId, `event observer failed: ${message}`);
      return;
    }
    this.reportingObserverFailure = true;
    try {
      this.rawBus.emit("agent:extension-error", {
        extensionId,
        phase: "event-observer",
        error: message,
      });
    } finally {
      this.reportingObserverFailure = false;
    }
  }

  /**
   * Emit `session:start` to registered interceptors (per-agent ExtensionEventBus).
   * Distinct from the telemetry `session:start` emitted via the unified bus —
   * this one is interceptable by extensions.
   */
  async emitSessionStart(cwd: string, agentId: string): Promise<void> {
    // Awaited, like `session:shutdown`: an async handler that warms an index or reads the transcript
    // was still in flight when the first model call started. Errors stay contained (bootstrap must
    // not fail because a hook threw) but the handler itself is awaited.
    const sessionId = this.options.getRuntime?.()?.sessionId() ?? null;
    await this.eventBus
      .emit({
        type: "session:start",
        payload: { cwd, agentId, ...(sessionId ? { sessionId } : {}) },
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
  async emitSessionShutdown(agentId: string): Promise<void> {
    const sessionId = this.options.getRuntime?.()?.sessionId() ?? null;
    await this.eventBus
      .emit({
        type: "session:shutdown",
        payload: { agentId, ...(sessionId ? { sessionId } : {}) },
        defaultReturn: undefined,
      })
      .catch(() => {});
  }

  /** The extension tools this runner still holds, one per name — a mirror of what the host holds,
   * re-derived from each stack's highest rank (the resolution reading of dispatch order). */
  getTools(): ExtensionToolDefinition[] {
    return this.stacks.allTools();
  }

  getCommands(): ExtensionCommand[] {
    return this.stacks.allCommands();
  }

  getTool(name: string): ExtensionToolDefinition | undefined {
    return this.stacks.tool(name);
  }

  /** Collect this turn's extension sections — see {@link ExtensionTurnContext.collect}. */
  async collectBeforeAgentStart(prompt: string, agentId: string): Promise<ExtensionPromptAppends> {
    return this.turnContextSections.collect(prompt, agentId);
  }

  async loadExtension(api: ExtensionAPI, config?: ExtensionConfig): Promise<ExtensionInstance> {
    // The loader dedupes discovered FILES by basename, but a module declares the id. Two files
    // can therefore yield the same id; without this replacement the second instance is active but
    // `setEnabled(id, false)` always targets the first one, leaving a permanently "on" copy.
    const duplicate = this.extensions.find((entry) => entry.api.id === api.id);
    if (duplicate) {
      // Two files can declare the same id (the loader dedupes by basename, the module owns the
      // id). Replacing is the defined behaviour, but it must not be silent: the earlier instance
      // is torn down, and anyone looking at the panel otherwise sees one extension where two
      // files were loaded.
      this.writeExtensionLog(
        "warn",
        api.id,
        `duplicate extension id — replacing the earlier instance (${duplicate.api.name ?? "unnamed"})`
      );
      await this.destroyExtension(duplicate);
      this.extensions = this.extensions.filter((entry) => entry !== duplicate);
      this.ranks.delete(api.id);
      this.turnContextSections.clearNotices(api.id);
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

    // The id is the extension's identity everywhere: the `<ctx kind="ext:<id>">` tag, the owner id
    // used for tool/presentation scoping, and the disable/enable key. A non-slug id would corrupt
    // the turn-context envelope, so it is refused — registered as an errored instance (so the
    // catalog and the bootstrap report say why) but never activated and never given a context.
    if (!EXTENSION_ID_RE.test(api.id)) {
      const error = new Error(
        `Invalid extension id "${api.id}": ids must match [A-Za-z][A-Za-z0-9._/-]* (it becomes a <ctx kind> tag).`
      );
      this.writeExtensionLog("error", api.id || "unknown", error.message);
      const invalid: ExtensionInstance = { api, context: ctx, state: "error", error, registrations };
      this.extensions.push(invalid);
      return invalid;
    }

    this.contexts.set(api.id, ctx);
    const instance: ExtensionInstance = {
      api,
      context: ctx,
      state: "inactive",
      registrations,
      ...(config ? { config } : {}),
    };

    this.extensions.push(instance);
    this.activating.add(api.id);
    this.refusedRegistrations.delete(api.id);

    try {
      await api.activate(ctx);
      // A teardown during activation (destroyAll) revokes the context; the activation must not
      // resurrect the instance afterwards.
      if (!this.isContextLive(ctx)) {
        // `destroyExtension` ran `deactivate` BEFORE this promise resolved, so anything the rest of
        // `activate` acquired after the revoke has no other owner: release it here (the extension
        // contract makes teardown idempotent) and drop any artifact that still landed on a race.
        await this.deactivateExtension(instance);
        this.unregisterInstanceArtifacts(instance);
        instance.state = "inactive";
        return instance;
      }
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
      // Emitting is the record (and the bootstrap reports it too); the direct logger row duplicated it.
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
    this.uiBridge.clearOwner(instance.api.id);
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
    this.stacks.clear();
    this.turnContextSections.clear();
    this.messageTransformers.clearAll();
    this.uiBridge.clearAll();
    this.uiBridge.dispose();
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
        // This extension's OWN definition (not the live one): the panel describes what each
        // extension registers, and a shadowed command is still this extension's command.
        commands: instance.registrations.commands.map((name) => {
          const own = this.stacks.ownerCommand(name, instance.api.id);
          return {
            name,
            hasOptions: Boolean(own?.getOptions),
            description: own?.description ?? "",
          };
        }),
      }));
  }

  /** The command dispatch would run for a name (the highest-ranked registration). */
  private liveCommand(name: string): ExtensionCommand | undefined {
    return this.stacks.liveCommand(name);
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
    // A toggle is not re-entrant. Two overlapping calls used to both observe the pre-toggle state
    // and both run `activate()`, registering two copies of every tool, observer and interceptor.
    if (this.pendingToggles.has(id)) {
      return { ok: false, message: `Extension "${id}" is already being toggled` };
    }
    // Refuse while an activation is in flight instead of answering from a state that is about to
    // change: the old check read `state === "inactive"` (the state an activation starts from) and
    // returned a success "already disabled" for an extension that went on to become active.
    //
    // Disabling is the exception: a hung activation must not make the extension impossible to turn
    // off (the one remedy a broken extension needs). Revoke the lease first — everything the
    // activation tries from here on is refused — drop what it already registered, and let the
    // revoke branch release its resources if/when it resolves.
    if (this.activating.has(id)) {
      if (!enabled) {
        const instance = this.extensions.find((e) => e.api.id === id);
        if (instance) {
          this.contexts.delete(id);
          this.unregisterInstanceArtifacts(instance);
          instance.state = "inactive";
          return { ok: true, message: `Extension "${id}" disabled; its activation was revoked` };
        }
      }
      return { ok: false, message: `Extension "${id}" is still activating — try again when it finishes` };
    }
    this.pendingToggles.add(id);
    try {
      return await this.applyEnabled(id, enabled);
    } finally {
      this.pendingToggles.delete(id);
    }
  }

  private async applyEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; message: string }> {
    const instance = this.extensions.find((e) => e.api.id === id);
    if (!instance) return { ok: false, message: `Extension "${id}" not loaded` };

    const already = instance.state === "active";
    if (enabled && already) return { ok: true, message: `Extension "${id}" already enabled` };
    // "Already disabled" must also mean "nothing of it is still registered". A late registration
    // used to land while the state said inactive, and this short-circuit then refused the only
    // cleanup path — the tool stayed live for the rest of the session.
    if (!enabled && instance.state === "inactive" && !this.hasLiveArtifacts(instance)) {
      return { ok: true, message: `Extension "${id}" already disabled` };
    }

    if (enabled && !EXTENSION_ID_RE.test(instance.api.id)) {
      return { ok: false, message: `Extension "${id}" has an invalid id and cannot be enabled` };
    }

    if (enabled) {
      this.activating.add(instance.api.id);
      // A fresh context per activation: the context IS the registration lease (see
      // `isContextLive`), so a callback retained from the previous incarnation cannot land its
      // tool/transformer in this one. The registrations object is shared on purpose — it is this
      // instance's bookkeeping, not the incarnation's.
      const context = this.createContext(instance.api, instance.config, instance.registrations);
      instance.context = context;
      this.contexts.set(instance.api.id, context);
      this.refusedRegistrations.delete(instance.api.id);
      try {
        await instance.api.activate(context);
        if (!this.isContextLive(context)) {
          // Revoked while activating (destroyAll): stay inactive, register nothing further — and
          // release whatever the rest of `activate` acquired after the revoke, which the teardown
          // could not have seen (deactivate is idempotent by contract).
          await this.deactivateExtension(instance);
          this.unregisterInstanceArtifacts(instance);
          instance.state = "inactive";
          return { ok: false, message: `Extension "${id}" was disabled while activating` };
        }
        instance.state = "active";
        instance.error = undefined;
        this.turnContextSections.clearNotices(instance.api.id);
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
    const provider = this.turnContextSections.providerOf(instance.api.id);
    const ctxForDisable = this.contexts.get(instance.api.id);
    // A broken extension is the one that most needs disabling, so its own notice producer must
    // not be able to block the disable: a throw used to reject `setEnabled`, leaving the
    // extension active with no rollback — the remedy unreachable through the path that needs it.
    const custom = await this.turnContextSections.captureDisabledNotice(
      instance.api.id,
      "context provider",
      provider?.disabledContent ? () => provider.disabledContent!(ctxForDisable) : undefined
    );
    const sectionNotices: Array<[string, string]> = [];
    const disabledSections = provider
      ? this.turnContextSections.normalizeSections(provider, instance.api.id)
      : undefined;
    for (const section of disabledSections?.values() ?? []) {
      const body = await this.turnContextSections.captureDisabledNotice(
        instance.api.id,
        `section "${section.name}"`,
        section.disabledContent ? () => section.disabledContent!(ctxForDisable) : undefined
      );
      if (body?.trim()) sectionNotices.push([section.name, body.trim()]);
    }

    await this.destroyExtension(instance);
    const notice =
      custom === undefined
        ? `Extension "${instance.api.name ?? id}" is disabled — its tools and commands are unavailable.`
        : custom.trim();
    this.turnContextSections.setDisabledNotice(instance.api.id, notice);
    for (const [name, body] of sectionNotices) {
      this.turnContextSections.setSectionNotice(instance.api.id, name, body);
    }
    return { ok: true, message: `Extension "${id}" disabled` };
  }

  /**
   * Whether anything this extension registered is still live.
   *
   * The "already disabled" fast path used to key on `state` alone; a late registration could land
   * while the state said inactive, and that fast path then refused the only cleanup path.
   */
  private hasLiveArtifacts(instance: ExtensionInstance): boolean {
    return (
      this.contexts.has(instance.api.id) ||
      this.turnContextSections.hasProvider(instance.api.id) ||
      instance.registrations.tools.length > 0 ||
      instance.registrations.commands.length > 0 ||
      instance.registrations.unsubInterceptors.length > 0 ||
      instance.registrations.unsubObservers.length > 0 ||
      instance.registrations.unsubTurnContext.length > 0 ||
      instance.registrations.messageTransformers.length > 0 ||
      instance.registrations.toolOutputDecoratorDisposers.length > 0
    );
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
      this.stacks.removeTool(name, instance.api.id);
      this.options.onUnregisterTool?.(name, instance.api.id);
    }
    for (const name of instance.registrations.commands) {
      const { existed, live } = this.stacks.removeCommand(name, instance.api.id);
      if (!existed) continue;
      if (live === undefined) {
        this.options.onUnregisterCommand?.(name);
      } else {
        // A survivor becomes live: tell the observer the same way a fresh registration would, so
        // "the command is now X" has one shape whether it came from load or from a disable.
        this.options.onRegisterCommand?.(live);
      }
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

  /** The live context of an active extension, for dispatch sites outside the runner. */
  contextFor(extensionId: string): ExtensionContext | undefined {
    return this.contexts.get(extensionId);
  }

  /** The live context that owns a registered command (commands are dispatched by the session). */
  contextForCommand(name: string): ExtensionContext | undefined {
    const owner = this.stacks.commandOwner(name);
    return owner === undefined ? undefined : this.contexts.get(owner);
  }

  /**
   * Wrap an interceptor so it receives the extension's live context as its second argument.
   * Memoized per handler+extension: `events.on` / `events.off` must agree on the identity.
   */
  private wrapInterceptor(
    extensionId: string,
    pattern: string,
    handler: EventInterceptor<InterceptableEvent>
  ): EventInterceptor<InterceptableEvent> {
    let byExtension = this.interceptorWrappers.get(handler);
    if (!byExtension) {
      byExtension = new Map();
      this.interceptorWrappers.set(handler, byExtension);
    }
    // Keyed by (extension, pattern), not extension alone: one handler registered for two patterns
    // used to share a wrapper that closed over the FIRST pattern, so a failure on the second was
    // reported against the wrong hook — and the memo made that the normal case.
    const key = `${extensionId}\0${pattern}`;
    const existing = byExtension.get(key);
    if (existing) return existing;
    const wrapped: EventInterceptor<InterceptableEvent> = async (event) => {
      try {
        return await handler(event, this.contexts.get(extensionId));
      } catch (err) {
        // Contained here rather than only at the bus: the bus isolates the throw but cannot say
        // *which* extension owns the handler, so the log row would name a pattern instead of the
        // extension a user can disable. Returning `undefined` keeps the chain going (a throwing
        // interceptor is not a veto).
        this.reportInterceptorFailure(extensionId, pattern, event.type, err);
        return undefined;
      }
    };
    byExtension.set(key, wrapped);
    return wrapped;
  }

  /** Report a throwing interceptor against the extension that registered it. */
  private reportInterceptorFailure(extensionId: string, pattern: string, eventType: string, err: unknown): void {
    const message = errorMessage(err);
    this.writeExtensionLog("warn", extensionId, `interceptor for "${pattern}" failed on ${eventType}: ${message}`);
    this.rawBus.emit("agent:extension-error", {
      extensionId,
      phase: "interceptor",
      error: `${pattern} (${eventType}): ${message}`,
    });
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

  /** Build one activation's context — see {@link createExtensionContext}. */
  private createContext(
    api: ExtensionAPI,
    config?: ExtensionConfig,
    registrations?: ExtensionRegistrations
  ): ExtensionContext {
    return createExtensionContext(this.contextHost, api, config, registrations);
  }

  /**
   * Whether a registration may still land.
   *
   * The context IS the lease. Exactly one context per instance incarnation is registered on the
   * runner (`contexts`), disabling/destroying deletes it, and re-enabling hands the extension a NEW
   * context. A callback retained from a previous incarnation (a timer, a promise continuation, a
   * cached `ctx`) therefore holds a context that is no longer registered, and is refused — before
   * this, such a call re-created the tool/transformer after the panel said "disabled", with no path
   * to clean it up: `unregisterInstanceArtifacts` had already cleared the registrations list, so a
   * later disable could not even find it.
   */
  private isContextLive(context: ExtensionContext): boolean {
    return this.contexts.get(context.id) === context;
  }

  /** Refuse a post-disable registration: one warning per revoke, then silence. */
  private refuseRegistration(extensionId: string, operation: string): void {
    if (this.refusedRegistrations.has(extensionId)) return;
    this.refusedRegistrations.add(extensionId);
    this.writeExtensionLog(
      "warn",
      extensionId,
      `${operation}() after the extension was disabled — ignored (the context it holds is no longer live)`
    );
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

  /**
   * The extension-scoped configuration map exposed as `ctx.env`: string values from its
   * `ExtensionConfig.config` (non-strings are dropped, since the field is a string map).
   *
   * Deliberately NOT a process-environment snapshot: extensions that need the workspace environment
   * read `ctx.coreEnv.getEnv()` (async, runtime-agnostic), and handing every extension the host's
   * whole environment would be a capability no extension declared.
   */
  private extensionEnv(extConfig?: Record<string, unknown>): Record<string, string> {
    const env: Record<string, string> = {};
    if (extConfig) {
      for (const [key, value] of Object.entries(extConfig)) {
        if (typeof value === "string") env[key] = value;
      }
    }
    return env;
  }
}
