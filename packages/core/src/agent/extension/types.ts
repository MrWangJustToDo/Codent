import type { ExtensionContextUsage, ExtensionLlm } from "./context-access.js";
import type { DispatchRank } from "../dispatch-order.js";
import type { ExtensionObserverSurface } from "./event-visibility.js";
import type { ExtensionZod } from "./extension-zod.js";
import type { MessageTransformer } from "./message-transform-types.js";
import type { ToolCallResult, ToolExecutionOptions } from "./tool-execution-types.js";
import type { ExtensionUI } from "./ui-types.js";
import type { CoreEnv } from "../../env";
import type { LogCategory, LogLevel } from "../agent-log/types.js";
import type { ToolPresentation } from "../tools/presentation/types.js";
import type { ModelToolContent, ToModelOutputContext, ToModelOutputDecorator } from "../tools/runtime/contract.js";
import type { ModelMessage, SchemaInput } from "@tanstack/ai";

export type { ExtensionZod } from "./extension-zod.js";

/** Re-exported so extension authors can name the union without importing `models/**`. */
export type { MultimodalPartType } from "../../utils/multimodal-part-types.js";
export type { ModelCapability } from "../../models/types.js";

// ============================================================================
// Split-out contracts
// ============================================================================
//
// These two blocks used to live here and pushed the file to the `max-lines` ceiling. They are
// re-exported so every existing `./types.js` import keeps working — the definitions themselves
// (including the one runtime value, `MODEL_CAPABILITY_FLAGS`) have a single home.

export type { ToolCallResult, ToolExecutionOptions } from "./tool-execution-types.js";
export type {
  MessageTransformContext,
  MessageTransformPhase,
  MessageTransformer,
  ModelCapabilityFlags,
} from "./message-transform-types.js";
export { MODEL_CAPABILITY_FLAGS, buildModelCapabilityFlags } from "./message-transform-types.js";

// ============================================================================
// Lifecycle Hooks
// ============================================================================

export type ExtensionLifecycleEvent = "bootstrap" | "activate" | "deactivate" | "destroy";

// ============================================================================
// Tool registration
// ============================================================================

export interface ExtensionToolDefinition {
  name: string;
  description: string;
  /**
   * Any Standard-Schema / JSON-Schema compliant schema (Zod, ArkType, Valibot, or a plain JSON Schema object).
   * Not locked to Zod — see {@link ExtensionContext.z} for the convenience Zod API.
   */
  inputSchema: SchemaInput;
  outputSchema?: SchemaInput;
  execute: (input: unknown, options: ToolExecutionOptions, ctx?: ExtensionContext) => Promise<ToolCallResult>;
  /**
   * How this tool is presented: fold category, keep-row / detailed / client-side
   * flags, header summary, input label, and the result-text renderer (`text`).
   *
   * Declared here instead of in a host-side table: core renders it at tool completion
   * and ships the result with the message, so it works even when the host runs in a
   * different process (remote CoreEnv / Agent Session). Every function MUST be pure —
   * a function of the stored output (or parsed input) only.
   */
  present?: ToolPresentation;
  /** Optional model-facing output transform (registered on the TanStack tool). */
  toModelOutput?: (ctx: ToModelOutputContext) => Promise<ModelToolContent> | ModelToolContent;
  /**
   * Require explicit user approval before this tool runs (the same gate built-in
   * tools use). Without it the approval system was closed to third-party tools:
   * `isToolNeedsApproval` read this field, but nothing registered it, so an
   * extension could never ask the user first.
   */
  needsApproval?: boolean;
  /**
   * Abort this tool's `execute` after this many milliseconds.
   *
   * Nothing upstream bounds an extension tool: a handler that awaits a request that
   * never settles hangs the turn forever, with no way to recover short of killing
   * the process. On timeout the tool fails with a message naming the budget, so the
   * model can see why and the user is not left with a spinner. Omit for no limit
   * (the historical behaviour).
   */
  timeoutMs?: number;
  /**
   * Lazy tools are excluded from the initial request; the model discovers them by
   * name via the synthetic `__lazy__tool__discovery__` tool. Keeps low-usage tools
   * available without per-turn token cost. Defaults to false (eager).
   */
  lazy?: boolean;
}

// ============================================================================
// Command registration (slash commands)
// ============================================================================

