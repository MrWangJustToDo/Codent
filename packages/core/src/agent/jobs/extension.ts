/**
 * Built-in Jobs extension — keeps background command jobs visible in the footer.
 *
 * A `run_in_background` job outlives the `run_command` call that started it, and its output
 * deliberately does not stream onto the `tool` channel. So without a surface of its own a job
 * that runs for minutes is invisible until someone polls it — and its *end* is invisible
 * entirely to anything that cannot reach {@link CommandJobRegistry} (an extension, a remote
 * client): there is nothing to subscribe to.
 *
 * Core therefore pushes the list — the registry notifies its owning agent, which emits
 * `session:jobs` (retained, projected onto the session `jobs` channel) — and this extension
 * renders ONE line into the `footer` surface:
 *
 *     ⏳ 2 running · 1 failed · 2m 14s
 *
 * (rendered ANSI-styled: an amber glyph, the counts in bright-black gray — see {@link AMBER} /
 * {@link GRAY})
 *
 * The payload crosses a process boundary for remote sessions, so it stays a plain JSON string.
 * Two deliberate shapes, both cheap:
 *
 * - **Elapsed time is the only thing here that changes without an event**, so a 1s tick runs
 *   only while some job is running and is stopped the moment none is. `render` slots already
 *   dedupe identical payloads (`default-extension-ui.ts`), so a tick's cost is this summarizer,
 *   never a host repaint — and the timer is `unref`'d plus cleared in `deactivate()`, so it can
 *   neither hold a host process open nor outlive the extension.
 * - **The slot is removed as soon as nothing is running.** The list arrives as one retained
 *   snapshot, and a one-line summary has no item to dim, so a finished job's outcome would
 *   otherwise outlive the fact it reports. Outcomes are already carried where they belong: the
 *   transcript row and the completion notification. Output stays reachable via
 *   `get_command_output` / the job's log file.
 */

import { formatDuration } from "../tools/presentation/format/format.js";

import type { SessionJobSummary } from "../../runtime-types/session-payloads.js";
import type { ExtensionAPI } from "../extension/types.js";

// ============================================================================
// Render shape
// ============================================================================

/** Footer surface + slot key (see `ctx.ui.render`). */
const SURFACE = "footer";
const SLOT = "jobs";

/** Elapsed-time refresh cadence while a job is running (ms). */
const TICK_MS = 1000;

/**
 * ANSI styling for the line.
 *
 * Core cannot reach the host's theme palette (the app layer depends on core, never the reverse),
 * so the color has to travel inside the payload — which the host renderer deliberately preserves
 * (`sanitizeAnsi` keeps SGR while stripping destructive sequences).
 *
 * - `90` (bright black) instead of a hex color deliberately follows the *user's* terminal theme,
 *   which a hardcoded `#8B949E` would not, and it keeps the line at the same weight as the muted
 *   footer it sits in (a bare payload would inherit the terminal's default foreground — usually
 *   the brightest thing in the theme).
 * - The glyph carries the "in progress" cue by itself, so the counts stay quiet rather than the
 *   whole row competing with the transcript.
 *
 * A trailing reset is mandatory, not cosmetic: the payload is rendered inline by the host, so an
 * unterminated SGR would bleed the color into the surrounding footer.
 */
const AMBER = "\u001b[33m";
const GRAY = "\u001b[90m";
const RESET = "\u001b[0m";

/**
 * Order counts appear in — busiest concern first. `exited` is deliberately absent: it is the
 * uninteresting outcome, so a mixed line reads `2 running · 1 failed` rather than burying the
 * failure behind every success.
 */
const COUNT_ORDER = ["running", "failed", "killed"] as const;

/**
 * One-line summary for the current list, or `null` when the slot must be removed (nothing is
 * running). ANSI-styled: amber glyph, bright-black counts, reset-terminated.
 *
 * Elapsed time is the oldest *running* job's age — the number the user is waiting on. Finished
 * jobs are not counted into it, so a long-dead completion cannot inflate the line.
 */
export function summarizeJobs(jobs: readonly SessionJobSummary[], now: number): string | null {
  const counts: Record<SessionJobSummary["status"], number> = { running: 0, exited: 0, killed: 0, failed: 0 };
  let oldestRunningStartedAt = Number.POSITIVE_INFINITY;
  for (const job of jobs) {
    counts[job.status] += 1;
    if (job.status === "running" && job.startedAt < oldestRunningStartedAt) {
      oldestRunningStartedAt = job.startedAt;
    }
  }
  if (counts.running === 0) return null;

  const parts = COUNT_ORDER.filter((status) => counts[status] > 0).map((status) => `${counts[status]} ${status}`);
  parts.push(formatDuration(now - oldestRunningStartedAt));
  return `${AMBER}⏳${RESET} ${GRAY}${parts.join(" · ")}${RESET}`;
}

// ============================================================================
// Extension factory
// ============================================================================

/**
 * Create the built-in Jobs extension.
 *
 * Has no tools and no turn-context section: it is pure presentation, so it costs the model
 * nothing and never invalidates the prompt prefix.
 */
export function createJobsExtension(): ExtensionAPI {
  let jobs: SessionJobSummary[] = [];
  let tick: ReturnType<typeof setInterval> | null = null;
  let lastLine: string | null = null;

  const stopTick = (): void => {
    if (tick === null) return;
    clearInterval(tick);
    tick = null;
  };

  return {
    id: "codent-jobs",
    name: "Jobs",
    version: "1.0.0",
    description: "Background command jobs: a one-line running summary in the footer surface",
    activate(ctx) {
      // Redraw from the current list; `render(null)` clears the slot (and is a no-op on an
      // absent slot, so an empty state costs no notification).
      const paint = (): void => {
        const line = summarizeJobs(jobs, Date.now());
        if (line === lastLine) return;
        lastLine = line;
        ctx.ui.render(SURFACE, SLOT, line);
      };

      // The tick exists only to age the elapsed time; it never re-reads the job list.
      const syncTick = (): void => {
        if (!jobs.some((job) => job.status === "running")) {
          stopTick();
          return;
        }
        if (tick !== null) return;
        tick = setInterval(paint, TICK_MS);
        // Never keep a host process alive just to age a footer line.
        (tick as { unref?: () => void }).unref?.();
      };

      // Retained, so a session that already has running jobs paints on the first frame instead
      // of waiting for the next transition.
      ctx.events.observe("session:jobs", (event) => {
        jobs = event.payload.jobs;
        syncTick();
        paint();
      });
    },
    /**
     * The timer is the one resource that must not outlive the extension. Clearing the observer is
     * the runner's job, but a surviving `setInterval` would keep calling `ctx.ui.render` on a
     * released extension — in a long-lived host (the server backing `--remote-session`) that is a
     * timer that runs for the life of the process to age a footer line nobody can see. Idempotent,
     * so it is safe on every teardown path (destroy, disable, re-enable).
     */
    deactivate() {
      stopTick();
      jobs = [];
      lastLine = null;
    },
  };
}
