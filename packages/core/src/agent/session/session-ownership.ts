/**
 * Process-local disk-session ownership.
 *
 * A persisted session id may be held by at most one live root agent **per workspace**. The table is
 * intentionally not persisted: a crashed process leaves no stale owner.
 *
 * Scope is the workspace for a local env, not the `AgentManager`. Two runtimes over the same
 * workspace write the same `.session.jsonl`, so with a per-manager table both could claim the id and
 * then interleave their transcripts (the store's save lock serializes the bytes, not the
 * conversation). A remote env is scoped per connection instead: its `rootPath` is a path inside
 * someone else's filesystem and two servers commonly use the same string. A manager without a
 * runtime keeps a private table, since nothing tells it which workspace it belongs to.
 *
 * The local table is bounded by the number of workspaces a process opens, the remote one is weak,
 * and claims are released by the normal destroy/resume paths — neither grows with sessions.
 */

import type { ResolvedCoreEnv } from "../../env";

/** One table per local workspace. A local env is the same disk for every runtime with that root. */
const sharedLocalByRoot = new Map<string, SessionOwnership>();

/**
 * A remote env is one client connection, not one workspace. Two servers may report the same
 * `rootPath` (`/workspace` is a common container path) while being different filesystems, so a
 * claim must not be shared between them; identity of the resolved env is the only discriminator
 * available. Sharing within one runtime still works because `runtime.env` is resolved once.
 */
const sharedRemoteByEnv = new WeakMap<object, SessionOwnership>();

/**
 * Remote claims keyed by the SERVER's identity (`CoreEnv.remoteKey`), when the host supplies one.
 *
 * This is the fix for "two clients of one server": object identity made `createRemoteEnv(url)`
 * called twice look like two workspaces, so both runtimes claimed the same session id and
 * interleaved its transcript — the exact collision the local table prevents.
 */
const sharedRemoteByKey = new Map<string, SessionOwnership>();

/** The shared ownership table for one workspace. */
export function sharedSessionOwnership(env: ResolvedCoreEnv, identity: object = env): SessionOwnership {
  if (env.remote === true) {
    // The server's identity when the host supplies one, else this client object. Two clients of
    // one server must share the table (same filesystem, same session ids); two different servers
    // must not, even though both report `/workspace`.
    if (env.remoteKey !== undefined) {
      let ownership = sharedRemoteByKey.get(env.remoteKey);
      if (!ownership) {
        ownership = new SessionOwnership();
        sharedRemoteByKey.set(env.remoteKey, ownership);
      }
      return ownership;
    }
    let ownership = sharedRemoteByEnv.get(identity);
    if (!ownership) {
      ownership = new SessionOwnership();
      sharedRemoteByEnv.set(identity, ownership);
    }
    return ownership;
  }
  let ownership = sharedLocalByRoot.get(env.rootPath);
  if (!ownership) {
    ownership = new SessionOwnership();
    sharedLocalByRoot.set(env.rootPath, ownership);
  }
  return ownership;
}

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