export interface ExtensionCommandOption {
  label: string;
  value: string;
  description?: string;
}

export interface ExtensionCommand {
  name: string;
  description: string;
  execute: (args: string[], ctx?: ExtensionContext) => Promise<string | void>;
  /**
   * Optional: provide secondary-menu options for this command (e.g. `/resume`
   * lists recent sessions). The app's autocomplete shows these as a browseable
   * list when the user types `/name ` (after selecting the command). Each option
   * is executed as `/name <value>`.
   */
  getOptions?: (args: string[]) => ExtensionCommandOption[] | Promise<ExtensionCommandOption[]>;
  /**
   * Optional: when set, the dispatch layer injects the returned text as a user
   * message into the session (via chat.sendMessage) after `execute` resolves,
   * triggering a model turn. Use this to have a slash command drive the agent
   * (e.g. `/skill <name>` expanding the skill body into the conversation).
   * Returning undefined (or an empty string) skips injection.
   */
  injectMessage?: (
    args: string[],
    result: string | void,
    ctx?: ExtensionContext
  ) => string | undefined | Promise<string | undefined>;
}

// ============================================================================
// Interceptable Events (ExtensionEventBus)
// ============================================================================

export interface InterceptableEvent<TPayload = unknown, TReturn = unknown> {
  type: string;
  payload: TPayload;
  defaultReturn?: TReturn;
  /**
   * Cancellation verdict: the action this event guards must not happen.
   *
   * Set it explicitly (`event.skip = true`) or by returning `false` from the interceptor — the bus
   * normalizes both into this field, so there is ONE way to read a veto. The chain stops on it for
   * EVERY event type; only `tool:before:*` turns it into a denied tool call, so an observe-only
   * hook must not set it.
   */
  skip?: boolean;
  /** Why, when `skip` is set. Surfaces in the tool result the model sees and in the log row. */
  reason?: string;
  /**
   * Set by the bus when an interceptor threw or exceeded the chain budget: that handler's verdict is
   * **unknown**, which is not an approval. Gates that must fail closed (the `tool:before:*` tool
   * gate) read this; observe-only hooks can ignore it.
   *
   * Sticky for the event: there is no "clear" path, because a later handler cannot prove the failed
   * one would have allowed the call. A `tool:before:*` observer that throws therefore denies every
   * call it matches — intentional fail-closed behaviour, and the reason a hook should contain its
   * own errors when it is only observing.
   */
  handlerError?: boolean;
  /** @deprecated use {@link skip}. Kept so existing extensions keep compiling; normalized by the bus. */
  skipDefault?: boolean;
}

export type EventInterceptor<TEvent extends InterceptableEvent> = (
  event: TEvent,
  /**
   * Live context for this dispatch (session/run/model facts). Optional so an existing handler that
   * only reads the event keeps compiling; the runner always passes it.
   */
  ctx?: ExtensionContext
) => Promise<boolean | void> | boolean | void;

// ============================================================================
// Tool control events (interceptors mutate the event to signal actions)
// ============================================================================

export interface ToolBeforePayload {
  toolName: string;
  args: unknown;
  /** Disk session owning this call; omitted when unknown (never falls back to the agent id). */
  sessionId?: string;
}

export interface ToolBeforeEvent extends InterceptableEvent<ToolBeforePayload> {
  type: `tool:before:${string}`;
  payload: ToolBeforePayload;
  /** Set by interceptor to skip the tool call */
  skip?: boolean;
  /** Optional reason when skipping */
  reason?: string;
  /** Set by interceptor to modify tool arguments before execution */
  modifiedArgs?: unknown;
}

export interface ToolAfterPayload {
  toolName: string;
  args: unknown;
  result: unknown;
  durationMs: number;
  /** Set by an interceptor to replace the tool result returned to the model. */
  modifiedResult?: unknown;
}

export interface ToolAfterEvent extends InterceptableEvent<ToolAfterPayload> {
  type: `tool:after:${string}`;
  payload: ToolAfterPayload;
}

export interface ToolErrorPayload {
  toolName: string;
  args: unknown;
  error: string;
}

export interface ToolErrorEvent extends InterceptableEvent<ToolErrorPayload> {
  type: `tool:error:${string}`;
  payload: ToolErrorPayload;
}

// ============================================================================
// Per-turn prompt hooks (before_agent_start)
// ============================================================================

