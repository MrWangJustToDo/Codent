/**
 * Process-local disk-session ownership.
 *
 * A persisted session id may be held by at most one live root agent in this manager. The table is
 * intentionally not persisted: a crashed process leaves no stale owner. It is also per-manager, so
 * two runtimes over the same workspace do not see each other's claims (the store's `reservedAt`
 * only covers reuse of an empty session).
 */

export class SessionOwnership {
  private readonly owners = new Map<string, string>();

  /** Claim `sessionId` for `agentId`; idempotent for the same agent. */
  acquire(sessionId: string, agentId: string): boolean {
    const owner = this.owners.get(sessionId);
    if (owner !== undefined && owner !== agentId) return false;
    this.owners.set(sessionId, agentId);
    return true;
  }

  /** Release only when the claim belongs to this agent. */
  release(sessionId: string, agentId: string): void {
    if (this.owners.get(sessionId) === agentId) {
      this.owners.delete(sessionId);
    }
  }

  /** Destroy path: drop every claim held by this agent, including a stale pre-fix leak. */
  releaseAllFor(agentId: string): void {
    for (const [sessionId, owner] of this.owners) {
      if (owner === agentId) this.owners.delete(sessionId);
    }
  }

  /** Diagnostic/test accessor. */
  ownerOf(sessionId: string): string | undefined {
    return this.owners.get(sessionId);
  }
}
