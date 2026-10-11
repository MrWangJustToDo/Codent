/**
 * Package-internal runner / adapter / UI wiring for `ManagedAgent`.
 *
 * These four fields are one cluster, not four: the cached `AgentRunner` is only
 * valid for the config it was built from, so every change to the tool set, model
 * or system prompt has to invalidate the cache *before* the next run reads it.
 * Keeping the fields and that rule in one place is what makes "changing the tools
 * without dropping the cached runner" unexpressible rather than merely discouraged.
 *
 * The runner is memoized per {@link RunnerWiring.getRunnerConfigKey}, and the key
 * is derived from the frozen system prompt + model style + the tool set (see
 * `run-agent.ts`) — so the key and the runner must move together, which is the
 * second reason they are not spread across the class body.
 *
 * Extracted from `ManagedAgent` (architecture debt P1-15). The host interface is
 * the codebase's standard seam shape (see `managed-agent-compact.ts`): pass
 * `() => value` accessors, not `this`, so the module has no dependency on the
 * composition root and can be validated on its own.
 */

import type { AgentEventBus } from "../agent/agent-event-bus";
import type { AgentRunner } from "../agent/runner/agent-runner.js";
import type { AgentUIChannel } from "../agent/ui/ui-channel.js";
import type { TextAdapterConfig } from "../models/adapter/adapter-factory.js";

/** What {@link RunnerWiring} needs from the agent that owns it. */
export interface RunnerWiringHost {
  /**
   * The scoped event bus to project the channel's `session:messages` onto, when one
   * is attached. A channel that never gets a bus never reaches its AgentSession
   * `messages` channel — which is how a subagent preview channel created by
   * `ensureUIChannel` would silently never surface.
   */
  getEventBus: () => AgentEventBus | undefined;
  /** Called when an approval request arrives on the channel (see the subscription below). */
  onApprovalRequest: (request: { approvalId?: string; toolCallId?: string }) => void;
}

/**
 * Runner cache + adapter + UI channel for one agent.
 *
 * `setUIChannel` is not a plain assignment because the channel carries an
 * approval-request subscription with the previous channel's lifetime: without the
 * explicit unsubscribe, rebinding the channel (resume, subagent re-attach) leaves
 * the old channel's listener registered, and approvals then arrive twice.
 */
export class RunnerWiring {
  private runner?: AgentRunner;
  private runnerConfigKey?: string;
  private textAdapter?: TextAdapterConfig;
  private uiChannel?: AgentUIChannel;
  private approvalRequestUnsub?: () => void;

  constructor(private readonly host: RunnerWiringHost) {}

  // --- Runner (memoized per config key) ---

  getRunner(): AgentRunner | undefined {
    return this.runner;
  }

  setRunner(runner: AgentRunner | undefined): void {
    this.runner = runner;
  }

  getRunnerConfigKey(): string | undefined {
    return this.runnerConfigKey;
  }

  setRunnerConfigKey(key: string | undefined): void {
    this.runnerConfigKey = key;
  }

  /** Drop the cached runner + its key (tools / plan phase / prompt changed). */
  invalidateRunner(): void {
    this.runner = undefined;
    this.runnerConfigKey = undefined;
  }

  // --- Text adapter ---

  getTextAdapter(): TextAdapterConfig | undefined {
    return this.textAdapter;
  }

  setTextAdapter(adapter: TextAdapterConfig | undefined): void {
    this.textAdapter = adapter;
  }

  // --- UI channel (+ its approval subscription) ---

  getUI(): AgentUIChannel | undefined {
    return this.uiChannel;
  }

  /** Wire chat / subagent UI channel. Detaches the previous channel's approval subscription. */
  setUIChannel(ui: AgentUIChannel | undefined): void {
    this.approvalRequestUnsub?.();
    this.approvalRequestUnsub = undefined;
    this.uiChannel = ui;
    if (!ui) return;
    // The bus is attached here (not by the owner) because it is the *channel* that
    // needs it, and only this method knows a new channel just arrived.
    const bus = this.host.getEventBus();
    if (bus) ui.setEventBus(bus);
    this.approvalRequestUnsub = ui.subscribeApprovalRequests((request) => {
      if (!request.approvalId || !request.toolCallId) return;
      this.host.onApprovalRequest(request);
    });
  }

  /** Release the approval subscription without touching the channel (destroy path). */
  detachUIChannel(): void {
    this.approvalRequestUnsub?.();
    this.approvalRequestUnsub = undefined;
  }
}
