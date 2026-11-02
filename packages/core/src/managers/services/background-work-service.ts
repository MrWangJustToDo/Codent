/**
 * The one entry point for background work.
 *
 * Every question a host asks about background work — the `jobs` snapshot, the undelivered
 * completions, the session-switch cleanup, the destroy — is answered here by iterating
 * {@link BackgroundWorkSource}s. That is the whole point of the class: before it, "collect the
 * completions", "mark them delivered" and "publish the list" each had exactly one implementation
 * *for commands*, and a second kind would have needed a second copy of each (two wake paths, two
 * notification blocks, two channel writers). Those copies are the drift this exists to prevent.
 *
 * What the facade owns, and a source must not:
 *
 * - **Merging** the rows of every source into the single retained `session:jobs` snapshot.
 * - **The change decision**: a source reports `finished` ids; the facade turns that into one
 *   `(rows, finished)` publication, which the owning agent maps to the append-only `job:changed`
 *   rows, the channel emit and the idle wake.
 * - **Delivery bookkeeping framing**: `pending()` peeks, `markDelivered()` marks after the caller has
 *   persisted the notification. A source never decides when it is safe to mark.
 * - **The closing window**: a session switch publishes the empty list FIRST and only then resets the
 *   sources, so a source settling during the transaction cannot repopulate the channel of the
 *   session being left. Nothing reopens a closed facade — the owning agent drops it and builds a new
 *   one for the next session, exactly like the command registry it replaces.
 */

import type {
  BackgroundWorkCompletion,
  BackgroundWorkRow,
  BackgroundWorkSource,
} from "../../agent/jobs/background-work.js";
import type { SessionJobSummary } from "../../runtime-types/session-payloads.js";

/** One publication: the merged rows, plus which units just reached a terminal state. */
export interface BackgroundWorkChange {
  jobs: SessionJobSummary[];
  /** Ids that just ended. Empty for create / restore / eviction / clear — those are bookkeeping. */
  finished: string[];
}

export interface BackgroundWorkServiceOptions {
  /** The owning agent: emits `job:changed` / `session:jobs` and wakes on a non-empty `finished`. */
  onChange: (change: BackgroundWorkChange) => void;
  /**
   * A source failed at a bookkeeping step. Contained, never fatal: the facade keeps going and the
   * source's own state stays authoritative (an unmarkable completion simply stays `pending` and is
   * retried on the next pass).
   */
  onError?: (message: string, error: unknown) => void;
}

export class BackgroundWorkService {
  private readonly sources: BackgroundWorkSource[] = [];
  /** Set by {@link reset}: a settled source must not repopulate the channel after a switch. */
  private closing = false;

  constructor(private readonly options: BackgroundWorkServiceOptions) {}

  /**
   * Attach a source and route its change notifications through this facade.
   *
   * Registering on a closed facade is inert rather than refused: {@link publish} and
   * {@link markDelivered} are guarded by the same `closing` flag, so a source added after `reset()`
   * can report and mark without touching a channel or ledger that belong to the session being left.
   */
  register<TSource extends BackgroundWorkSource>(source: TSource): TSource {
    this.sources.push(source);
    source.setChangeSink((finished) => this.publish(finished));
    return source;
  }

  /** The merged row list — the retained `jobs` channel payload. */
  list(): BackgroundWorkRow[] {
    if (this.closing) return [];
    const rows: BackgroundWorkRow[] = [];
    for (const source of this.sources) rows.push(...source.list());
    return rows;
  }

  /**
   * Peek every source's undelivered completions (never marks — see {@link markDelivered}).
   *
   * A source that throws is contained: one kind failing must not cost the other its delivery.
   */
  async pending(): Promise<BackgroundWorkCompletion[]> {
    if (this.closing) return [];
    const pending: BackgroundWorkCompletion[] = [];
    for (const source of this.sources) {
      try {
        pending.push(...(await source.pending()));
      } catch (error) {
        this.options.onError?.(`${source.kind} completions unavailable`, error);
      }
    }
    return pending;
  }

  /**
   * Mark completions delivered, routed back to the source that produced each one.
   *
   * Per source, and isolated: a failure in one (a disk write behind the command ledger) must not skip
   * the other, whose completion the middleware already injected — skipping it would re-inject that
   * notification on every model call while the footer kept counting it as owed.
   */
  async markDelivered(completions: readonly BackgroundWorkCompletion[]): Promise<void> {
    if (completions.length === 0) return;
    // A closed facade belongs to the session being left; its sources are resetting, and marking a
    // completion there would mutate a ledger nobody reads again (and could resurrect a row).
    if (this.closing) return;
    const failures: Array<{ kind: string; error: unknown }> = [];
    for (const source of this.sources) {
      const mine = completions.filter((completion) => completion.kind === source.kind);
      if (mine.length === 0) continue;
      try {
        await source.markDelivered(mine);
      } catch (error) {
        failures.push({ kind: source.kind, error });
      }
    }
    for (const failure of failures) this.options.onError?.(`${failure.kind} delivery not recorded`, failure.error);
  }

  /**
   * Session switch / `/new`: the rows and the pending queue belong to the conversation being left.
   *
   * The empty publication comes FIRST and is unconditional: this is the "clear the channel, wake
   * nobody" transition (a switch is not a completion), and doing it before the async resets means a
   * source cannot win the race and re-publish into the target session.
   */
  async reset(reason: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.options.onChange({ jobs: [], finished: [] });
    // Started for every source in the SAME tick, then awaited together. Sequencing them (awaiting
    // one before invoking the next) would delay a cheap reset behind an expensive one — the command
    // source kills processes and flushes logs — and a delayed reset can land after the next session
    // has already opened work of its own.
    await Promise.all(this.sources.map(async (source) => source.reset(reason)));
  }

  /** Agent destroy. Un-notified terminal rows are the source's business (it decides what survives). */
  async destroy(): Promise<void> {
    this.closing = true;
    const sources = [...this.sources];
    this.sources.length = 0;
    await Promise.all(sources.map(async (source) => source.destroy()));
  }

  private publish(finished: readonly string[]): void {
    // The one guard a source cannot provide: a settle that lands mid-switch would repopulate the
    // channel of the session being left. `reset()` closes the facade before touching any source, so
    // anything arriving after that point is already too late to be valid.
    if (this.closing) return;
    this.options.onChange({ jobs: this.list(), finished: [...finished] });
  }
}
