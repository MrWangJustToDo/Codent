/**
 * The workspace panel's two refresh-related behaviours that a git poll must not break.
 *
 * The panel learns about the agent's writes from ONE place — `useWorkspaceGit`'s 10s poll — while
 * the tree's rows and the pane's contents come from several module caches that only the manual `r`
 * refresh clears. Two defects came out of that split, and both are pinned here because both were
 * silent (the panel kept rendering, it just rendered the wrong thing):
 *
 *   1. A file created inside an already-listed directory had no ROW. The status only decorates rows
 *      that exist, so `docs/ [2M]` raised its count while the new file was absent from the tree —
 *      and `[` / `]` still selected it, so the jump changed the preview while the cursor had nowhere
 *      to land and nothing scrolled. It read as the key being dead until `r` re-listed everything.
 *
 *   2. Every poll replaced the git status with a NEW `Map`, which rebuilt the row list, which re-ran
 *      the reveal effect, whose `select` action rewrote the cursor — so a tick pulled the cursor
 *      back to the selected file and discarded wherever ↑/↓ had put it.
 *
 * The evidence is read from the component's own state, not from a screenshot: the cursor's row is
 * read back by pressing `Enter`, which selects `items[cursorIndex]`. No frame scraping, so this is
 * headless — unlike `validate:render-smoke`, which needs the renderer's erase/repaint path.
 *
 * Driven by `validate-workspace-refresh-check.mjs`, which bundles this file's imports into one graph
 * and gates the ~40s run behind `WATCH_WORKSPACE_REFRESH=1`.
 */
import { registerCoreEnv } from "@codent/core";
import { createElement } from "@my-react/react";
import { render } from "@my-react/react-terminal";
import { EventEmitter } from "node:events";
import path from "node:path";
import { Readable } from "node:stream";
import { configureEnv } from "reactivity-store";

import { WorkspaceFileMode } from "./dist/components/WorkspaceFileMode.mjs";
import { CoreEnvProvider } from "./dist/context/core-env-context.mjs";
import { useSize } from "./dist/hooks/use-size.mjs";
import { useWorkspaceGit } from "./dist/hooks/use-workspace-git.mjs";
import { useWorkspacePanel } from "./dist/hooks/use-workspace-panel.mjs";
import { parseGitStatusZ } from "./dist/utils/workspace-git-paths.mjs";

configureEnv({ allowNonBrowserUpdates: true });

// ── fixture ──────────────────────────────────────────────────────────────────
//
// One nested directory (`docs/`) and two files at the workspace root. The nesting is what symptom 1
// needs — a write INSIDE a directory the panel has already listed — while the root-level files give
// symptom 2 two ADJACENT FILE ROWS, which matters because the cursor is read back with `Enter` and
// `Enter` on a directory row toggles it instead.

const ROOT = "/fixture";

/** rel path → content. Mutated mid-run to simulate the agent's writes. */
const files = new Map([
  ["a.ts", "a\n"],
  ["b.ts", "b\n"],
  ["docs/readme.md", "# hi\n"],
]);

const dirsOf = (dir) => {
  const out = new Set();
  for (const rel of files.keys()) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const full = path.posix.join(ROOT, parts.slice(0, i).join("/"));
      if (path.posix.dirname(full) === dir) out.add(path.posix.basename(full));
    }
  }
  return [...out];
};

const entriesOf = (dir) => {
  const out = [];
  for (const name of dirsOf(dir)) out.push({ name, type: "directory" });
  for (const rel of files.keys()) {
    const full = path.posix.join(ROOT, rel);
    if (path.posix.dirname(full) === dir) out.push({ name: path.posix.basename(full), type: "file" });
  }
  return out;
};

/** The git payload as the panel's own parser expects it (`-z`, `XY <path>` records). */
const statusPayload = () =>
  [...files.keys()]
    .map((rel) => ` M ${rel}`)
    .join("\0")
    .concat("\0");

const runCommand = async (cmd) => {
  const ok = (stdout) => ({ stdout, stderr: "", exitCode: 0, durationMs: 1 });
  if (cmd.startsWith("git status --porcelain -z")) return ok(statusPayload());
  if (cmd.startsWith("git status --porcelain")) return ok([...files.keys()].map((rel) => ` M ${rel}`).join("\n"));
  if (cmd.startsWith("git status -sb")) return ok("## main\n");
  if (cmd.startsWith("git diff HEAD --numstat -z")) {
    return ok(
      [...files.keys()]
        .map((rel) => `1\t0\t${rel}`)
        .join("\0")
        .concat("\0")
    );
  }
  if (cmd.startsWith("git rev-parse --is-inside-work-tree")) return ok("true\n");
  if (cmd.startsWith("git rev-parse --abbrev-ref")) return ok("main\n");
  if (cmd.startsWith("git rev-parse --short")) return ok("abc1234\n");
  if (cmd.startsWith("git show HEAD:")) {
    return ok(files.get(cmd.slice(cmd.indexOf(":") + 1).replace(/^'|'$/g, "")) ?? "");
  }
  return ok("");
};

