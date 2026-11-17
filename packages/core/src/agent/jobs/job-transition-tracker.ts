/**
 * Background-row transition bookkeeping for `job:changed`.
 *
 * The registry/ledger notifies with the CURRENT list, not a delta, and a unit's start and its
 * terminal status arrive in different notifications. Two facts therefore have to survive between
 * publishes, and they are the same fact seen twice — "this row id was last seen in state X, and the
 * run that first saw it was Y":
 *
 * - the previous status, so a transition can be reported once (and a terminal row observed for the
 *   first time is a RESTORED job, not news);
 * - the first-seen run, so a unit that outlives its turn is not attributed to whichever run happens
 *   to be current when it ends.
 *
 * Kept as a class because `ManagedAgent` is the composition root, not the owner of this state: the
 * two maps must be written, read and cleared together, and splitting them across the agent made
 * "clear both on session reset" a rule to remember in three places.
 */

import type { BackgroundWorkRow } from "./background-work.js";
import type { SessionJobStatus } from "../../runtime-types/session-payloads.js";

/** One row that moved since the previous publish. */
export interface BackgroundWorkTransition {
  /** The current row view (the caller reads kind/label/exitCode from it). */
  row: BackgroundWorkRow;
  /** The status this tracker last saw, absent on a row's first sighting. */
  previousStatus?: SessionJobStatus;
  /** Run that first observed the unit; omitted when it was first seen outside a run. */
  startedIn?: string;
}

export class JobTransitionTracker {
  private readonly lastStatus = new Map<string, SessionJobStatus>();
  private readonly startRuns = new Map<string, string>();

  /**
   * Record `rows` and return the transitions worth reporting, in list order.
   *
   * `currentRunId` is the run current at first sighting; it is captured once per row and never
   * updated, which is what pins a long-running unit to the turn that started it.
   */
  diff(rows: readonly BackgroundWorkRow[], currentRunId: string | null | undefined): BackgroundWorkTransition[] {
    const seen = new Set<string>();
    const transitions: BackgroundWorkTransition[] = [];
    for (const row of rows) {
      seen.add(row.jobId);
      const previousStatus = this.lastStatus.get(row.jobId);
      if (previousStatus === undefined && !this.startRuns.has(row.jobId) && currentRunId) {
        this.startRuns.set(row.jobId, currentRunId);
      }
      if (previousStatus === row.status) continue;
      this.lastStatus.set(row.jobId, row.status);
      // First observation of a terminal row = a restored job (its start predates this process).
      if (previousStatus === undefined && row.status !== "running") continue;
      const startedIn = this.startRuns.get(row.jobId);
      transitions.push({
        row,
        ...(previousStatus !== undefined ? { previousStatus } : {}),
        ...(startedIn ? { startedIn } : {}),
      });
    }
    // A row that left the list is forgotten entirely, so a reused id starts a fresh history.
    for (const id of [...this.lastStatus.keys()]) {
      if (seen.has(id)) continue;
      this.lastStatus.delete(id);
      this.startRuns.delete(id);
    }
    return transitions;
  }

  /** Drop every row's history (session reset / destroy). */
  clear(): void {
    this.lastStatus.clear();
    this.startRuns.clear();
  }

  /** Number of rows currently tracked (diagnostics/tests: "no residue after a reset"). */
  get size(): number {
    return this.lastStatus.size;
  }
}
