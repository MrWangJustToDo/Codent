/**
 * A one-way "do not write this session" latch.
 *
 * Separate from a restore's nesting pause (`SessionService.pausePersist` / `resumePersist`) on
 * purpose. That pause exists for the duration of a load and is released by the commit; this latch
 * means the session's in-memory state can no longer be trusted at all, so the next adoption is the
 * only event that clears it.
 *
 * The one producer is a failed `/resume` whose recovery ALSO failed: `restoreManagedSession` applies
 * the target's model / effort / plan / approvals before the commit, and re-running the same load
 * against the departure is what undoes that. When that re-load fails, the live host names one
 * session and carries the other's settings — persisting it would overwrite the departure's record
 * (and every later resume would read the wrong model / phase / approval table back). An unsaved
 * conversation is recoverable; a silently rewritten one is not.
 */
export class PersistGate {
  private blocked = false;

  block(): void {
    this.blocked = true;
  }

  /** Cleared only by an adoption (`SessionService.setSessionData`), never by a nesting release. */
  clear(): void {
    this.blocked = false;
  }

  isBlocked(): boolean {
    return this.blocked;
  }
}