/**
 * The workspace env the panel reads from `<CoreEnvProvider>` (`useCoreEnv` throws without it).
 * `registerCoreEnv` also installs it as the ambient env for any core-side code path.
 */
const env = {
  rootPath: ROOT,
  path: path.posix,
  getPlatform: async () => "linux",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => "/home",
  runCommand,
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => new Response(""),
  fs: {
    readFile: async (p) => {
      const rel = p.startsWith(`${ROOT}/`) ? p.slice(ROOT.length + 1) : p;
      const content = files.get(rel);
      if (content === undefined) throw new Error(`ENOENT ${p}`);
      return content;
    },
    stat: async () => ({ isDirectory: false, isFile: true, size: 1, mtime: new Date() }),
    readdir: async (p) => entriesOf(p),
    writeFile: async () => {},
    mkdir: async () => {},
    exists: async (p) => p === ROOT || files.has(p.slice(ROOT.length + 1)),
    remove: async () => {},
  },
};
registerCoreEnv(env);

// ── the panel, mounted in a fake terminal ────────────────────────────────────

class FakeStdout extends EventEmitter {
  columns = 120;
  rows = 32;
  isTTY = true;
  chunks = [];
  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }
  getColorDepth() {
    return 24;
  }
}

function fakeStdin() {
  const stdin = new Readable({ read() {} });
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  return stdin;
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Longer than `GIT_REFRESH_INTERVAL_MS` (10s) plus the async fetches a tick runs. */
const PAST_REFRESH_TICK_MS = 12_000;

// The host calls this at bootstrap; without it `screenWidth` is 0 and the panel's layout degenerates.
useSize.getActions().init();
useSize.getReactiveState().state.screenWidth = 120;
useSize.getReactiveState().state.screenHeight = 32;

const stdin = fakeStdin();
const instance = render(createElement(CoreEnvProvider, { value: env }, createElement(WorkspaceFileMode, null)), {
  stdout: new FakeStdout(),
  stdin,
  exitOnCtrlC: false,
  patchConsole: false,
  maxFps: 30,
});

const press = async (seq, wait = 250) => {
  stdin.push(seq);
  await settle(wait);
};

const selected = () => useWorkspacePanel.getReadonlyState().selectedPath;
const paneFocus = () => useWorkspacePanel.getReadonlyState().paneFocus;
const mode = () => useWorkspacePanel.getReadonlyState().mode;
const statusEntries = () => parseGitStatusZ(statusPayload()).size;

/**
 * Read back the tree cursor by its row: `←` puts the focus on the tree pane (a no-op there) and
 * `Enter` selects `items[cursorIndex]`.
 *
 * `Enter` is a no-op when the cursor is ALREADY on the selected row, which is the distinction this
 * reports: `onSelectedRow: true` means "the cursor is on the selected row", `moved: true` means "the
 * cursor sits elsewhere — specifically on `after`". Every row these sections touch is a file, so the
 * other `Enter` no-op (a directory row is toggled instead of selected) does not occur.
 */
const readCursor = async () => {
  await press("\u001B[D");
  const before = selected();
  await press("\r");
  const after = selected();
  // Enter moved the focus to the preview pane; put it back so the next ⇅ reaches the tree.
  await press("\u001B[D");
  return { before, after, moved: before !== after, onSelectedRow: before === after };
};

/** Walk with `[` / `]` until `target` is selected. Bounded, so a dead key fails instead of hanging. */
const jumpTo = async (target, direction = "]") => {
  for (let i = 0; i < 12; i++) {
    await press(direction);
    if (selected() === target) return true;
  }
  return false;
};

// ── results ─────────────────────────────────────────────────────────────────

const results = [];
const record = (name, pass, detail) => results.push({ name, pass, detail });

// ── 1. a file created inside an already-listed directory gets a row ─────────

useWorkspacePanel.getActions().open();
await settle(900);

// Visiting `docs/readme.md` expands `docs/` and lists it, which is the state symptom 1 needs: the
// directory's entries are cached, so a plain git poll has no reason to re-read it.
const listedDocs = await jumpTo(path.posix.join(ROOT, "docs/readme.md"));
record("the fixture's nested file is reachable from the start", listedDocs, { selection: selected() });

// The agent's write: a NEW file inside `docs/`, which the panel has already listed.
files.set("docs/new.md", "# new\n");
const newFile = path.posix.join(ROOT, "docs/new.md");

await settle(PAST_REFRESH_TICK_MS);

const jumpLanded = await jumpTo(newFile);
record("`]` reaches the file the agent created (its git status is known)", jumpLanded, {
  selection: selected(),
  statusEntries: statusEntries(),
});

const cursorOnNewRow = jumpLanded ? await readCursor() : null;
record(
  "the cursor lands on the new file's ROW (the interval re-listed the directory)",
  Boolean(cursorOnNewRow?.onSelectedRow),
  { cursor: cursorOnNewRow, expected: newFile }
);

// ── 2. the manual `r` still agrees with the interval ────────────────────────

await press("r", 700);
const jumpAfterR = await jumpTo(newFile);
const cursorAfterR = jumpAfterR ? await readCursor() : null;
record("`r` keeps the same reachable row set", jumpAfterR && Boolean(cursorAfterR?.onSelectedRow), {
  selection: selected(),
  cursor: cursorAfterR,
  mode: mode(),
});

// ── 3. a tick that rebuilds the rows keeps the cursor where the user put it ──
//
// Two shapes of "the row list was rebuilt": a poll that finds nothing new, and a poll that finds a
// real change. They exercise different fixes. With the worktree unchanged the git status keeps its
// reference (Fix 2), so the rows are not rebuilt at all; the cursor can only be lost when the rows
// DO change, which is what the second half forces. Each half rebuilds its own precondition, because
// reading the cursor back presses `Enter` — which selects the cursor's row and would otherwise leak
// a selection into the next half.

// Diff mode derives its rows straight from the git status, so it is the mode where a poll rebuilds
// the row list. `a.ts` and `b.ts` are adjacent FILE rows there, so one `↓` is a resolvable read.
await press("\t");
await settle(300);

const setupCursorOff = async () => {
  const landed = await jumpTo(path.posix.join(ROOT, "a.ts"));
  await press("\u001B[D"); // focus the tree (a jump leaves it on the preview)
  await press("\u001B[B"); // ↓ off the selected row
  return landed;
};

const selectedA = await setupCursorOff();

// Nothing is edited on purpose: the tick alone must not move the cursor.
await settle(PAST_REFRESH_TICK_MS);

const cursorAfterIdleTick = await readCursor();
record(
  "an idle refresh tick does not pull the cursor back to the selected file",
  selectedA && cursorAfterIdleTick.moved && cursorAfterIdleTick.after !== path.posix.join(ROOT, "a.ts"),
  { cursor: cursorAfterIdleTick, selectedFile: path.posix.join(ROOT, "a.ts"), mode: mode(), focus: paneFocus() }
);

// ── 4. a tick that DOES change the list keeps the cursor too ────────────────
//
// The list-building half: the agent creates a file, so the poll writes a genuinely new status, the
// rows are rebuilt, and the reveal effect runs with a real new row list. Only the cursor-
// realignment gate (Fix 3) can hold the cursor there — which is why the two fixes need separate
// assertions rather than one cursor check that either could satisfy.

const selectedA2 = await setupCursorOff();

files.set("c.ts", "c\n");
await settle(PAST_REFRESH_TICK_MS);

const cursorAfterRealChange = await readCursor();
record(
  "a tick that ADDS a changed file does not pull the cursor back to the selected file either",
  selectedA2 && cursorAfterRealChange.moved && cursorAfterRealChange.after === path.posix.join(ROOT, "b.ts"),
  { cursor: cursorAfterRealChange, selectedFile: path.posix.join(ROOT, "a.ts"), mode: mode() }
);

record("the panel still renders the fixture's rows", statusEntries() > 0, {
  selection: selected(),
  statusEntries: statusEntries(),
});

instance.unmount();

// ── 5. an unchanged poll keeps the git status REFERENCE ─────────────────────
//
// A poll that finds the worktree unchanged must keep the previous `Map`: replacing an equal map
// rebuilds the diff tree's rows, and every row list rebuilt is a new array that re-runs the row-
// identity consumers. This reports the identity directly, so the rule is pinned independently of
// whether the cursor outcome (sections 3-4) also happens to hold.

// The probe records its reading in this module-scoped binding, which this file reads across the 10s
// tick without re-rendering anything. One module graph, so no global object is needed.
let probeReading = null;

const IdentityProbe = () => {
  const { gitStatus, statusVersion } = useWorkspaceGit(ROOT);
  probeReading = { gitStatus, statusVersion };
  return null;
};

const probeStdin = fakeStdin();
const probe = render(createElement(CoreEnvProvider, { value: env }, createElement(IdentityProbe, null)), {
  stdout: new FakeStdout(),
  stdin: probeStdin,
  exitOnCtrlC: false,
  patchConsole: false,
  maxFps: 30,
});

await settle(600);
const firstRead = probeReading;
await settle(PAST_REFRESH_TICK_MS);
const secondRead = probeReading;

probe.unmount();

record(
  "a poll with no edit keeps the SAME git status reference (no row-list churn)",
  firstRead.gitStatus === secondRead.gitStatus && secondRead.statusVersion > firstRead.statusVersion,
  {
    sameReference: firstRead.gitStatus === secondRead.gitStatus,
    versionBefore: firstRead.statusVersion,
    versionAfter: secondRead.statusVersion,
    entries: secondRead.gitStatus.size,
  }
);

const pass = results.every((result) => result.pass);
console.log(JSON.stringify({ results, pass }, null, 2));
process.exit(pass ? 0 : 1);