export interface BeforeAgentStartPayload {
  /** User prompt text for this turn (or a placeholder when structured-only). */
  prompt: string;
  /** Root agent id (the runtime's identity, not the on-disk session id). */
  agentId: string;
  /** Active disk session id when one is bound. */
  sessionId?: string;
}

/**
 * Interceptable event fired once per user prompt before turn-context snapshot.
 * Observable for extensions that want to react to the start of a user turn.
 */
export interface BeforeAgentStartEvent extends InterceptableEvent<BeforeAgentStartPayload> {
  type: "before_agent_start";
  payload: BeforeAgentStartPayload;
}

export type TurnContextProvider = (ctx?: ExtensionContext) => string | undefined | Promise<string | undefined>;

/**
 * Per-extension context injection (the single unified injection API).
 *
 * Register once via {@link ExtensionContext.registerContextProvider}; the runner
 * emits this extension as its own `<ctx kind="ext:<extension id>">` section each
 * user turn (a named section adds `:<name>`). `content` is injected while enabled;
 * `disabledContent` replaces it when the extension is disabled at runtime — both
 * share the same tag, so the model sees enable/disable symmetrically.
 */
export interface ExtensionContextProvider {
  /** Injected each user turn while the extension is enabled. */
  content?: TurnContextProvider;
  /** Injected (under the same `<ctx kind="ext:<id>">` tag) when the extension is disabled. */
  disabledContent?: TurnContextProvider;
  /**
   * Upper bound for this provider's callbacks, in milliseconds.
   *
   * Defaults to the runner's extension-callback bound (60s). `0` removes the wall-clock bound for
   * this provider — use it only for a producer that is bounded by its own work (a model completion
   * honours the run signal, so Esc still cancels it). Without this, a legitimate slow section
   * (memory selection runs a side-query completion) would be cut and reported as an extension
   * failure on every turn.
   */
  timeoutMs?: number;
  /**
   * Additional named sections, each rendered under its own `<ctx kind="ext:<extensionId>:<name>">` tag
   * and admitted by its own content hash. A change in one section never re-injects another.
   */
  sections?: readonly ExtensionContextSectionProvider[];
}

/** One named section of an extension's per-turn context. */
export interface ExtensionContextSectionProvider {
  /** Section name, unique within the extension. */
  name: string;
  /** Injected each user turn while the extension is enabled. */
  content?: TurnContextProvider;
  /** Injected under the same kind when the extension is disabled. */
  disabledContent?: TurnContextProvider;
  /** Per-section override of {@link ExtensionContextProvider.timeoutMs} (`0` = no bound). */
  timeoutMs?: number;
}

/**
 * One extension's contribution to per-turn context. Each enabled extension is
 * emitted as its own `<ctx kind="ext:<extension id>">` section so enable/disable is
 * expressed symmetrically under the same tag (and only that section re-injects
 * when its content changes — prompt-cache friendly).
 */
export interface ExtensionTurnContextSection {
  /**
   * Section kind inside the `ext:` namespace: `ext:<extensionId>` for the base section, or
   * `ext:<extensionId>:<sectionName>` for a named section. It is the `<ctx kind>` identity (and
   * the admission key), not a bare extension id.
   */
  id: string;
  /** Rendered content. For an enabled extension this is its injected content
   *  (e.g. `<memory_index>`); for a disabled extension it is the disabled/enabled notice. */
  content: string;
}

export interface ExtensionPromptAppends {
  /** Per-extension turn-context sections (each emitted under its own kind). */
  turnContextSections?: ExtensionTurnContextSection[];
}

// ============================================================================
// Union type for tool lifecycle events
// ============================================================================

// ============================================================================
// Session lifecycle events (per-agent ExtensionEventBus)
// ============================================================================

export interface SessionStartPayload {
  /** Working directory (rootPath) of the agent session. */
  cwd: string;
  /** Root agent id (the runtime's identity, not the on-disk session id). */
  agentId: string;
  /** Active disk session id when the host bound one (absent during bootstrap). */
  sessionId?: string;
}

export interface SessionBootstrapEvent extends InterceptableEvent<SessionStartPayload> {
  type: "session:bootstrap";
  payload: SessionStartPayload;
}

