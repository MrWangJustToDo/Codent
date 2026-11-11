/**
 * Extension turn-context: the per-turn `<ctx kind="ext:…">` sections, the providers behind them, and
 * the "this extension is disabled" notices that replace them.
 *
 * Split out of `ExtensionRunner` because it is a self-contained lifecycle of its own:
 *
 *   - **providers** are registered/unregistered by activation (rank-ordered, one per extension);
 *   - **collection** runs once per turn and is per-producer isolated — one failing section costs
 *     that section, not the turn;
 *   - **notices** are captured at DISABLE time (the provider is unsubscribed moments later) and
 *     injected every turn afterwards, so the model keeps knowing the extension's tools are gone.
 *
 * The section kind is `ext:<extensionId>[:<sectionName>]`. The prefix keeps extension kinds out of
 * the core catalog's namespace: an extension whose id happened to be `current_date` used to publish
 * the *same* admission slot as the core date section, so the two replaced one another every turn and
 * one producer silently never persisted.
 */

import { errorMessage } from "../../utils/errors.js";
import { sortByDispatchRank } from "../dispatch-order.js";

import { EXTENSION_CALLBACK_TIMEOUT_MS, withCallbackTimeout } from "./callback-timeout.js";

import type { DispatchRank } from "../dispatch-order.js";
import type {
  BeforeAgentStartEvent,
  ExtensionContext,
  ExtensionContextProvider,
  ExtensionContextSectionProvider,
  ExtensionPromptAppends,
  ExtensionTurnContextSection,
} from "./types.js";

/** Allowed section names — interpolated into `<ctx kind="id:name">`, whose recovery splits on space. */
const SECTION_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const EXTENSION_KIND_PREFIX = "ext:";

/**
 * The `<ctx kind>` an extension section is admitted under.
 *
 * Exported because the controller that STRIPS a disabled extension's sections from a mid-turn
 * snapshot has to recompute the same id. It used to spell `ext:${extensionId}` itself, so changing
 * the prefix or separator would silently stop matching — the snapshot kept telling the model to
 * call tools that had just disappeared.
 */
export function extensionSectionKind(extensionId: string, name?: string): string {
  return name ? `${EXTENSION_KIND_PREFIX}${extensionId}:${name}` : `${EXTENSION_KIND_PREFIX}${extensionId}`;
}

export interface ExtensionTurnContextDeps {
  /** Live session id, read per turn (a resumed session must not carry the previous one). */
  getSessionId: () => string | null;
  /** The live context of an extension (undefined once disabled). */
  getContext: (extensionId: string) => ExtensionContext | undefined;
  /** Interceptable, ordered `before_agent_start` emission. */
  emitBeforeAgentStart: (event: BeforeAgentStartEvent) => Promise<void>;
  /** Producer failures converge on `agent:extension-error` (never a bare console write). */
  reportFailure: (extensionId: string, phase: "turn-context" | "disable-notice", error: string) => void;
  log: (level: "warn", extensionId: string, message: string) => void;
  /** A hook-level failure that belongs to no extension (its `hook` is not an extension id). */
  logLifecycle: (level: "warn", hook: string, message: string) => void;
  /** Bound for one callback; defaults to {@link EXTENSION_CALLBACK_TIMEOUT_MS}. */
  callbackTimeoutMs?: number;
}

export class ExtensionTurnContext {
  private readonly providers = new Map<string, { provider: ExtensionContextProvider; rank: DispatchRank }>();
  /**
   * Persistent lifecycle notices keyed by extension id.
   *
   * A disable writes the disabled notice here; a re-enable writes an "enabled again" notice under
   * the SAME kind, so the new block supersedes the old one (admission is per-kind and stateless).
   * Without the retraction an extension with no base `content` (memory, jobs) stayed "disabled" in
   * the model window forever, because only a newly produced section could supersede its old block.
   */
  private readonly statusNotices = new Map<string, string>();
  /** Notices for named sections, keyed by the section kind and stamped with its owner. */
  private readonly sectionNotices = new Map<string, { extensionId: string; content: string }>();
  /** Providers already warned about a bad/duplicate section name (one row, not one per turn). */
  private readonly warnedProviders = new WeakSet<object>();

