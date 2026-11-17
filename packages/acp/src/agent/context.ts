/**
 * The state one ACP app owns, handed to every registration module.
 *
 * `createAcpAgent` used to be a single 1,300-line closure, which meant every helper was a local
 * `const` and nothing could be reached from outside it. The seams are now modules; what they share
 * is this object — the connection doors (`emit` / `client`), the handshake's capabilities, the
 * session map, and the three collaborators that own a subject of their own (construction,
 * selectors, interactions).
 *
 * A module takes the whole context rather than a hand-picked dependency list only when it needs
 * several of these; a module that needs one thing imports that thing.
 */

import type { ConfigSelectors } from "./config-options.js";
import type { AcpAgentOptions } from "./options.js";
import type { SessionBridgeRegistry } from "./session-bridge.js";
import type { SessionCreation } from "./session-creation.js";
import type { InteractionHandlers } from "../interaction/interactions.js";
import type { SessionUpdate } from "../wire/types.js";
import type { AgentApp, AgentContext, ClientCapabilities } from "@agentclientprotocol/sdk";

export interface AcpAgentContext {
  readonly app: AgentApp;
  readonly options: AcpAgentOptions;
  /** The process root: the default `cwd`, and the only root a `--system` override applies to. */
  readonly rootPath: string;
  readonly version: string;
  /**
   * Disk session id → workspace root it belongs to.
   *
   * `session/delete` has no `cwd` (`DeleteSessionRequest` is just an id), so the root has to be
   * remembered from the operation that first saw the session. Without this, deleting a session that
   * belongs to a foreign root went through the process-root store: the live agent was destroyed but
   * the file stayed, and ACP reported success.
   */
  readonly sessionRoots: Map<string, string>;
  /** Send one `session/update` notification under a handle. */
  emit: (acpId: string, update: SessionUpdate) => void;
  /** The agent-side connection handle (throws before `connect`). */
  client: () => AgentContext;
  /** Client capabilities from `initialize`, when the handshake has run. */
  capabilities: () => ClientCapabilities | undefined;
  setCapabilities: (next: ClientCapabilities | undefined) => void;
  readonly bridges: SessionBridgeRegistry;
  readonly interactions: InteractionHandlers;
  readonly creation: SessionCreation;
  readonly config: ConfigSelectors;
}