export interface SessionShutdownPayload {
  /** Root agent id (the runtime's identity, not the on-disk session id). */
  agentId: string;
  /** Active disk session id, when one is still bound at teardown. */
  sessionId?: string;
}

export interface SessionShutdownEvent extends InterceptableEvent<SessionShutdownPayload> {
  type: "session:shutdown";
  payload: SessionShutdownPayload;
}

export type ToolLifecycleEvent = ToolBeforeEvent | ToolAfterEvent | ToolErrorEvent;

export interface ExtensionEventBus {
  intercept<T extends InterceptableEvent>(event: T): Promise<T["defaultReturn"] | undefined>;
  /**
   * Whether any interceptor (exact or wildcard pattern) would receive `type`.
   *
   * Fast-path guard for callers whose event payload is expensive to prepare — the `tool:after`
   * path uses it to decide whether a detached copy of the tool result is needed at all.
   */
  hasInterceptors(type: string): boolean;
  /**
   * Register an interceptor. `rank` is the declaring extension's dispatch position — supplied by
   * the runner so the shared scope node can order interceptors across extensions.
   */
  on<T extends InterceptableEvent>(type: string, handler: EventInterceptor<T>, rank?: DispatchRank): () => void;
  off<T extends InterceptableEvent>(type: string, handler: EventInterceptor<T>): void;
}

// ============================================================================
// Observer accessors (the extension's read side of the bus)
// ============================================================================
//
// The facade above is *interception*: async, ordered, shared mutable event,
// cancel short-circuits. These three are *observation*: the bus's existing
// observer dispatch mode (synchronous, registration-ordered, fire-and-forget),
// exposed so an extension can react to agent events instead of only changing
// them. A separate accessor name rather than overloading `on` keeps the two
// dispatch modes from being confused at the call site.
//
// Deliberate non-wildcard: `observeAny` expands the declared observable set
// in `event-visibility.ts` instead of subscribing to the bus's `"*"`. Two reasons — `"*"`
// would ship internal high-frequency events to extensions, and the
// `agent-event-bus` contract keeps the log extension as the only wildcard
// consumer in core.
//
// The visibility table, the observable-set expansion and the three accessor types live in
// `event-visibility.ts` (this module hit the file-size limit, and the table is the one place a new
// event must be classified). Re-exported here so consumers keep one import site.

export {
  EXTENSION_EVENT_VISIBILITY,
  INTERNAL_EXTENSION_EVENTS,
  observableExtensionEvents,
} from "./event-visibility.js";
export type {
  ExtensionEventObserver,
  ExtensionEventVisibility,
  ExtensionObserverOptions,
  ExtensionObserverSurface,
  ObservableExtensionEvent,
} from "./event-visibility.js";

// ============================================================================
// UI bridge (app-layer only)
// ============================================================================

// The UI payload contract lives in `ui-types.ts` (this file reached the 800-line ceiling); it is
// re-exported here so consumers keep one import site for the whole extension surface.
export type {
  ExtensionNotificationLevel,
  ExtensionRenderNode,
  ExtensionRenderPayload,
  ExtensionUI,
  ExtensionUiContext,
  ExtensionUiModel,
  ExtensionUiUsage,
} from "./ui-types.js";

// Live-fact and model-access contract (see `context-access.ts`).
export type {
  ExtensionContextUsage,
  ExtensionLlm,
  ExtensionLlmMessage,
  ExtensionLlmRequest,
  ExtensionLlmResult,
  ExtensionRuntimeAccess,
} from "./context-access.js";

// ============================================================================
// Extension context (provided by the runner to each extension)
// ============================================================================

export interface ExtensionContext {
  id: string;
  /** Owning ManagedAgent id; scopes per-agent extension resources such as output decorators. */
  agentId: string;
  /**
   * The extension's **own** configuration map: string values from its `ExtensionConfig.config`.
   *
   * Not a process-environment snapshot (handing every extension the host's whole environment would
   * be a capability no extension declared) — read `coreEnv.getEnv()` for the workspace environment.
   */
  env: Record<string, string>;
  /** Working directory (rootPath) of the agent session. */
  cwd: string;
  /**
   * Runtime-agnostic environment: filesystem, shell, fetch, path utilities, env vars,
   * and rootPath — the single source of truth for host capabilities. Lets extensions
   * perform real I/O (read files, run commands, fetch) without importing host-specific APIs.
   */
  coreEnv: CoreEnv;