  constructor(private readonly deps: ExtensionTurnContextDeps) {}

  // ==========================================================================
  // Providers
  // ==========================================================================

  /** Register one extension's provider; the disposer is identity-checked. */
  register(extensionId: string, provider: ExtensionContextProvider, rank: DispatchRank): () => void {
    const previous = this.providers.get(extensionId)?.provider;
    if (previous !== undefined && previous !== provider) {
      // One provider per extension — a second registration REPLACES the first, unlike commands
      // (warned) and duplicate section names (warned). Composing two providers used to lose one
      // with no diagnostic at all.
      this.deps.log("warn", extensionId, "context provider re-registered — the earlier provider is replaced");
    }
    this.providers.set(extensionId, { provider, rank });
    return () => {
      if (this.providers.get(extensionId)?.provider === provider) this.providers.delete(extensionId);
    };
  }

  hasProvider(extensionId: string): boolean {
    return this.providers.has(extensionId);
  }

  /** The registered provider (the disable path reads `disabledContent` from it before teardown). */
  providerOf(extensionId: string): ExtensionContextProvider | undefined {
    return this.providers.get(extensionId)?.provider;
  }

  // ==========================================================================
  // Collection (once per turn)
  // ==========================================================================

  /**
   * Emit `before_agent_start` (interceptors observe the prompt; they cannot append context), then run
   * the registered providers.
   *
   * Each enabled extension with content becomes its own section (kind = id), ordered by declared
   * dispatch order so the sequence is declarable rather than load-determined. A throwing producer is
   * contained to its own section.
   */
  async collect(prompt: string, agentId: string): Promise<ExtensionPromptAppends> {
    const sessionId = this.deps.getSessionId();
    // A hung interceptor must not hang the turn: the emission is awaited (a handler that warms an
    // index has to finish before the first model call), so it needs the same bound every other
    // extension callback has. The failure is logged, not attributed to one extension — the timeout
    // cannot say which handler never settled.
    try {
      await this.bound(
        this.deps.emitBeforeAgentStart({
          type: "before_agent_start",
          payload: { prompt, agentId, ...(sessionId ? { sessionId } : {}) },
          defaultReturn: undefined,
        }),
        "before_agent_start"
      );
    } catch (err) {
      this.deps.logLifecycle("warn", "before_agent_start", errorMessage(err));
    }

    const turnContextSections: ExtensionTurnContextSection[] = [];
    const ordered = sortByDispatchRank(Array.from(this.providers, ([id, entry]) => ({ id, ...entry })));
    for (const { id, provider } of ordered) {
      // The provider snapshot was taken before the loop; an `await` above (another provider's
      // content) gives a concurrent disable time to run. Calling the producer with no context made
      // it throw and reported a phantom `agent:extension-error` on every turn until it was removed.
      const ctx = this.deps.getContext(id);
      if (!ctx) continue;
      try {
        const value = await this.bound(
          Promise.resolve(provider.content?.(ctx)),
          `extension "${id}" context`,
          provider.timeoutMs
        );
        if (value?.trim()) turnContextSections.push({ id: this.sectionKind(id), content: value.trim() });
      } catch (err) {
        this.deps.reportFailure(id, "turn-context", errorMessage(err));
      }

      // Named sections: each is its own `<ctx kind="<id>:<name>">` block, so a change in one never
      // re-injects another. Normalization is inside the per-provider containment: `sections` is
      // runtime data from arbitrary JS, and a malformed entry used to throw out of `collect()` and
      // drop EVERY extension's sections for the turn (silently, with no `agent:extension-error`).
      let named: Map<string, ExtensionContextSectionProvider>;
      try {
        named = this.normalizeSections(provider, id);
      } catch (err) {
        this.deps.reportFailure(id, "turn-context", `sections: ${errorMessage(err)}`);
        continue;
      }
      for (const [name, section] of named) {
        try {
          const body = await this.bound(
            Promise.resolve(section.content?.(ctx)),
            `extension "${id}" section "${name}"`,
            section.timeoutMs ?? provider.timeoutMs
          );
          if (body?.trim()) turnContextSections.push({ id: this.sectionKind(id, name), content: body.trim() });
        } catch (err) {
          this.deps.reportFailure(id, "turn-context", `section "${name}": ${errorMessage(err)}`);
        }
      }
    }

    // Disabled extensions speak under the same tag so the model knows their tools are gone
    // (symmetric to the enable-side section). Their providers were unsubscribed at disable, so an
    // id normally appears in only one loop; a lifecycle notice is skipped when the enabled
    // provider already produced that exact kind this turn (the real content wins).
    for (const [extensionId, notice] of this.statusNotices) {
      const kind = this.sectionKind(extensionId);
      if (!notice.trim() || turnContextSections.some((section) => section.id === kind)) continue;
      turnContextSections.push({ id: kind, content: notice.trim() });
    }
    for (const [id, notice] of this.sectionNotices) {
      if (!notice.content.trim() || turnContextSections.some((section) => section.id === id)) continue;
      turnContextSections.push({ id, content: notice.content.trim() });
    }

    return { turnContextSections };
  }

