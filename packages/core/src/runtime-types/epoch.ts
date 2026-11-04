/**
 * One captured "is this operation still current?" token.
 *
 * The control plane used to answer that question with several independent mechanisms — a run
 * token, a chat-controller lifecycle counter, a UI-channel session generation, a session-switch
 * flag, and per-call-site session-id snapshots. They all describe the same thing at different
 * granularities, and every new async path had to choose one and re-implement the check.
 *
 * `Epoch` composes the existing sources and exposes three predicates. The split is deliberate, so
 * each predicate matches the contract it replaces instead of being stricter and silently dropping
 * legitimate work:
 *
 * - `isCurrent()` — the captured SESSION generation is still live. This is the exact contract of
 *   the old captured-session-id guards (title/memory usage) and of the stream terminal write
 *   (`captureSessionStaleness` used the generation only: a switch is ADMITTED before it stops the
 *   run, and in that window the run still owns its terminal write — treating the admission as
 *   staleness swallowed real stream errors).
 * - `isStable()` — `isCurrent()` and no switch is in flight. For work that must not be written
 *   into EITHER transcript while a switch is being prepared (a disk read, an injection computed
 *   across the switch window).
 * - `isRunCurrent()` — `isCurrent()`, the captured lifecycle generation is unchanged, and the
 *   captured run token (if any) is still current. For a writer that must not outlive its run.
 *
 * A token captured outside a run stays run-current when a later run starts: there was no run to
 * supersede, and a session-scoped operation must not be cancelled by an unrelated turn.
 */

/** Structural run-token identity; the concrete token lives in `RunCoordinator`. */
export interface EpochRunToken {
  readonly id: number;
  readonly isCurrent: boolean;
}

export interface Epoch {
  readonly sessionGeneration: number;
  readonly lifecycleGeneration: number;
  /** The captured run token's id, or null when captured outside a run (diagnostics). */
  readonly runTokenId: number | null;
  /** Same session generation (a stream's own run still owns its terminal write). */
  isCurrent(): boolean;
  /** `isCurrent()` and no session switch is in flight. */
  isStable(): boolean;
  /** `isCurrent()`, same lifecycle generation, and the captured run token (if any) is current. */
  isRunCurrent(): boolean;
}

/**
 * The live readings an {@link Epoch} captures.
 *
 * `isSessionSwitching` is deliberately NOT part of {@link Epoch.isCurrent}: the switch is admitted
 * before it stops the run, and a run that is being stopped still owns its terminal write. Use
 * {@link Epoch.isStable} where the pre-commit window must also be excluded.
 */
export interface EpochGenerations {
  getSessionGeneration(): number;
  getLifecycleGeneration(): number;
  getRunToken(): EpochRunToken | null;
  isSessionSwitching?: () => boolean;
}

/** Anything that can mint an epoch (the agent runtime is the production implementation). */
export interface EpochSource {
  capture(): Epoch;
}

export function createEpoch(source: EpochGenerations): Epoch {
  const sessionGeneration = source.getSessionGeneration();
  const lifecycleGeneration = source.getLifecycleGeneration();
  const token = source.getRunToken();

  const isCurrent = (): boolean => source.getSessionGeneration() === sessionGeneration;
  const isLifecycleCurrent = (): boolean => source.getLifecycleGeneration() === lifecycleGeneration;

  return {
    sessionGeneration,
    lifecycleGeneration,
    runTokenId: token?.id ?? null,
    isCurrent,
    isStable: () => isCurrent() && source.isSessionSwitching?.() !== true,
    isRunCurrent: () => isCurrent() && isLifecycleCurrent() && (token === null || token.isCurrent),
  };
}