  // --------------------------------------------------------------------------
  // Run and session facts — read live at call time, never a snapshot
  // --------------------------------------------------------------------------

  /** Active disk session id, or null when none is bound. */
  readonly sessionId: string | null;
  /** Whether a run is in flight. */
  isIdle(): boolean;
  /** Session mode the runtime reports (`normal` / `auto` / plan phase). */
  readonly mode: string;
  /** Model the session is currently using, when known. */
  readonly model: string | undefined;
  /**
   * Context-window fill, as the footer reports it — the same `getContextFillTokens()` reading, not a
   * second estimate.
   */
  getContextUsage(): ExtensionContextUsage | undefined;
  /** The effective system prompt for the current run. */
  getSystemPrompt(): string;
  /**
   * A defensive copy of the **compaction projection** of the conversation (summary-first wire plus
   * synthetic `<ctx>` blocks). Mutating it cannot reach the wire.
   *
   * Not byte-identical to what the adapter receives: it is taken before `tool-compact`,
   * `message-transform` and this turn's turn-context / wire-recovery changes.
   */
  getMessages(): ModelMessage[];
  /** The active run's abort signal, or undefined when idle. */
  readonly signal: AbortSignal | undefined;
  /** One-shot model completions; usage is attributed to this session automatically. */
  llm: ExtensionLlm;

  /**
   * Host-provided Zod `z` API (same package version as core).
   * Extension modules should use `ctx.z` for schemas — do not `import` zod yourself.
   */
  z: ExtensionZod;

  registerTool(def: ExtensionToolDefinition): void;
  /**
   * Decorate a tool's model-facing output for this agent. The runner removes the decorator when
   * the extension is disabled or destroyed; the returned disposer removes it earlier.
   */
  registerToolOutputDecorator(toolName: string, decorator: ToModelOutputDecorator): () => void;
  registerCommand(cmd: ExtensionCommand): void;
  registerInterceptor<T extends InterceptableEvent>(eventType: string, handler: EventInterceptor<T>): () => void;
  /**
   * Register this extension's per-turn context injection (enabled content + disabled
   * notice) in one call. Each user turn the runner emits this extension as its own
   * `<ctx kind="ext:<extension id>">` section. Returns an unsubscribe function.
   */
  registerContextProvider(provider: ExtensionContextProvider): () => void;
  /**
   * Register a transform over the model-facing message chain, applied on every model
   * call of a run (see {@link MessageTransformer}). Returns an unsubscribe function.
   *
   * **This is not an event-bus interceptor.** It deliberately does not have a hook
   * name and does not appear in the interceptor pattern list: bus interception hands
   * every interceptor the *same mutable event* and short-circuits on cancel, whereas a
   * message transform is asynchronous, runs in extension load order, and produces a
   * replacement value. It is also not a third dispatch mode — nothing is broadcast and
   * there is no subscriber registry beyond this per-extension slot.
   *
   * At most one transformer per extension: registering again replaces the previous one,
   * and the returned disposer only clears the registration while it is still the active
   * one.
   */
  registerMessageTransformer(transformer: MessageTransformer): () => void;

  /**
   * Register an async flush, run in teardown **before** core releases what this extension may write
   * through (see {@link ExtensionAPI} for the exact phase order).
   *
   * This is not `deactivate()`: deactivate releases the extension, while flush *lands* what it has
   * already produced. The distinction is load-bearing for anything that buffers behind a timer or
   * debounce, where the last batch would otherwise be dropped by a fire-and-forget teardown. A
   * throwing flush is reported as `agent:extension-error` with phase `flush` and does not stop the
   * remaining teardown phases.
   *
   * Registering again replaces the previous flush for this extension. Returns a disposer that only
   * clears the registration while it is still the active one.
   */
  registerFlush(flush: (ctx?: ExtensionContext) => Promise<void> | void): () => void;

  /**
   * Register a **synchronous** flush for the process-exit path (`process.on("exit")` and the fatal
   * handlers), which cannot await. Best-effort: it must not throw, and a throw is contained so it
   * cannot prevent the process from exiting. Use this for the state a crash report needs.
   */
  registerExitFlush(flush: () => void): () => void;