  // ==========================================================================
  // Disabled notices
  // ==========================================================================

  /**
   * Capture a disabled notice without letting a failing producer block the disable.
   *
   * A broken extension is the one that most needs disabling, so its own notice producer must not be
   * able to reject `setEnabled` and leave it active with no rollback. The failure is reported and the
   * caller's generic notice is used instead.
   */
  async captureDisabledNotice(
    extensionId: string,
    source: string,
    produce: (() => Promise<string | undefined> | string | undefined) | undefined,
    timeoutMs?: number
  ): Promise<string | undefined> {
    if (!produce) return undefined;
    try {
      // The disable path awaits this before unregistering, so a producer that never settles would
      // leave `pendingToggles` locked and the extension impossible to disable — the one state a
      // broken extension must never be able to create.
      //
      // `timeoutMs === 0` means "no wall-clock bound" for per-turn CONTENT (a producer bounded by
      // the run signal). It must NOT carry into the disable path: that path is awaited before the
      // lease is revoked, so honouring `0` here is exactly the un-disableable state described
      // above. Fall back to the callback timeout instead — `bound()` treats `undefined` as the
      // runner default.
      return (
        (await this.bound(
          Promise.resolve(produce()),
          `extension "${extensionId}" disabled notice`,
          timeoutMs === 0 ? undefined : timeoutMs
        )) ?? undefined
      );
    } catch (err) {
      // One report, not two: `reportFailure` already emits `agent:extension-error`, which the log
      // bridge writes as a row. Logging here as well produced a duplicate line for one failure.
      this.deps.reportFailure(extensionId, "disable-notice", errorMessage(err));
      return undefined;
    }
  }

  /** Store (or, with an empty string, opt out of) the extension's disabled notice. */
  setDisabledNotice(extensionId: string, notice: string): void {
    const trimmed = notice.trim();
    if (trimmed) this.statusNotices.set(extensionId, trimmed);
    else this.statusNotices.delete(extensionId);
  }

