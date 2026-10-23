/**
 * Responsive plan for the workspace panel header bar (`WorkspaceModeHeader`).
 *
 * The bar is a single line holding up to five groups — agent activity, view mode (+ root path),
 * git branch (+ sha / ahead-behind), and the workspace diff summary. Every group is a `<Text>`,
 * and Ink boxes default to `flexShrink: 1`, so a narrow terminal does not drop anything: Yoga
 * shrinks **each** child to a fraction of its width and the renderer truncates inside every one
 * of them. The result reads as corruption rather than as a smaller header — `Workspace` becomes
 * `Worksp`, `/Users/me/repo` vanishes behind `diff ·`, and `1 files +0 −1` becomes `1 +−1`.
 *
 * So the bar has to decide what it can afford instead of letting flexbox squeeze all of it. The
 * decision is a pure function of the content widths and the available columns, which is why it
 * lives here (tested in `test/workspace-header-layout.test.mjs`) rather than in the component:
 * the component measures nothing, it only renders the plan.
 *
 * Degradation order — least informative first:
 *   1. the sha (branch already identifies HEAD well enough),
 *   2. ahead/behind counters,
 *   3. the changed-file count (the `+a −d` totals are what people act on),
 *   4. the root path's leading directories (keep its last segment),
 *   5. the diff totals,
 *   6. the path entirely.
 * The title, the view mode and the branch survive every step: a header without them says nothing.
 */

import { textDisplayWidth } from "./user-message-lines.js";

// ============================================================================
// Types
// ============================================================================

/** How much of the workspace root path to show. */
export type WorkspacePathDetail = "full" | "basename" | "none";

/** Which optional groups the bar may render at the given width. */
export interface WorkspaceHeaderPlan {
  busy: boolean;
  path: WorkspacePathDetail;
  sha: boolean;
  sync: boolean;
  files: boolean;
  diffs: boolean;
}

/** Pre-formatted group contents; the component only decides colors. */
export interface WorkspaceHeaderContent {
  /** Agent activity label, e.g. `● running`; `null` when idle. */
  busy: string | null;
  /** View mode, e.g. `preview` / `diff`. */
  mode: string;
  /** Workspace root path. */
  path: string;
  /** Branch label, including the dirty marker (`main*`). */
  branch: string | null;
  /** Short HEAD sha. */
  shortSha: string | null;
  /** Ahead/behind counters, e.g. `↑1 ↓2`. */
  sync: string | null;
  /** Changed-file count label, e.g. `3 files`. */
  files: string | null;
  /** Added-line total, e.g. `+12`. */
  added: string | null;
  /** Deleted-line total, e.g. `−3`. */
  deleted: string | null;
}

/** Columns available to the bar's content (terminal width minus its horizontal padding). */
export type WorkspaceHeaderWidth = number;

// ============================================================================
// Plan
// ============================================================================

/** Group separator (` · `) between two adjacent header groups. */
const SEPARATOR = " · ";

/** Fixed prefix of every plan: the title. */
const TITLE = "Workspace";

/** Rendered width of the bar for a plan, mirroring the component's group order. */
export function workspaceHeaderWidth(content: WorkspaceHeaderContent, plan: WorkspaceHeaderPlan): number {
  const groups: string[] = [TITLE];
  if (plan.busy && content.busy) groups.push(content.busy);

  const pathDetail = content.path ? plan.path : "none";
  const pathText = pathDetail === "full" ? content.path : pathDetail === "basename" ? basename(content.path) : "";
  groups.push(pathText ? `${content.mode}${SEPARATOR}${pathText}` : content.mode);

  if (content.branch) {
    let branch = content.branch;
    if (plan.sha && content.shortSha && !branch.includes(content.shortSha)) branch += ` ${content.shortSha}`;
    if (plan.sync && content.sync) branch += ` ${content.sync}`;
    groups.push(branch);
  }

  if (plan.diffs && (content.files || content.added || content.deleted)) {
    const totals = [plan.files ? content.files : null, content.added, content.deleted].filter(Boolean).join(" ");
    if (totals) groups.push(totals);
  }

  return groups.reduce((sum, group) => sum + textDisplayWidth(group), 0) + SEPARATOR.length * (groups.length - 1);
}

/**
 * Pick the richest plan that fits `available` columns.
 *
 * `available <= 0` means the terminal size is not known yet (the size store starts at 0 before its
 * first measurement): keep everything and let the caller render normally, so the bar does not
 * flash its most degraded form on startup. Content that is absent never widens the bar — the
 * ladder only removes groups the current workspace actually has.
 */
export function planWorkspaceHeader(
  content: WorkspaceHeaderContent,
  available: WorkspaceHeaderWidth
): WorkspaceHeaderPlan {
  const ladder: WorkspaceHeaderPlan[] = [
    { busy: true, path: "full", sha: true, sync: true, files: true, diffs: true },
    { busy: true, path: "full", sha: false, sync: true, files: true, diffs: true },
    { busy: true, path: "full", sha: false, sync: false, files: true, diffs: true },
    // The path identifies the workspace; the file count is the first thing to give up for it.
    { busy: true, path: "full", sha: false, sync: false, files: false, diffs: true },
    { busy: true, path: "basename", sha: false, sync: false, files: false, diffs: true },
    { busy: true, path: "basename", sha: false, sync: false, files: false, diffs: false },
    { busy: true, path: "none", sha: false, sync: false, files: false, diffs: false },
  ];

  if (available <= 0) return ladder[0]!;
  return ladder.find((plan) => workspaceHeaderWidth(content, plan) <= available) ?? ladder[ladder.length - 1]!;
}

/** Last path segment — the informative half of a root path on a narrow terminal. */
function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}
