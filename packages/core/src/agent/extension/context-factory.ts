/**
 * Builds one activation's {@link ExtensionContext} — the object an extension registers through and
 * reads live facts from.
 *
 * Extracted from `ExtensionRunner` because it is a self-contained surface (the shape an extension
 * author sees) while the runner is a lifecycle engine. The host supplies the operations; this module
 * only wires them:
 *
 *   - `register*` calls are **leases**: every entry first asks `host.isLive(context)`, and a revoked
 *     incarnation's retained callback is refused instead of reviving a disabled extension;
 *   - facts (`sessionId`, `mode`, `signal`, …) are read through `host.getRuntime()` on every access,
 *     never captured, so a handler running after a session switch sees the new session;
 *   - bookkeeping (`registrations.*`) is pushed here, next to the registration that created it.
 */

import { registerExtensionExitFlush } from "../agent-log/lifecycle-guards.js";

import { ExtensionLlmError } from "./extension-llm-error.js";
import { z } from "./extension-zod.js";

import type { DispatchRank } from "../dispatch-order.js";
import type {
  ExtensionAPI,
  ExtensionCommand,
  ExtensionConfig,
  ExtensionContext,
  ExtensionContextProvider,
  ExtensionEventBus,
  ExtensionLlm,
  ExtensionLlmRequest,
  ExtensionLlmResult,
  ExtensionObserverSurface,
  ExtensionRegistrations,
  ExtensionRuntimeAccess,
  ExtensionToolDefinition,
  ExtensionUI,
  InterceptableEvent,
  EventInterceptor,
  MessageTransformer,
} from "./types.js";
import type { CoreEnv } from "../../env";
import type { LogCategory, LogLevel } from "../agent-log/types.js";
import type { ToModelOutputDecorator } from "../tools/runtime/contract.js";

/** Everything the context needs from the runner, as operations rather than a back-reference. */
export interface ContextFactoryHost {
  /** Fixed for the runner's lifetime. */
  agentId: string;
  cwd: string;
  /** Live access to the agent runtime (session/run facts), resolved per access. */
  getRuntime: () => ExtensionRuntimeAccess | undefined;
  getCoreEnv: () => CoreEnv;
  /** The extension's own config map (`ctx.env`). */
  extensionEnv: (config?: Record<string, unknown>) => Record<string, string>;
  completeLlm: (extensionId: string, request: ExtensionLlmRequest) => Promise<ExtensionLlmResult>;
  log: (level: LogLevel, extensionId: string, message: string, category?: LogCategory) => void;

  /** Registration lease: false once this incarnation was disabled/destroyed. */
  isLive: (context: ExtensionContext) => boolean;
  /** Warn once that a post-disable registration was refused. */
  refuse: (extensionId: string, operation: string) => void;

  rankOf: (extensionId: string) => DispatchRank;
  registerTool: (extensionId: string, def: ExtensionToolDefinition, rank: DispatchRank) => void;
  registerToolOutputDecorator: (
    extensionId: string,
    toolName: string,
    decorator: ToModelOutputDecorator
  ) => (() => void) | undefined;
  registerCommand: (extensionId: string, cmd: ExtensionCommand, rank: DispatchRank) => void;
  registerInterceptor: <T extends InterceptableEvent>(
    extensionId: string,
    eventType: string,
    handler: EventInterceptor<T>,
    rank: DispatchRank
  ) => () => void;
  offInterceptor: <T extends InterceptableEvent>(
    extensionId: string,
    eventType: string,
    handler: EventInterceptor<T>
  ) => void;
  registerContextProvider: (extensionId: string, provider: ExtensionContextProvider, rank: DispatchRank) => () => void;
  registerMessageTransformer: (extensionId: string, transformer: MessageTransformer, rank: DispatchRank) => void;
  /** Drop one transformer (the disposer a registration returns). */
  disposeMessageTransformer: (extensionId: string, transformer: MessageTransformer) => void;

