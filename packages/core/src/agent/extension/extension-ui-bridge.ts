/**
 * The per-extension view of the shared extension UI, plus the context snapshot it reads.
 *
 * `DefaultExtensionUI` owns slots / throttling / dedupe; this module owns the two things on top of
 * that which are *runner* policy rather than UI policy:
 *
 *  - **context assembly** — the snapshot is retained bus state overlaid with host overrides, and it
 *    is pushed (throttled) when the state it reads changes, so an extension never polls;
 *  - **ownership** — a render is attributed to the extension that made it, and a subscription is
 *    contained and tracked so disabling an extension stops delivery.
 *
 * Split out of `runner.ts` because it is one closed subject with a narrow dependency surface (the
 * bus, the runner options, and the failure reporter), and the runner is otherwise a registration /
 * lifecycle orchestrator.
 */

import { DefaultExtensionUI } from "./default-extension-ui.js";

import type { ExtensionRegistrations, ExtensionRenderPayload, ExtensionUI, ExtensionUiContext } from "./types.js";
import type { AgentEventBus } from "../agent-event-bus";

/** Trailing window for coalescing context pushes (ms). */
const CONTEXT_THROTTLE_MS = 250;

/** The runner facts this bridge reads. */
export interface ExtensionUiBridgeOptions {
  /** The scoped bus: retained state in, `extension:ui` notifications out. */
  bus: AgentEventBus;
  /** Host-supplied overrides for the snapshot; omitted fields fall back to retained state. */
  getUiContext?: () => Partial<ExtensionUiContext>;
  /** Live session facts (session name) for the snapshot. */
  getSessionName?: () => string | null;
  /** Workspace root reported in the snapshot. */
  cwd?: string;
  /** Report a throwing / rejecting UI subscription against its extension. */
  reportFailure: (extensionId: string, error: unknown, source: string) => void;
}

export interface ExtensionUiBridge {
  /** The shared UI facade (host surface). */
  readonly ui: DefaultExtensionUI;
  /** Snapshot assembled on demand. */
  getContext(): ExtensionUiContext;
  /** Retained slots (surface → key → payload) for late-subscriber reconciliation. */
  getSlots(): Readonly<Record<string, Record<string, ExtensionRenderPayload>>>;
  /** The view one extension sees: renders attributed to it, subscriptions contained and tracked. */
  wrap(ownerId: string, registrations?: ExtensionRegistrations, isLive?: () => boolean): ExtensionUI;
  /** Drop every slot rendered by one extension (disable / destroy). */
  clearOwner(ownerId: string): void;
  /** Drop every slot (full teardown). */
  clearAll(): void;
  /** Release context-push subscriptions and the pending timer. */
  dispose(): void;
}

export function createExtensionUiBridge(options: ExtensionUiBridgeOptions): ExtensionUiBridge {
  const { bus } = options;

  const buildContext = (): ExtensionUiContext => {
    const override = options.getUiContext?.();
    const state = bus.retainedValue("agent:state");
    const usage = bus.retainedValue("session:usage");
    const mode = bus.retainedValue("session:mode");

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
      workspace: override?.workspace ?? { root: options.cwd ?? "", branch: null },
      sessionName: override?.sessionName ?? options.getSessionName?.() ?? null,
      mode: override?.mode ?? mode?.mode ?? null,
    };
  };

  const ui = new DefaultExtensionUI(bus, buildContext);

  // Coalesced push so subscribers see changes without polling.
  let contextTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleContextPush = (): void => {
    if (contextTimer) return;
    contextTimer = setTimeout(() => {
      contextTimer = null;
      try {
        ui.emitEvent({ type: "context", context: ui.getContext() });
      } catch {
        // Failure contained: context pushes are best-effort.
      }
    }, CONTEXT_THROTTLE_MS);
    (contextTimer as { unref?: () => void }).unref?.();
  };

  const contextUnsubs: Array<() => void> = [];
  for (const type of ["agent:state", "session:usage", "session:mode"] as const) {
    contextUnsubs.push(bus.on(type, () => scheduleContextPush(), { replay: false }));
  }

  return {
    ui,
    getContext: () => buildContext(),
    getSlots: () => ui.getSlots(),
    wrap: (ownerId, registrations, isLive) => ({
      notify: (message, level) => {
        if (isLive && !isLive()) return;
        ui.notify(message, level);
      },
      subscribe: (type, handler) => {
        // A disabled extension's late `subscribe` must not keep a listener alive for the session:
        // the same lease every other registration checks.
        if (isLive && !isLive()) return () => {};
        // Containment first: `Emitter` swallows only synchronous throws, so an `async` handler's
        // rejection would escape to `unhandledRejection` — and the CLI's process guards turn that
        // into `exit(1)`. Tracking second: an untracked subscription keeps delivering to a disabled
        // extension.
        const contained = (payload: unknown): void => {
          try {
            const result = (handler as (data: unknown) => unknown)(payload);
            if (result && typeof (result as Promise<unknown>).then === "function") {
              void (result as Promise<unknown>).catch((err: unknown) =>
                options.reportFailure(ownerId, err, "extension:ui")
              );
            }
          } catch (err) {
            options.reportFailure(ownerId, err, "extension:ui");
          }
        };
        const unsub = ui.subscribe(type, contained);
        registrations?.unsubObservers.push(unsub);
        return unsub;
      },
      render: (surface, key, payload) => {
        if (isLive && !isLive()) return;
        ui.render(surface, key, payload, ownerId);
      },
      getContext: () => ui.getContext(),
    }),
    clearOwner: (ownerId) => ui.clearSlotsByOwner(ownerId),
    clearAll: () => ui.clearAllSlots(),
    dispose: () => {
      if (contextTimer) {
        clearTimeout(contextTimer);
        contextTimer = null;
      }
      for (const unsub of contextUnsubs) unsub();
      contextUnsubs.length = 0;
    },
  };
}