  /**
   * Interception (`on` / `off` / `emit`) **and** observation (`observe` /
   * `observeAny` / `retained`).
   *
   * `on` and `observe` are two dispatch modes, not two spellings: `on` is an
   * async interceptor that can rewrite or cancel the operation; `observe` is a
   * synchronous observer that only reads what happened.
   */
  events: ExtensionEventBus & ExtensionObserverSurface;
  ui: ExtensionUI;

  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    /**
     * Agent-logger surface with the log's **category** selectable, for extension diagnostics
     * that are not `hooks` output (e.g. MCP configuration provenance). `info`/`warn`/`error`
     * above stay the category-less convenience form and remain the common path.
     */
    log: (level: LogLevel, category: LogCategory, msg: string) => void;
  };
}

// ============================================================================
// Extension API
// ============================================================================

export interface ExtensionAPI {
  id: string;
  name: string;
  version: string;
  description: string;
  /**
   * Declared dispatch order — **lower runs first**, absent means `0`.
   *
   * Governs the extension surfaces whose behavior is observable as a sequence: interceptor
   * dispatch, message-transformer chaining, same-named tool resolution (where the *highest*
   * order wins, because a later-running extension supersedes), and turn-context section
   * order. Ties keep the load sequence. It does **not** touch observer subscriptions,
   * extension UI render slots, command lookup, or the flush registrations — see
   * `extension-ordering` in `openspec/specs/` for the contract.
   *
   * This is a *dispatch* rule (which position the extension runs in) and is deliberately
   * unrelated to the loader's *resolution* rule for a duplicated extension id
   * (`extension/paths.ts`, later directory wins).
   */
  order?: number;

  activate(ctx: ExtensionContext): Promise<void | ExtensionActivation> | void | ExtensionActivation;
  /**
   * Release this extension's resources. Runs **after** the flush phase, so anything buffered has
   * already landed — land state in `ctx.registerFlush(...)` instead of here if teardown can be
   * asynchronous.
   *
   * **Must be idempotent, and may run more than once per incarnation.** A disable or `destroyAll`
   * during `activate` runs it immediately (revoking the lease), and again when the in-flight
   * `activate` settles: anything that activation acquired *after* the revoke has no other owner,
   * and the runner deliberately gives you the second call to release it. A teardown that closes a
   * handle, deletes a temp file or unsubscribes a socket must tolerate the repeat call.
   */
  deactivate?(): Promise<void> | void;
}

export interface ExtensionFactory {
  create(): Promise<ExtensionAPI> | ExtensionAPI;
  /** Load disabled (the instance exists in the panel but registers nothing). */
  enabled?: boolean;
  /** Values exposed to the extension as `ctx.env`. */
  env?: Record<string, string>;
}

// ============================================================================
// Extension instance (internal)
// ============================================================================

/** Tracks everything an extension registered, so disabling can unregister it. */
export interface ExtensionRegistrations {
  /** Tool names registered by this extension. */
  tools: string[];
  /** Command names registered by this extension. */
  commands: string[];
  /** Unsubscribe callbacks for event-bus interceptors. */
  unsubInterceptors: Array<() => void>;
  /** Unsubscribe callbacks for observer subscriptions (`observe` / `observeAny`). */
  unsubObservers: Array<() => void>;
  /** Unsubscribe callbacks for turn-context providers. */
  unsubTurnContext: Array<() => void>;
  /** Per-registration model-output decorator disposers. */
  toolOutputDecoratorDisposers: Array<() => void>;
  /**
   * Extension ids holding a message transformer. Cleared on disable/destroy so a
   * disabled extension stops rewriting the wire.
   */
  messageTransformers: string[];
  /**
   * Awaited flush phase, run on teardown before core releases what the extension writes through.
   * One per extension (re-registration replaces it); cleared with the rest of the registrations.
   */
  flush: ((ctx?: ExtensionContext) => Promise<void> | void) | null;
  /** Synchronous exit-path flush, for hooks that cannot await. */
  exitFlush: (() => void) | null;
  /** Disposer for the process-wide exit registrations `exitFlush` was registered through. */
  exitFlushRef: (() => void) | null;
}

/**
 * What `activate` may return when it produced nothing.
 *
 * `void` means "activated normally". Returning this object is the extension telling the runner it is
 * LOADED but has no capability in this host: no isolate backend, no tools to expose, or turned off
 * by configuration. The runner then settles the instance as `inactive` with {@link inactive} as the
 * reason instead of `active` — an "enabled" row with zero tools was indistinguishable from a broken
 * feature, and the panel could not explain why `/code` was unavailable.
 *
 * Config-disabled extensions (`{ enabled: false }`) do not need this: the loader never calls
 * `activate` for them.
 */