  /** The bus surface an extension may emit on / query. */
  eventBus: Pick<ExtensionEventBus, "emit" | "hasInterceptors">;
  observerSurface: (
    extensionId: string,
    registrations: ExtensionRegistrations | undefined,
    getContext: () => ExtensionContext
  ) => ExtensionObserverSurface;
  ui: (
    extensionId: string,
    registrations: ExtensionRegistrations | undefined,
    getContext: () => ExtensionContext
  ) => ExtensionUI;
}

/**
 * Build the context for one activation.
 *
 * `registrations` is the instance's (not the incarnation's) bookkeeping: it survives a disable/enable
 * cycle and is cleared in place, so the closures here push into the same arrays the rollback reads.
 */
export function createExtensionContext(
  host: ContextFactoryHost,
  api: ExtensionAPI,
  config?: ExtensionConfig,
  registrations?: ExtensionRegistrations
): ExtensionContext {
  const runtime = () => host.getRuntime();

  const context: ExtensionContext = {
    id: api.id,
    agentId: host.agentId,
    env: host.extensionEnv(config?.config),
    z,
    cwd: host.cwd,
    coreEnv: host.getCoreEnv(),

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
      // A lease like every `register*`: a retained timer or promise continuation must not spend the
      // user's tokens after the panel says "disabled". `complete` is async by contract, so a revoked
      // call REJECTS with a typed error instead of throwing synchronously — the caller's `try/catch`
      // or `.catch` sees the same shape as any other failure.
      complete: (request: ExtensionLlmRequest) =>
        host.isLive(context)
          ? host.completeLlm(api.id, request)
          : Promise.reject(
              new ExtensionLlmError(
                "revoked",
                `Extension "${api.id}" is no longer active; its \`ctx.llm.complete\` call was refused.`
              )
            ),
    } as ExtensionLlm,

    registerTool: (def: ExtensionToolDefinition) => {
      if (!host.isLive(context)) {
        host.refuse(api.id, "registerTool");
        return;
      }
      // The rank travels with the registration: the authoritative tool stack (which entry is live)
      // lives in the host's registry, which cannot see the extension's own order.
      host.registerTool(api.id, def, host.rankOf(api.id));
      registrations?.tools.push(def.name);
    },

    registerToolOutputDecorator: (toolName, decorator) => {
      if (!host.isLive(context)) {
        host.refuse(api.id, "registerToolOutputDecorator");
        return () => {};
      }
      const disposeOwned = host.registerToolOutputDecorator(api.id, toolName, decorator);
      let active = true;
      const dispose = () => {
        if (!active) return;
        active = false;
        const index = registrations?.toolOutputDecoratorDisposers.indexOf(dispose) ?? -1;
        if (index >= 0) registrations!.toolOutputDecoratorDisposers.splice(index, 1);
        disposeOwned?.();
      };
      registrations?.toolOutputDecoratorDisposers.push(dispose);
      return dispose;
    },

    registerCommand: (cmd: ExtensionCommand) => {
      if (!host.isLive(context)) {
        host.refuse(api.id, "registerCommand");
        return;
      }
      host.registerCommand(api.id, cmd, host.rankOf(api.id));
      registrations?.commands.push(cmd.name);
    },

    registerInterceptor: <T extends InterceptableEvent>(
      eventType: string,
      handler: EventInterceptor<T>
    ): (() => void) => {
      if (!host.isLive(context)) {
        host.refuse(api.id, "registerInterceptor");
        return () => {};
      }
      const unsub = host.registerInterceptor(api.id, eventType, handler, host.rankOf(api.id));
      registrations?.unsubInterceptors.push(unsub);
      return unsub;
    },

    registerContextProvider: (provider: ExtensionContextProvider): (() => void) => {
      if (!host.isLive(context)) {
        host.refuse(api.id, "registerContextProvider");
        return () => {};
      }
      const unsub = host.registerContextProvider(api.id, provider, host.rankOf(api.id));
      registrations?.unsubTurnContext.push(unsub);
      return unsub;
    },

    registerFlush: (flush: (ctx?: ExtensionContext) => Promise<void> | void): (() => void) => {
      if (!host.isLive(context)) {
        host.refuse(api.id, "registerFlush");
        return () => {};
      }
      if (!registrations) return () => {};
      registrations.flush = flush;
      // Identity-checked: a stale disposer from a replaced flush must not clear
      // the newer registration (mirrors `registerContextProvider` above).
      return () => {
        if (registrations.flush === flush) registrations.flush = null;
      };
    },

    registerExitFlush: (flush: () => void): (() => void) => {
      if (!host.isLive(context)) {
        host.refuse(api.id, "registerExitFlush");
        return () => {};
      }
      if (!registrations) return () => {};
      registrations.exitFlush = flush;
      // Release the replaced registration first: it stays in the process-exit registry otherwise,
      // so a re-registering extension runs its OLD flush at exit (through state it already freed)
      // and every re-enable adds another.
      registrations.exitFlushRef?.();
      // Also registered process-wide: an exit with a live session never runs agent teardown,
      // and that is exactly the case where the final batch matters most.
      const ref = registerExtensionExitFlush(flush);
      registrations.exitFlushRef = ref;
      return () => {
        if (registrations.exitFlush === flush) registrations.exitFlush = null;
        // Identity-checked like `registerFlush` / `registerContextProvider`: a disposer held
        // across a replacement must not unregister the LIVE flush. The field guard alone was not
        // enough — the call below ran unconditionally and removed the newer registration.
        if (registrations.exitFlushRef === ref) {
          ref();
          registrations.exitFlushRef = null;
        }
      };
    },

    registerMessageTransformer: (transformer: MessageTransformer): (() => void) => {
      if (!host.isLive(context)) {
        host.refuse(api.id, "registerMessageTransformer");
        return () => {};
      }
      host.registerMessageTransformer(api.id, transformer, host.rankOf(api.id));
      if (registrations && !registrations.messageTransformers.includes(api.id)) {
        registrations.messageTransformers.push(api.id);
      }
      // Identity-checked: a stale disposer from a replaced transformer must not
      // clear the newer registration (mirrors `registerContextProvider` above).
      return () => {
        host.disposeMessageTransformer(api.id, transformer);
      };
    },

    events: {
      // Delegate interception to the shared facade and add this extension's
      // observer accessors. Not a spread: `BusExtensionEventBus` keeps its
      // methods on the prototype, so spreading the instance would drop them.
      //
      // Both of these are leases too, for a different reason than `register*`: an interceptor event
      // drives OTHER extensions' handlers. Observer dispatch and retained state are not reachable
      // from here (the facade only calls `intercept`), but a retained callback could still make
      // someone else's `tool:before:*` / `before_agent_start` handler run — and `hasInterceptors` is
      // a fast-path guard whose whole contract is "will anything receive this".
      emit: (event) => (host.isLive(context) ? host.eventBus.emit(event) : Promise.resolve(undefined)),
      hasInterceptors: (type) => host.isLive(context) && host.eventBus.hasInterceptors(type),
      // The `ctx.events.on` accessor is an interceptor registration equivalent to
      // `ctx.registerInterceptor`, so it must carry the same rank — otherwise an extension
      // ordering itself with `order` would get its declared position through one entry point
      // and the default through the other.
      on: (type, handler) => {
        if (!host.isLive(context)) {
          host.refuse(api.id, "events.on");
          return () => {};
        }
        const unsub = host.registerInterceptor(api.id, type, handler, host.rankOf(api.id));
        // Same bookkeeping as `registerInterceptor`: without it, an interceptor registered through
        // this entry point kept firing (and cancelling tools) after the extension was disabled.
        registrations?.unsubInterceptors.push(unsub);
        return unsub;
      },
      off: (type, handler) => host.offInterceptor(api.id, type, handler),
      ...host.observerSurface(api.id, registrations, () => context),
    },
    ui: host.ui(api.id, registrations, () => context),

    logger: {
      info: (msg: string) => host.log("info", api.id, msg),
      warn: (msg: string) => host.log("warn", api.id, msg),
      error: (msg: string) => host.log("error", api.id, msg),
      log: (level, category, msg) => host.log(level, api.id, msg, category),
    },
  };
  return context;
}
