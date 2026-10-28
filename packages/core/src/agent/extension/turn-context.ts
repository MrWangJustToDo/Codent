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
}

export class ExtensionTurnContext {
  private readonly providers = new Map<string, { provider: ExtensionContextProvider; rank: DispatchRank }>();
  /** Persistent notices keyed by extension id (captured at disable, cleared on re-enable). */
  private readonly disabledNotices = new Map<string, string>();
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
   * Emit `before_agent_start` (interceptors may append context), then run the registered providers.
   *
   * Each enabled extension with content becomes its own section (kind = id), ordered by declared
   * dispatch order so the sequence is declarable rather than load-determined. A throwing producer is
   * contained to its own section.
   */
  async collect(prompt: string, agentId: string): Promise<ExtensionPromptAppends> {
    const sessionId = this.deps.getSessionId();
    await this.deps.emitBeforeAgentStart({
      type: "before_agent_start",
      payload: { prompt, agentId, ...(sessionId ? { sessionId } : {}) },
      defaultReturn: undefined,
    });

    const turnContextSections: ExtensionTurnContextSection[] = [];
    const ordered = sortByDispatchRank(Array.from(this.providers, ([id, entry]) => ({ id, ...entry })));
    for (const { id, provider } of ordered) {
      const ctx = this.deps.getContext(id);
      try {
        const value = await provider.content?.(ctx);
        if (value?.trim()) turnContextSections.push({ id: this.sectionKind(id), content: value.trim() });
      } catch (err) {
        this.deps.reportFailure(id, "turn-context", errorMessage(err));
      }

      // Named sections: each is its own `<ctx kind="<id>:<name>">` block, so a change in one never
      // re-injects another.
      for (const [name, section] of this.normalizeSections(provider, id)) {
        try {
          const body = await section.content?.(ctx);
          if (body?.trim()) turnContextSections.push({ id: this.sectionKind(id, name), content: body.trim() });
        } catch (err) {
          this.deps.reportFailure(id, "turn-context", `section "${name}": ${errorMessage(err)}`);
        }
      }
    }

    // Disabled extensions speak under the same tag so the model knows their tools are gone
    // (symmetric to the enable-side section). Their providers were unsubscribed at disable, so an id
    // never appears in both loops.
    for (const [extensionId, notice] of this.disabledNotices) {
      if (notice.trim()) turnContextSections.push({ id: this.sectionKind(extensionId), content: notice.trim() });
    }
    for (const [id, notice] of this.sectionNotices) {
      if (notice.content.trim()) turnContextSections.push({ id, content: notice.content.trim() });
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
    produce: (() => Promise<string | undefined> | string | undefined) | undefined
  ): Promise<string | undefined> {
    if (!produce) return undefined;
    try {
      return (await produce()) ?? undefined;
    } catch (err) {
      const message = errorMessage(err);
      this.deps.log("warn", extensionId, `${source} disabledContent failed: ${message}`);
      this.deps.reportFailure(extensionId, "disable-notice", message);
      return undefined;
    }
  }

  /** Store (or, with an empty string, opt out of) the extension's disabled notice. */
  setDisabledNotice(extensionId: string, notice: string): void {
    const trimmed = notice.trim();
    if (trimmed) this.disabledNotices.set(extensionId, trimmed);
    else this.disabledNotices.delete(extensionId);
  }

  /** Store one named section's disabled notice (body is trimmed; empty is ignored). */
  setSectionNotice(extensionId: string, sectionName: string, content: string): void {
    const trimmed = content.trim();
    if (trimmed) this.sectionNotices.set(this.sectionKind(extensionId, sectionName), { extensionId, content: trimmed });
  }

  /** Drop every notice belonging to one extension (re-enable / duplicate replacement). */
  clearNotices(extensionId: string): void {
    this.disabledNotices.delete(extensionId);
    for (const [key, entry] of this.sectionNotices) {
      if (entry.extensionId === extensionId) this.sectionNotices.delete(key);
    }
  }

  /** Full teardown. */
  clear(): void {
    this.providers.clear();
    this.disabledNotices.clear();
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
      if (!SECTION_NAME_RE.test(section.name)) {
        this.warnOnce(provider, extensionId, `invalid context section name "${section.name}" — skipped`);
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
    return name ? `${EXTENSION_KIND_PREFIX}${extensionId}:${name}` : `${EXTENSION_KIND_PREFIX}${extensionId}`;
  }
}