  /**
   * Store the "enabled again" retraction.
   *
   * `sectionNames` are the named sections that were announced at disable time: each gets a neutral
   * body under its own kind, so a section that does not produce content immediately is still
   * retracted (the model reads "ignore the earlier disabled notice" instead of a stale "the
   * extension is gone").
   */
  setEnabledNotice(extensionId: string, notice: string, sectionNames: readonly string[] = []): void {
    const trimmed = notice.trim();
    if (trimmed) this.statusNotices.set(extensionId, trimmed);
    for (const name of sectionNames) {
      const key = this.sectionKind(extensionId, name);
      this.sectionNotices.set(key, {
        extensionId,
        content: `The "${name}" section of extension "${extensionId}" is enabled again; ignore its earlier disabled notice.`,
      });
    }
  }

  /** Store one named section's disabled notice (body is trimmed; empty is ignored). */
  setSectionNotice(extensionId: string, sectionName: string, content: string): void {
    const trimmed = content.trim();
    if (trimmed) this.sectionNotices.set(this.sectionKind(extensionId, sectionName), { extensionId, content: trimmed });
  }

  /** Drop every notice belonging to one extension (re-enable / duplicate replacement). */
  clearNotices(extensionId: string): void {
    this.statusNotices.delete(extensionId);
    for (const [key, entry] of this.sectionNotices) {
      if (entry.extensionId === extensionId) this.sectionNotices.delete(key);
    }
  }

  /** Drop every lifecycle notice (session switch), keeping registered providers intact. */
  clearAllNotices(): void {
    this.statusNotices.clear();
    this.sectionNotices.clear();
  }

  /** Full teardown (provider registrations included). */
  clear(): void {
    this.providers.clear();
    this.statusNotices.clear();
    this.sectionNotices.clear();
  }

  // ==========================================================================
  // Section identity
  // ==========================================================================

  /**
   * Validate and dedupe a provider's named sections. One implementation for both the enable path
   * (`collect`) and the disable path: the disable path used to interpolate `section.name` verbatim,
   * so an invalid name produced a `<ctx kind="id:bad name>x">` shell whose identity recovery split on
   * whitespace, and a `>` in the name closed the tag early.
   */
  normalizeSections(
    provider: ExtensionContextProvider,
    extensionId: string
  ): Map<string, ExtensionContextSectionProvider> {
    const byName = new Map<string, ExtensionContextSectionProvider>();
    for (const section of provider.sections ?? []) {
      // Runtime shape validation: extensions are arbitrary JS, so a null/primitive entry or a
      // non-string name must be skipped per entry rather than aborting the whole collection.
      if (!section || typeof section.name !== "string" || !SECTION_NAME_RE.test(section.name)) {
        this.warnOnce(
          provider,
          extensionId,
          `invalid context section name "${String((section as { name?: unknown } | null)?.name)}" — skipped`
        );
        continue;
      }
      if (byName.has(section.name)) {
        this.warnOnce(provider, extensionId, `duplicate context section "${section.name}" — the last one wins`);
      }
      byName.set(section.name, section);
    }
    return byName;
  }

  /** One warning per provider, not one per turn (a duplicate name would otherwise log every turn). */
  private warnOnce(provider: object, extensionId: string, message: string): void {
    if (this.warnedProviders.has(provider)) return;
    this.warnedProviders.add(provider);
    this.deps.log("warn", extensionId, message);
  }

  private sectionKind(extensionId: string, name?: string): string {
    return extensionSectionKind(extensionId, name);
  }

  private callbackTimeoutMs(): number {
    return this.deps.callbackTimeoutMs ?? EXTENSION_CALLBACK_TIMEOUT_MS;
  }

  /**
   * Apply a provider's declared bound, or the runner default.
   *
   * `0` means "no wall-clock bound" and is deliberately explicit: a producer that runs a model
   * completion is already bounded by the run signal (`ctx.signal`), and a fixed wall clock turned a
   * legitimately slow completion into a per-turn `agent:extension-error`.
   */
  private bound<T>(promise: Promise<T>, label: string, timeoutMs?: number): Promise<T> {
    if (timeoutMs === 0) return promise;
    return withCallbackTimeout(promise, label, timeoutMs ?? this.callbackTimeoutMs());
  }
}