export interface ExtensionActivation {
  inactive: string;
}

export interface ExtensionInstance {
  api: ExtensionAPI;
  context: ExtensionContext;
  state: "inactive" | "active" | "error";
  error?: Error;
  /**
   * Why this extension loaded but produced nothing (see {@link ExtensionActivation.inactive}).
   *
   * Distinct from `error`: nothing went wrong — the host cannot support the feature (no isolate
   * backend, no tools to expose) or configuration turned it off. Reported as its own field because
   * it renders as "not available, here is why", not as a red failure.
   */
  inactiveReason?: string;
  /** Artifacts this extension registered (used by enable/disable). */
  registrations: ExtensionRegistrations;
  /**
   * The config handed to `activate`, kept so a re-enable can build a fresh context for the new
   * incarnation (the context is the registration lease — see `ExtensionRunner.isContextLive`).
   */
  config?: ExtensionConfig;
  /**
   * Named sections registered at the last disable, retracted on the next successful enable.
   *
   * A section that produces no content on the enable turn has no other way to supersede its old
   * block, so the name list has to outlive the disable. It covers every registered name (not only
   * the ones with a disabled notice): a section without `disabledContent` can still have produced
   * content before the disable.
   */
  disabledSections?: string[];
  /**
   * Whether `activate` was ever entered for this instance.
   *
   * A load-declared-disabled (`enabled: false`) or invalid-id instance owns no resources, so
   * calling its `deactivate` at teardown would break the activate/deactivate pairing contract.
   */
  everActivated?: boolean;
  /**
   * In-flight teardown for one incarnation.
   *
   * Two teardown paths can overlap: a runtime disable of a hung activation runs `teardownIncarnation`
   * while the activation is still awaited, and the activation's own revocation path runs it again
   * once it resolves. Teardown is contractually idempotent, not re-entrant — a second concurrent
   * `deactivate()` can double-close a native handle — so later callers await this promise instead
   * of starting a second pass over the same incarnation.
   */
  teardownInFlight?: { incarnation: ExtensionContext; promise: Promise<void> };
}

/** Public, read-only description of a loaded extension (for management commands). */
export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Whether the extension is currently active (enabled) and running. */
  enabled: boolean;
  /** "active" | "error" | "inactive" */
  state: ExtensionInstance["state"];
  error?: string;
  /**
   * Set when the extension activated without producing anything (see
   * {@link ExtensionActivation.inactive}): the panel shows it as unavailable WITH the reason,
   * instead of claiming an "enabled" feature that registered no tool, command or section.
   */
  inactiveReason?: string;
  /**
   * Effective dispatch order for this extension — the declared `order`, or `0` when undeclared.
   * Reported so an ordering conflict is observable at runtime; see `extension-ordering`.
   */
  order: number;
  /**
   * The declared value, or `undefined` when the extension declared none. Distinguishes
   * "declared `0`" from "defaulted to `0`", which `order` alone cannot.
   */
  declaredOrder?: number;
  /** Tools this extension registered (when enabled). */
  tools: string[];
  /**
   * Commands this extension registered (when enabled), with whether each exposes
   * secondary-menu options and its human-readable description (so a headless host
   * can advertise them without reading the live `ExtensionCommand`).
   */
  commands: Array<{ name: string; hasOptions: boolean; description: string }>;
}

// ============================================================================
// Extension configuration
// ============================================================================

export interface ExtensionConfig {
  id: string;
  /**
   * Whether the extension is activated at load. `false` registers the instance without calling
   * `activate` (no tool/command/interceptor/section lands, and no disabled notice is injected: the
   * model never saw the extension, so there is nothing to retract); it can still be turned on later
   * through `setEnabled(id, true)`. Omitted means enabled.
   */
  enabled?: boolean;
  /**
   * The extension's own configuration map, exposed as `ctx.env`. Only string values are kept
   * (the field is a string map); everything else is dropped. Not a process-environment snapshot —
   * use `ctx.coreEnv.getEnv()` for the workspace environment.
   */
  config?: Record<string, unknown>;
}
