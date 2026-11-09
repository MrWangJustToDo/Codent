/**
 * The TASK source of the background-work trunk — a pure projection of `SubagentRuns`.
 *
 * It owns no state: the ledger rows (owner session, epoch, delivered flag, settled payload) live in
 * `SubagentRuns`, which is what makes the session-ownership rules identical to the command side. The
 * two sources are deliberately shaped like this:
 *
 * ```
 * agent/jobs/background-work.ts          the contract both implement (rows, completions, vocabulary)
 * agent/subagent/task-work-source.ts     this file: SubagentRuns -> the port
 * managers/services/agent-command-service.ts   the command source, which is a SERVICE because tools
 *                                              need it for start/poll/kill and a durable record
 * managers/services/background-work-service.ts the facade that merges both and owns the closing window
 * ```
 *
 * A background task's RUN mechanics (detached seat, write-back, repair, interrupted restore) are
 * `task-background.ts`; this module only answers the trunk's six questions about them.
 *
 * `list` / `pending` are non-creating: a session that never ran a background task must not pay for a
 * registry (the footer asks for the snapshot on a retained channel, so this runs on every frame).
 * `setChangeSink` is the one call that creates it, because a sink registered after the registry was
 * built would otherwise never reach it.
 */

import { settledTerminalStatus, TASK_JOB_KIND } from "../jobs/background-work.js";

import { peekSubagentRuns, subagentRuns } from "./subagent-runs.js";

import type { SubagentRuns } from "./subagent-runs.js";
import type { ManagedAgent } from "../../runtime-types/hosts.js";
import type { BackgroundWorkCompletion, BackgroundWorkRow, BackgroundWorkSource } from "../jobs/background-work.js";

export function createTaskWorkSource(managed: ManagedAgent): BackgroundWorkSource {
  let runs: SubagentRuns | undefined;
  /**
   * The epoch this source last synced with — what makes {@link reset} safe on a registry that
   * outlives the session.
   *
   * The command source does not need this: it OWNS its registry, so a reset just closes it. This
   * registry is cached per agent (`WeakMap`), so the same object serves the next session — and the
   * switch transaction already resets it (`clearTaskRuns`) before the facade reset runs, while the
   * facade reset itself may land much later (the command source's teardown awaits process kills).
   */
  let seenEpoch: number | undefined;
  const ensure = (): SubagentRuns => {
    const registry = (runs ??= subagentRuns(managed));
    seenEpoch ??= registry.currentEpoch;
    return registry;
  };
  const peek = (): SubagentRuns | undefined => runs ?? peekSubagentRuns(managed);

  return {
    kind: TASK_JOB_KIND,

    list(): BackgroundWorkRow[] {
      const registry = peek();
      if (!registry) return [];
      return registry.backgroundRows().map((run) => ({
        jobId: run.toolCallId,
        kind: TASK_JOB_KIND,
        label: run.label,
        status: run.status,
        // A task has no exit code. Kept as an explicit null (not omitted) so no consumer has to ask
        // which kind it is looking at before formatting the row.
        exitCode: null,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        pendingPickup: run.status !== "running" && !run.delivered,
      }));
    },

    async pending(): Promise<BackgroundWorkCompletion[]> {
      const registry = peek();
      if (!registry) return [];
      return registry.pendingBackground().map((run) => ({
        id: run.toolCallId,
        kind: TASK_JOB_KIND,
        // For a task the id IS the call id, so the notification needs no second line — but the field
        // is set for the same reason it is on the command side: the shared renderer decides.
        toolCallId: run.toolCallId,
        label: run.label,
        // `pendingBackground` only returns settled rows; the shared narrow is a guard, not a hope.
        status: settledTerminalStatus(run.status),
        exitCode: null,
        body: run.body ?? "",
      }));
    },

    markDelivered(completions: readonly BackgroundWorkCompletion[]): void {
      peek()?.markBackgroundDelivered(completions.map((completion) => completion.id));
    },

    reset(): void {
      const registry = peek();
      if (!registry) return;
      // The switch transaction resets this registry itself (`clearTaskRuns`), which bumps the epoch.
      // Seeing a different epoch here means a NEW session already owns the registry: resetting now
      // would wipe rows it opened (leaving a live task with no ledger row — its settle would then be
      // dropped whole, so no write-back, no notification, no wake). Skip instead of stealing it.
      if (seenEpoch !== undefined && registry.currentEpoch !== seenEpoch) {
        // Adopt the epoch we just observed, or every later reset on this registry keeps hitting
        // the same stale comparison and silently skips too.
        seenEpoch = registry.currentEpoch;
        return;
      }
      registry.reset();
      seenEpoch = registry.currentEpoch;
    },

    destroy(): void {
      peek()?.reset();
    },

    setChangeSink(sink): void {
      ensure().setChangeSink(sink);
    },
  };
}
