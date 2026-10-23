/* eslint-disable max-lines */
/**
 * Headless render smoke for the long-session transcript (MessageList + StaticRender).
 *
 * Replaces the "manual TUI check" step: this environment has no interactive TTY (ink needs
 * raw mode, so `render()` against process.stdout throws headlessly), but ink accepts
 * injected stdin/stdout streams. This script mounts the REAL `MessageList` + `Content`
 * subtree into a fake terminal and asserts what the manual pass was for — the static row
 * set stays capped, the hidden-count marker matches reality and paints once, the row
 * count holds across window slides, and a compact->full switch leaves no residue.
 *
 * Everything is imported from ONE bundle (`scripts/render-smoke/dist`) so the stores and
 * the components that read them share an instance. Importing `src` through a second entry
 * would resolve two copies of each store and produce false failures.
 *
 * Run: pnpm --filter @codent/app run validate:render-smoke
 *      node scripts/render-smoke/run.mjs [session.jsonl]
 *
 * Renderer and React are imported here by their REAL package names, not the bare `react` /
 * `ink` the source writes: the app has no such dependencies (its package.json points those
 * names at the forks, and only the pnpm aliases `f8a7c83` removed ever made them resolve
 * in-repo). Importing the forks directly is what `tsdown.config.ts`'s rewrite plugin emits
 * for `src`, so this module and the bundle share ONE renderer and ONE React — and therefore
 * one hook dispatcher.
 *
 * Getting this wrong does not fail loudly. Importing real React alongside a fork-based bundle
 * surfaces as `Cannot read properties of null (reading 'useMemo')`, because the components
 * write to one dispatcher while this module's `createElement` established the other. The
 * render still "works", it just throws per component — so the failure reads as a dozen
 * unrelated frame assertions rather than as two bad imports.
 */

import "./neutralize-ci-env.mjs";

import { createElement, useState } from "@my-react/react";
import { render } from "@my-react/react-terminal";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { Readable } from "node:stream";

import { awaitStableMarker } from "./await-stable-marker.mjs";
import { checks as budgetChecks } from "./budget-fixtures.mjs";
import { ConfigEditor } from "./dist/components/ConfigEditor.mjs";
import { ExitSummary } from "./dist/components/ExitSummary.mjs";
import { MessageList, selectVisibleRows, MAX_STATIC_LINES } from "./dist/components/MessageList.mjs";
import { SessionPicker, MAX_VISIBLE_SESSIONS } from "./dist/components/SessionPicker.mjs";
import { SubagentPanel } from "./dist/components/SubagentPanel.mjs";
import { WorkspaceImagePreview } from "./dist/components/WorkspaceImagePreview.mjs";
import { WorkspaceModeHeader } from "./dist/components/WorkspaceModeHeader.mjs";
import { CoreEnvProvider } from "./dist/context/core-env-context.mjs";
import { InputScopeProvider } from "./dist/context/input-scope-context.mjs";
import { StaticContext } from "./dist/context/static-context.mjs";
import { useExitInput, useMainInput, useWorkspacePanelInput } from "./dist/hooks/input/index.mjs";
import { useAgentStatus } from "./dist/hooks/use-agent-status.mjs";
import { useAgent } from "./dist/hooks/use-agent.mjs";
import { useDiffRenderer } from "./dist/hooks/use-diff-renderer.mjs";
import { useDynamic } from "./dist/hooks/use-dynamic.mjs";
import { useFlattenCacheCleanup } from "./dist/hooks/use-flatten-cache-cleanup.mjs";
import { useSize } from "./dist/hooks/use-size.mjs";
import { useStaticHeights } from "./dist/hooks/use-static-heights.mjs";
import { useStatic } from "./dist/hooks/use-static.mjs";
import { useSubagentPanel } from "./dist/hooks/use-subagent-panel.mjs";
import { useTheme } from "./dist/hooks/use-theme.mjs";
import { useTranscriptDisplay } from "./dist/hooks/use-transcript-display.mjs";
import { useWorkspaceInfo } from "./dist/hooks/use-workspace-info.mjs";
import { useWorkspacePanel } from "./dist/hooks/use-workspace-panel.mjs";
import { Content } from "./dist/layout/Content.mjs";
import { Header } from "./dist/layout/Header.mjs";
import { WelcomePanel, LOADING_STATUS_TEXT } from "./dist/layout/WelcomePanel.mjs";
import { CompactionSummaryView } from "./dist/messages/CompactionSummaryView.mjs";
import { countSourceMessages, getMessages } from "./dist/utils/get-messages.mjs";
import { flattenNamespaceFor, getStaticFlattenSnapshot } from "./dist/utils/message-flat-cache.mjs";

// ── fake terminal ────────────────────────────────────────────────────────────

class FakeStdout extends EventEmitter {
  columns = 120;
  rows = 40;
  isTTY = true;
  chunks = [];
  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }
  getColorDepth() {
    return 1;
  }
  get text() {
    return this.chunks.join("");
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

// ── fixture ──────────────────────────────────────────────────────────────────

/**
 * Builds a long transcript on the shape that matters for this plan: many tool calls per
 * turn (so the static block is long enough to truncate and the window has to slide) plus
 * reasoning/text parts (so rows are not uniformly one line tall).
 *
 * A recorded session can be passed as argv[2] instead — recorded sessions live under the
 * gitignored `.agents/` tree, so the fixture is the default and keeps this check runnable
 * from a clean checkout.
 */
function buildFixture(turns, toolsPerTurn) {
  const messages = [{ id: "msg-user-0", role: "user", parts: [{ type: "text", content: "Start a long task" }] }];
  for (let turn = 1; turn <= turns; turn++) {
    messages.push({
      id: `msg-user-${turn}`,
      role: "user",
      parts: [{ type: "text", content: `Turn ${turn}: keep going` }],
    });
    for (let tool = 0; tool < toolsPerTurn; tool++) {
      messages.push({
        id: `call-${turn}-${tool}`,
        role: "assistant",
        parts: [
          { type: "text", content: `Checking file ${turn}-${tool}` },
          {
            type: "tool-call",
            id: `tool-${turn}-${tool}`,
            name: "read_file",
            state: "complete",
            arguments: JSON.stringify({ path: `packages/app/src/file-${turn}-${tool}.ts` }),
            output: { content: `export const value${turn}${tool} = ${turn * 100 + tool};` },
          },
        ],
      });
    }
    messages.push({
      id: `msg-assistant-${turn}`,
      role: "assistant",
      parts: [{ type: "text", content: `Turn ${turn} done.` }],
    });
    // Injected per turn by core, and often the trailing message when the agent stops after a
    // tool call. Including it makes the fixture exercise the ctx-filtered tail, which is the
    // shape that produced duplicated rows (see the static/dynamic overlap guard below).
    messages.push({
      id: `ctx-git_status-${turn}`,
      role: "user",
      parts: [{ type: "text", content: `<ctx kind="git_status">\nOn branch main\nnothing to commit\n</ctx>` }],
    });
  }
  return messages;
}

function loadSession(path, limit) {
  const messages = [];
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.t === "message" && entry.message) messages.push(entry.message);
    if (limit && messages.length >= limit) break;
  }
  return messages;
}

// ── harness ──────────────────────────────────────────────────────────────────

const sessionPath = process.argv[2] ?? null;
const all = sessionPath ? loadSession(sessionPath, 400) : buildFixture(60, 4);

// The list most recently handed to the component. Guards below must mutate THIS, not the
// original `all`: the smoke drives several different lists, and switching back would change
// every row's projection at once and mask what the guard is measuring.
let renderedMessages = all;

const Screen = ({ messages }) => {
  renderedMessages = messages;
  // The real app initializes screen size in Agent.tsx (`useSize.getActions().useInitTerminalSize()`).
  // Without it `useSize.state.screenWidth` stays 0 and width-derived paddings go negative.
  useSize.getActions().useInitTerminalSize();
  return createElement("ink-box", { flexDirection: "column" }, [
    // Mounted so `useStatic.header` is populated as it is in the app, where `Header` is a
    // sibling of `Content` under `Agent`.
    createElement(Header, { key: "header" }),
    createElement(MessageList, { key: "list", messages }),
    createElement(Content, { key: "content" }),
  ]);
};

function mount() {
  const stdout = new FakeStdout();
  const stdin = fakeStdin();
  const instance = render(createElement(Screen, { messages: all }), {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 30,
  });
  return { instance, stdout };
}

/** Strip ANSI colour/cursor sequences from a captured frame.
 *  Built from a char code so the source carries no raw control character. */
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/**
 * Visible transcript lines for the current frame.
 *
 * Frames are parsed from the LAST substantial write, not the concatenated stream:
 * a repaint starts with `\x1b[2K\x1b[1A` erase/up sequences and contains no newlines of
 * its own beyond the rows it draws, so slicing at the last erase block yields exactly the
 * lines currently on screen (concatenating instead would count every historical frame).
 */
function frameLines(stdout) {
  const substantial = stdout.chunks.filter((c) => c.length > 20);
  const last = substantial.length ? substantial[substantial.length - 1] : "";
  return last
    .replace(ANSI, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0);
}

/**
 * Same last-frame slice as {@link frameLines}, but keeping blank rows.
 *
 * `frameLines` drops empty lines because most assertions want the visible text; layout checks
 * (does this element still occupy a row?) need the opposite, since a collapsed zero-height row
 * and a filtered-out blank are indistinguishable once the empties are gone.
 */
function rawFrameLines(stdout) {
  const substantial = stdout.chunks.filter((c) => c.length > 20);
  const last = substantial.length ? substantial[substantial.length - 1] : "";
  return last
    .replace(ANSI, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
}

/**
 * Resize the fake terminal and wait until the PAINTED frame reflects it.
 *
 * `settle(ms)` is not a layout checkpoint: the renderer coalesces repaints, so a frame read right
 * after `emit("resize")` can still be the PREVIOUS width's — or a transient where the new width
 * has not been applied yet. Asserting there makes width-sensitive checks flap with no source
 * change (observed: the `60/80/120` row-layout assertions failed ~3 runs in 25, each time
 * reporting the neighbouring width's rows).
 *
 * Waiting on the painted frame is NOT enough, and reading it as "the frame changed" produces a
 * false pass: ink reflows to the fake stdout's new `columns` immediately, so the frame changes
 * while our own layout constants lag — `useTerminalSize` debounces the resize event by 200ms, so
 * `screenWidth` (what `titleWidth`/`metaWidth` are derived from) still holds the OLD value. The
 * checkpoint therefore keys on the store, which is the signal the layout actually reads.
 */
async function resizeAndPaint(stdout, cols, { timeoutMs = 4000 } = {}) {
  stdout.columns = cols;
  stdout.emit("resize");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await settle(50);
    if (useSize.getReadonlyState().state.screenWidth === cols) {
      // The store is current; give the paint that consumes it one quiet beat to land.
      await settle(150);
      return frameLines(stdout).join("\n");
    }
  }
  console.error(`[resizeAndPaint] screenWidth never reached ${cols} within ${timeoutMs}ms`);
  return frameLines(stdout).join("\n");
}

const results = [];
const record = (name, pass, detail) => results.push({ name, pass, detail });

// Task panel navigation is a view over the child session, not a task-row-only link.
// The detail surface itself is exercised by the component tree; this asserts the store
// transition a row/task selection uses, so a regression to "link only" cannot pass silently.
{
  const actions = useSubagentPanel.getActions();
  actions.openDetail("sub_panel_probe");
  const state = useSubagentPanel.getReadonlyState();
  record(
    "task panel opens a complete child detail view",
    state.view === "detail" && state.selectedSubagentId === "sub_panel_probe",
    { view: state.view, selected: state.selectedSubagentId }
  );
  actions.close();
}

// React reports duplicate/missing keys through console.error. Capture it so a real
// row-identity regression (the React key remount the window boundary must avoid) fails
// the smoke instead of scrolling past in the terminal.
const consoleErrors = [];
const realConsoleError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
};

// ── 1. mount + no duplication / no crash ────────────────────────────────────

useWorkspaceInfo.getActions().setWorkspaceInfo({ path: "/workspace", git: { branch: "main" } });
useTheme.getActions().setTheme("gemini");
useAgentStatus.getActions().setStatus("idle");

const { instance, stdout } = mount();
await settle(250);

const lines = frameLines(stdout);
record("mounts without throwing and paints rows", lines.length > 0, { lineCount: lines.length });
record(
  "no ink render crash in the frame",
  !/Invalid count value|Cannot read propert|is not a function/i.test(lines.join("\n")),
  {
    head: lines.slice(0, 2),
  }
);
record("no React key/identity warnings", !consoleErrors.some((e) => /key|duplicate/i.test(e)), {
  consoleErrors: consoleErrors.slice(0, 3),
});

// Derive the expectation from the same pure function the component uses, fed with the heights
// the component itself measured (`onRender` writes them into `useStaticHeights`). Row ids are
// part-scoped, so the row list is not simply the message list.
const { staticMessages, dynamicMessages, staticSourceTotal } = getMessages(all, {
  mode: useTranscriptDisplay.getState().mode,
  window: 120,
  namespace: "transcript",
});

/** The marker's total, exactly as `MessageList` derives it (one subtraction, in messages). */
function hiddenMarkerOf(rows, total, visibleCount) {
  return Math.max(0, total - countSourceMessages(rows.slice(-visibleCount)));
}

/** Recompute the row budget as `MessageList` does, from the live measured heights. */
function expectedStaticRows() {
  const heights = useStaticHeights.getState().heights;
  return selectVisibleRows(staticMessages, heights);
}

// ── 0. the line budget in isolation, plus the selection/pruning fixed point ───────────
//
// Expectations come from hand-built heights in `budget-fixtures.mjs`, never from the store the
// component writes — see that file for why a self-referential expectation would stay green
// through exactly the regression this section exists to catch.
for (const c of budgetChecks) record(c.name, c.pass, c.detail);

// ── 0c. measured heights are sane ─────────────────────────────────────────────
//
// A short text row at 120 columns must be a handful of lines. `onRender` used to fire on a
// pre-layout pass reporting `2 * columns - 2` (238) with width 0; caching at that width produced
// a 0-line region, and the first bogus value stuck because `recordHeight` rejects <= 0.
{
  const values = Object.values(useStaticHeights.getState().heights);
  const worst = values.length ? Math.max(...values) : 0;
  record(
    "measured row heights are plausible for the fixture (no width-derived garbage)",
    values.length > 0 && worst < 60,
    { n: values.length, min: Math.min(...values), max: worst, storeRows: useStatic.getState().list.length }
  );
}

// What actually reaches the store after the component's own line budget. The marker is
// prepended INSIDE the cached static region (that is where it belongs: it describes the rows
// the budget dropped), so the store holds the kept rows plus one marker element.
const budget0 = expectedStaticRows();
const markerExpected = hiddenMarkerOf(staticMessages, staticSourceTotal, budget0.visibleCount);
const expectedStoreRows = budget0.visibleCount + (markerExpected > 0 ? 1 : 0);
record(
  "static store holds exactly the line-budget rows plus the in-region marker",
  useStatic.getState().list.length === expectedStoreRows,
  {
    storeRows: useStatic.getState().list.length,
    expectedStoreRows,
    staticMessages: staticMessages.length,
    visibleCount: budget0.visibleCount,
    droppedCount: budget0.droppedCount,
    maxStaticLines: MAX_STATIC_LINES,
  }
);
record("dynamic store holds the live rows", useDynamic.getState().list.length === Math.max(1, dynamicMessages.length), {
  storeRows: useDynamic.getState().list.length,
  dynamicMessages: dynamicMessages.length,
});

// ── 1b. the welcome panel stays outside the transcript budget ─────────────────
//
// The panel is the user's orientation (workspace, git, remote planes) and the only element
// pinned to the very top of the transcript. It must never be droppable by the line budget:
// the budget selects rows newest-first over accumulated rendered height, so a tall enough
// transcript would otherwise be able to push the panel out of the kept region. It therefore
// renders as its own cache unit in `Content`, from outside `MessageList`'s row list.
//
// What matters is the PAINTED FRAME, not the store field: the store could hold a header while
// the layout drops it. A workspace path only the panel renders is the marker for that.
const HEADER_MARKER = "/workspace";
// Identity, not a key check: the invariant is that the PANEL ELEMENT ITSELF is absent from the
// budgeted row list. Asserting on the string "header" would miss an implementation that
// prepends the header element under some other key (which is exactly how the mutation test
// re-created the bug), so compare against `useStatic.header` by identity.
const headerInRowList = useStatic.getState().list.some((el) => el === useStatic.getState().header);
record(
  "the welcome panel is published as its own cache unit (not part of the row list)",
  useStatic.getState().header !== null && !headerInRowList,
  { headerSet: useStatic.getState().headerSet, headerInRowList }
);
{
  // Drive the budget to exhaustion: enough tall rows that most of the transcript is dropped.
  const flood = all.concat(
    Array.from({ length: 300 }, (_, i) => ({
      id: `flood-${i}`,
      role: "assistant",
      parts: [{ type: "text", content: `line ${i}\nsecond line ${i}\nthird line ${i}` }],
    }))
  );
  instance.rerender(createElement(Screen, { messages: flood }));
  await settle(300);
  const floodBudget = selectVisibleRows(
    getMessages(flood, { mode: useTranscriptDisplay.getState().mode, window: 120, namespace: "transcript" })
      .staticMessages,
    useStaticHeights.getState().heights
  );
  // Non-vacuous only if the budget actually dropped rows.
  record("the budget is genuinely exhausted (so the header guard is not vacuous)", floodBudget.droppedCount > 0, {
    droppedCount: floodBudget.droppedCount,
    visibleCount: floodBudget.visibleCount,
  });
  record(
    "the welcome panel still paints while the transcript is truncated",
    frameLines(stdout).join("\n").includes(HEADER_MARKER),
    {
      rows: useStatic.getState().list.length,
      headerSet: useStatic.getState().headerSet,
      frameLines: frameLines(stdout).length,
    }
  );
  // Restore the long fixture so later assertions see the original row set.
  instance.rerender(createElement(Screen, { messages: all }));
  await settle(300);
}

// ── 2. hidden-count marker: correct value, exactly once, not stale ───────────

// Section 1b drove the flood transcript through the same component and restored the long
// fixture, so the measurements this guard reads are still settling here — see
// `await-stable-marker.mjs` (a bare sleep made this flap: 281 vs 292, no source change).
const markerState = await awaitStableMarker({
  readState: () => {
    const budget = expectedStaticRows();
    return {
      marker: hiddenMarkerOf(staticMessages, staticSourceTotal, budget.visibleCount),
      visibleCount: budget.visibleCount,
    };
  },
  readPaintedMarker: () =>
    [
      ...frameLines(stdout)
        .join("\n")
        .matchAll(/\.\.\. (\d+) older messages? hidden/g),
    ].map((m) => Number(m[1])),
  settle: () => settle(120),
});
const frameMarkerMatches = markerState.painted;
record(
  "hidden marker value equals the component's own hidden total",
  markerState.state.marker === 0
    ? frameMarkerMatches.length === 0
    : frameMarkerMatches.at(-1) === markerState.state.marker,
  { markerExpected: markerState.state.marker, frameMarkerMatches, settled: markerState.settled }
);
record("hidden marker rendered exactly once per frame", frameMarkerMatches.length <= 1, {
  occurrences: frameMarkerMatches.length,
});
// Architectural position: the marker belongs to the cached static region. Asserting it is the
// FIRST store element catches an accidental move back to a sibling element outside the region.
if (markerState.state.marker > 0) {
  const head = useStatic.getState().list[0];
  record("truncation marker is the first element of the static block", Boolean(head?.props?.children), {
    hasHead: Boolean(head),
  });
}

// ── 3. row count stable across window slides (no drift / ghost rows) ─────────

// Each step appends to the transcript and records both the store size and how many rows the
// line budget says should be kept, recomputed from the CURRENT measured heights.
const rowChecks = [];
let grownSoFar = all;
for (const extra of [1, 2, 4]) {
  grownSoFar = grownSoFar.concat(
    Array.from({ length: extra }, (_, i) => ({
      id: `synthetic-${extra}-${i}`,
      role: "assistant",
      parts: [{ type: "text", content: `step ${extra}-${i}` }],
    }))
  );
  instance.rerender(createElement(Screen, { messages: grownSoFar }));
  await settle(120);
  // The store uses the same window/namespace the component does, so the budget and the hidden
  // prefix must be derived from THAT projection, not from the unbounded `all`.
  const projected = getMessages(grownSoFar, {
    mode: useTranscriptDisplay.getState().mode,
    window: 120,
    namespace: "transcript",
  });
  const budget = selectVisibleRows(projected.staticMessages, useStaticHeights.getState().heights);
  rowChecks.push({
    storeRows: useStatic.getState().list.length,
    expectedRows:
      budget.visibleCount +
      (hiddenMarkerOf(projected.staticMessages, projected.staticSourceTotal, budget.visibleCount) > 0 ? 1 : 0),
  });
}
// The budget must keep holding as the window slides: growth without bound would mean the
// truncation (and therefore the cached region) is unbounded, which is the jank this plan
// removes. The budget is counted in LINES, so the row count it admits varies as rows get
// measured — assert each step matches its own recomputed expectation instead of a fixed cap.
record(
  "static row count stays within the line budget as the window slides",
  rowChecks.every((c) => c.storeRows === c.expectedRows && c.storeRows > 0),
  { rowChecks, maxStaticLines: MAX_STATIC_LINES }
);
record("no React key/identity warning after slides", !consoleErrors.some((e) => /key|duplicate/i.test(e)), {
  consoleErrors: consoleErrors.slice(0, 3),
});

// ── 3b. mid-stream appends must not be dropped ─────────────────────────────────
//
// Regression guard: an earlier revision deferred static-block rebuilds until the agent
// reached an idle status edge. That lost rows — a message promoted out of the streaming
// tail belongs to neither the static block (deferred) nor the dynamic block (which holds
// only the newest message), so it rendered nowhere for the whole run. The smoke must
// therefore also drive a NON-idle status; with the gate in place this assertion fails.
{
  useAgentStatus.getActions().setStatus("running");
  const before = useStatic.getState().list.length;

  const streaming = all.concat(
    Array.from({ length: 40 }, (_, i) => ({
      id: `mid-stream-${i}`,
      role: "assistant",
      parts: [{ type: "text", content: `chunk ${i}` }],
    }))
  );
  instance.rerender(createElement(Screen, { messages: streaming }));
  await settle(120);

  const midStreamRows = useStatic.getState().list.length;
  const midStreamResult = getMessages(streaming, {
    mode: useTranscriptDisplay.getState().mode,
    window: 120,
    namespace: "transcript",
  });
  const midBudget = selectVisibleRows(midStreamResult.staticMessages, useStaticHeights.getState().heights);
  const expectedRows =
    midBudget.visibleCount +
    (hiddenMarkerOf(midStreamResult.staticMessages, midStreamResult.staticSourceTotal, midBudget.visibleCount) > 0
      ? 1
      : 0);

  // The regression this guards is rows rendered NOWHERE, not the exact row count: a message
  // promoted out of the streaming tail while the agent is non-idle belongs to neither list if
  // the region refuses to rebuild. So assert the region republished and that its rows are a
  // suffix of the projected rows (fresh), rather than stale pre-append rows.
  const storeKeys = useStatic.getState().list.map((e) => String(e?.key ?? ""));
  const projectedTail = midStreamResult.staticMessages.slice(-3).map((m) => m.id);
  const newestRowKey = storeKeys.at(-1);
  record(
    "mid-stream appends reach the static region (no dropped rows while running)",
    midStreamRows > 0 &&
      /\.\.\. \d+ older/.test(String(storeKeys[0] ?? "")) === false &&
      projectedTail.some((id) => storeKeys.includes(id)) &&
      midStreamRows === expectedRows,
    { status: useAgentStatus.getState().status, before, midStreamRows, expectedRows, projectedTail, newestRowKey }
  );

  // And the status must not be what governs publication: reaching an idle edge afterwards
  // must not be required for the rows to appear.
  useAgentStatus.getActions().setStatus("idle");
}

// ── 3c. static/dynamic split must not overlap ──────────────────────────────────
//
// Regression guard for a reported symptom: rows briefly rendering twice, then healing.
// `getMessages` resolved `lastMessage` against the ctx-filtered array but sliced
// `staticSource` from the pre-filter array, so when a synthetic `<ctx kind=…>` row trailed
// the turn the real last message was sliced away *and* emitted dynamically — it rendered
// twice. Only the trailing row was affected, so the next append healed it.
{
  const turnCtxRow = (id) => ({
    id,
    role: "user",
    parts: [{ type: "text", content: `<ctx kind="git_status">\nOn branch main\n${id}` }],
  });
  const toolTurn = (id, n = 2) => ({
    id,
    role: "assistant",
    parts: Array.from({ length: n }, (_, i) => ({
      type: "tool-call",
      id: `${id}t${i}`,
      name: "read_file",
      state: "complete",
      arguments: JSON.stringify({ path: `${id}-${i}.ts` }),
      output: { ok: true },
    })),
  });

  const cases = Math.max(0, all.length - 60);
  const offenders = [];
  for (let end = cases; end <= all.length; end += 3) {
    const messages = all.slice(0, end);
    const result = getMessages(messages, {
      mode: useTranscriptDisplay.getState().mode,
      window: 120,
      namespace: "transcript",
    });
    // Compare EXACT row ids, never stripped ones: a duplicated message flattens identically
    // in both lists, so the ids match literally. Stripping the part suffix would also
    // collapse distinct source ids that merely end in a number (msg-user-0 vs msg-user-1).
    const staticRowIds = new Set(result.staticMessages.map((m) => m.id));
    const shared = result.dynamicMessages.map((m) => m.id).filter((id) => staticRowIds.has(id));
    if (shared.length) offenders.push({ end, shared: shared.slice(0, 2) });
  }
  record("no message renders in both the static and dynamic lists", offenders.length === 0, {
    stepsChecked: Math.floor((all.length - cases) / 3) + 1,
    offenders: offenders.slice(0, 3),
  });

  // Same invariant with a synthetic ctx row trailing the turn — the exact shape that
  // triggered the original duplication.
  const trailing = [
    { id: "dup-u1", role: "user", parts: [{ type: "text", content: "go" }] },
    toolTurn("dup-a1"),
    turnCtxRow("dup-ctx1"),
  ];
  const trailingResult = getMessages(trailing, { mode: "full", namespace: "dup-guard" });
  const trailingStaticIds = new Set(trailingResult.staticMessages.map((m) => m.id));
  const trailingShared = trailingResult.dynamicMessages.map((m) => m.id).filter((id) => trailingStaticIds.has(id));
  record("trailing ctx row does not duplicate the last message", trailingShared.length === 0, {
    shared: trailingShared,
    dynamicRows: trailingResult.dynamicMessages.map((m) => m.id),
  });
}

// ── 4. per-row cache invalidation scope (the point of this change) ────────────
//
// Regression guard: each row is its own `<StaticRender>` leaf, so ONE row's state changing
// must re-cache exactly that row. Before this change the whole transcript was a single block
// keyed on a transcript-wide tool signature, so any row's update re-cached every row.
//
// `onRender` fires once per (re-)cache, so counting the row ids it reports is the direct
// measurement of what the cache did — not a proxy like emitted bytes, which are bounded by
// the viewport and cannot show a caching win.
{
  const recorded = [];
  const actions = useStaticHeights.getActions();
  const realRecord = actions.recordHeight;
  actions.recordHeight = (id, height) => {
    recorded.push(id);
    return realRecord(id, height);
  };

  // Mutate ONE row that is inside the kept window, leaving id set and row count identical,
  // so nothing except that row's own signature can change. The row renders the core-supplied
  // `display` payload, which IS part of the row signature (a tool output's *content* is not).
  //
  // The row id carries a per-part suffix (`call-7-0-1` = turn 7, tool 0, part 1), so the
  // source message id is the key minus that suffix. Picking the row from the store (rather
  // than a hardcoded id) keeps the guard valid for a recorded session too.
  const storeKeys = useStatic.getState().list.map((el) => String(el?.key ?? ""));
  // Rows are per part, so a tool row's id is `<messageId>-<partIndex>`. Pick a tool row
  // (part 1 of an assistant message with a text part + a tool part) — only a tool part has a
  // `display` payload to advance, which is what the row actually renders.
  const toolRowKey = storeKeys.find((k) => /^call-\d+-\d+-1$/.test(k)) ?? null;
  const targetMessageId = toolRowKey ? toolRowKey.replace(/-\d+$/, "") : null;
  const mutated = renderedMessages.map((msg) =>
    msg.id === targetMessageId
      ? {
          ...msg,
          parts: msg.parts.map((p) =>
            p.type === "tool-call" ? { ...p, display: { text: `read_file ${targetMessageId} // ADVANCED` } } : p
          ),
        }
      : msg
  );

  const sigsBefore = useStatic.getState().itemSigs.slice();
  recorded.length = 0;
  instance.rerender(createElement(Screen, { messages: mutated }));
  await settle(250);
  const cachedIds = [...new Set(recorded)];
  const sigsAfter = useStatic.getState().itemSigs;
  const changedSigs = sigsAfter.filter((s, i) => sigsBefore[i] !== s).length;

  // Two failure modes, both must be caught:
  //  - `cachedIds` contains MORE than the one row that changed => the whole region re-cached
  //    (the pre-change behaviour: any row's update rebuilt the transcript).
  //  - `cachedIds` is EMPTY => the changed row did NOT re-cache, so it is pinned to its stale
  //    render. The mutation test (wrapping the rows back in one whole-transcript block)
  //    reproduces exactly this, which is how the guard was verified to bite.
  record(
    "changing ONE row re-caches exactly that row (not more, not zero)",
    toolRowKey !== null && cachedIds.length === 1 && cachedIds[0] === toolRowKey,
    { targetMessageId, toolRowKey, cachedIds, changedSigs, rowCount: useStatic.getState().list.length }
  );
  // The rows must genuinely differ (otherwise "only one changed" would be vacuous).
  record("exactly one row signature changed", changedSigs === 1, { changedSigs, toolRowKey });

  // And an unrelated re-render must re-cache nothing at all.
  recorded.length = 0;
  instance.rerender(createElement(Screen, { messages: mutated }));
  await settle(200);
  record("a re-render with no row change re-caches nothing", recorded.length === 0, {
    cachedIds: [...new Set(recorded)],
  });

  // Switching the diff renderer must reach EVERY row. `useDiffRenderer` is consumed deep
  // inside the row (ToolInputView -> MessageDiffView) as a subscription, not a prop, so a
  // cached row cannot notice the switch on its own: the mode has to reach the row's cache
  // deps (or the element array those deps are rebuilt from). A row left un-re-cached keeps
  // rendering through the previous renderer — and, because the two renderers lay out to
  // different heights, it also holds a stale measured height.
  //
  // This fixture has no diff rows, so the re-caching is pure cost — but it is NOT zero, and it
  // must not be: the deps are what make the switch reach a row that DOES contain a diff, and a
  // row cannot know in advance whether it will render one. The bound is "every row, but not
  // more often than the store itself updates":
  //
  //  0 rows = the switch never reaches the rows (the stale-render bug this guards).
  //  1-2 passes = within `useDiffRenderer`'s two-phase update: `toggle()`/`setMode()` set
  //    `mode` synchronously and bump `key` on a `setTimeout`, so deps carrying `${mode}:${key}`
  //    change twice. Measured: 6 toggles out of 6, 179 rows, 358 events.
  //  3+ passes = redundant deps re-caching more than once per store update — what the earlier
  //    `>= rows - 1` form accepted (a whole-transcript re-cache read as success).
  recorded.length = 0;
  const diffBefore = useDiffRenderer.getState().mode;
  useDiffRenderer.getActions().toggle();
  await settle(300);
  const diffEvents = recorded.length;
  const diffReCached = [...new Set(recorded)].length;
  // The truncation marker caches alongside the rows but has no measurement of its own, so it
  // never appears in `recorded` and is excluded from the row count.
  const diffRows = useStatic
    .getState()
    .list.map((el) => String(el?.key ?? ""))
    .filter((key) => key !== "truncation-marker").length;

  record(
    "a diff-renderer switch re-caches every row, at most once per store update",
    diffRows > 0 &&
      diffReCached === diffRows &&
      diffEvents <= diffRows * 2 &&
      useDiffRenderer.getState().mode !== diffBefore,
    {
      diffBefore,
      diffAfter: useDiffRenderer.getState().mode,
      rows: diffRows,
      reCached: diffReCached,
      events: diffEvents,
      storeRows: useStatic.getState().list.length,
    }
  );
  useDiffRenderer.getActions().setMode(diffBefore);
  await settle(250);

  // The mirror case: width genuinely changes every row's layout, so every row must re-cache.
  // Asserting both directions keeps them from regressing together — the value lives in the
  // rebuild key, and these two assertions pin both ends (re-cache all when it matters, none when
  // it does not).
  recorded.length = 0;
  const colsBefore = stdout.columns;
  stdout.columns = colsBefore === 120 ? 100 : 120;
  stdout.emit("resize");
  await settle(350);
  const resizeReCached = [...new Set(recorded)].length;
  record(
    "a resize re-caches every visible row (width reaches each row's cache)",
    resizeReCached >= useStatic.getState().list.length - 1,
    {
      colsBefore,
      colsAfter: stdout.columns,
      reCached: resizeReCached,
      storeRows: useStatic.getState().list.length,
    }
  );
  stdout.columns = colsBefore;
  stdout.emit("resize");
  await settle(300);

  actions.recordHeight = realRecord;
}

// ── 4b. content rewritten under a stable id must not stay pinned ───────────────
//
// Some messages keep their id while their text is replaced wholesale (activity summaries,
// streamed compaction summaries). The per-row signature must digest text content, otherwise
// the row's cached render is pinned to the first version forever — the same failure class as
// the flat-cache staleness bug. This asserts the signature moves when only the text moves.
{
  // A single message is the dynamic tail, so the summary needs a predecessor to land in the
  // static region at all.
  const withSummary = (text) => [
    { id: "stable-user-1", role: "user", parts: [{ type: "text", content: "go" }] },
    { id: "stable-summary-1", role: "assistant", parts: [{ type: "text", content: text }] },
    { id: "stable-user-2", role: "user", parts: [{ type: "text", content: "next" }] },
  ];
  // Distinct namespaces: the static flatten snapshot short-circuits on message identity, so
  // reusing one namespace would return the first result verbatim and pass vacuously.
  const before = getMessages(withSummary("Summarizing part one of the transcript"), {
    mode: "full",
    namespace: "stable-id-guard-a",
  });
  const after = getMessages(withSummary("Summarizing part two, completely different text"), {
    mode: "full",
    namespace: "stable-id-guard-b",
  });
  // Static rows are per part, so the summary's row id carries a part suffix (`-0`).
  const rowOf = (result) => result.staticMessages.findIndex((m) => m.id === "stable-summary-1-0");
  const beforeIndex = rowOf(before);
  const afterIndex = rowOf(after);
  record(
    "a row rewritten under the same id changes its render signature",
    beforeIndex >= 0 && afterIndex >= 0 && before.staticSignatures[beforeIndex] !== after.staticSignatures[afterIndex],
    {
      beforeIndex,
      afterIndex,
      sigBefore: before.staticSignatures[beforeIndex],
      sigAfter: after.staticSignatures[afterIndex],
    }
  );
}

// ── 5. per-agent flatten-snapshot namespaces + cleanup on destroy ────────────
//
// Namespaces are agent ids, so two subagent previews no longer evict each other's snapshot
// (the old shared "subagent" namespace did) and a preview can never thrash the main
// transcript. `useFlattenCacheCleanup` releases a destroyed agent's snapshots — everything
// else stays. The reuse guard is message IDENTITY, so this is a memory concern only.
{
  const subagentMessages = buildFixture(4, 2);
  const otherSubagentMessages = buildFixture(3, 5);
  const mainMessages = buildFixture(6, 3);
  const rootId = "ses_root";

  // Populate the three namespaces a live app would hold: main transcript + two previews.
  getMessages(mainMessages, { mode: "full", namespace: flattenNamespaceFor(rootId), window: 120 });
  getMessages(subagentMessages, { mode: "full", namespace: flattenNamespaceFor("sub_a") });
  getMessages(otherSubagentMessages, { mode: "full", namespace: flattenNamespaceFor("sub_b") });

  const held = (agentId) => Boolean(getStaticFlattenSnapshot(flattenNamespaceFor(agentId), "full"));
  record(
    "main transcript and two subagent previews hold snapshots simultaneously",
    held(rootId) && held("sub_a") && held("sub_b"),
    { rootId, sub_a: held("sub_a"), sub_b: held("sub_b") }
  );
  // Distinct SLOTS, not merely non-empty: with one shared namespace every lookup resolves to
  // the same entry (the last writer's), which is the collision this namespacing removed.
  const slots = [rootId, "sub_a", "sub_b"].map((id) => getStaticFlattenSnapshot(flattenNamespaceFor(id), "full"));
  record("each agent holds its own snapshot slot (no shared entry)", new Set(slots).size === 3, {
    distinctSlots: new Set(slots).size,
  });

  // Unchanged input still short-circuits after other namespaces wrote (the isolation point:
  // with one shared namespace a subagent render would have evicted this entry).
  const first = getMessages(subagentMessages, { mode: "full", namespace: flattenNamespaceFor("sub_a") });
  const second = getMessages(subagentMessages, { mode: "full", namespace: flattenNamespaceFor("sub_a") });
  record(
    "a preview keeps its short-circuit after another preview rendered",
    first.staticMessages === second.staticMessages,
    { sameArray: first.staticMessages === second.staticMessages }
  );

  // Drive the real hook through the real store with a fake session whose subscribe matches
  // the core contract: it filters by channel, and `agentId` is the emitting agent.
  const subscribers = [];
  const fakeSession = {
    id: rootId,
    getSnapshot: () => ({ agentId: rootId, messages: [] }),
    subscribe(handler, options) {
      const channels = options?.channels ?? ["messages", "lifecycle"];
      subscribers.push({ handler, channels });
      return () => {
        const i = subscribers.findIndex((s) => s.handler === handler);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
  };
  const emitLifecycle = (type, agentId, payload) => {
    for (const s of [...subscribers]) {
      if (!s.channels.includes("lifecycle")) continue;
      // Matches the real envelope: channel/ts/agentId/payload, where `payload` carries the
      // event type plus the emitter's own fields (core nests the event payload verbatim).
      s.handler({
        channel: "lifecycle",
        ts: Date.now(),
        agentId,
        payload: { type, ts: Date.now(), agentId, parentId: rootId, payload },
      });
    }
  };

  // Bind the fake session before mounting so the hook subscribes on its first effect.
  useAgent.getActions().setSession(fakeSession);
  const cleanupHarness = render(
    createElement(() => {
      useFlattenCacheCleanup();
      return null;
    }),
    { stdout: new FakeStdout(), stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false }
  );
  await settle(60);
  const subscribedToLifecycle = subscribers.some((s) => s.channels.includes("lifecycle"));
  record("cleanup hook subscribes to the lifecycle channel", subscribedToLifecycle, {
    subscriberChannels: subscribers.map((s) => s.channels),
  });

  emitLifecycle("subagent:destroyed", "sub_a", { subagentId: "sub_a", parentId: rootId });
  await settle(60);
  record("destroying a subagent releases its snapshots", !held("sub_a"), { sub_a: held("sub_a") });
  record("destroying a subagent leaves the main transcript and other previews intact", held(rootId) && held("sub_b"), {
    rootId: held(rootId),
    sub_b: held("sub_b"),
  });

  // A non-lifecycle / unrelated event must not clear anything.
  emitLifecycle("subagent:created", "sub_c", { subagentId: "sub_c" });
  await settle(40);
  record("an unrelated lifecycle event clears nothing", held(rootId) && held("sub_b"), {
    rootId: held(rootId),
    sub_b: held("sub_b"),
  });

  cleanupHarness.unmount();
  useAgent.getActions().setSession(null);
}

// ── 6. mode switch leaves no residue from the previous mode ──────────────────

useTranscriptDisplay.getActions().setMode("compact");
await settle(120);
const compactLines = frameLines(stdout);
record("mode switch repaints", compactLines.length > 0, { compactLines: compactLines.length });

useTranscriptDisplay.getActions().setMode("full");
await settle(120);
const fullLines = frameLines(stdout);
const fullText = fullLines.join("\n");
record(
  "full-mode repaint after compact switch has no stale summary residue",
  fullLines.length > 0 && !/Summarizing/i.test(fullText),
  { fullLines: fullLines.length }
);
// ── 7. a settled task row paints used/budget after a restore ─────────────────

// The pure formatter is pinned in `budget-fixtures.mjs`, but a green formatter says nothing
// about whether the component still HANDS IT the persisted pair: `formatTaskTurns(iteration)`
// with the second argument dropped type-checks and keeps every unit check passing while
// silently going blank on every restored task — which is the regression this guards.
//
// So mount the real row through the real `MessageList` and assert on the PAINTED frame. No
// live session exists for the child (that is precisely the restore case), so the frozen pair
// on the part's output is the only thing that can produce these numbers.
useTranscriptDisplay.getActions().setMode("full");
const FROZEN_USED = 7;
const FROZEN_BUDGET = 50;
const restoredTask = {
  id: "msg-restored-task",
  role: "assistant",
  parts: [
    {
      type: "tool-call",
      id: "call-restored-task",
      name: "task",
      state: "output-available",
      arguments: JSON.stringify({ prompt: "Audit the persistence layer", description: "audit-persistence" }),
      output: {
        subagentId: "sub-restored",
        summary: "Persistence keeps the wire and the channel apart.",
        truncated: false,
        iterations: FROZEN_USED,
        maxIterations: FROZEN_BUDGET,
        durationMs: 4200,
        usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, billedInputTokens: 1500 },
        reachedLimit: false,
        incomplete: false,
        aborted: false,
      },
    },
  ],
};
instance.rerender(createElement(Screen, { messages: [restoredTask] }));
await settle(200);
{
  const text = frameLines(stdout).join("\n");
  record("a restored task row paints its frozen used/budget", text.includes(`${FROZEN_USED}/${FROZEN_BUDGET} turns`), {
    expected: `${FROZEN_USED}/${FROZEN_BUDGET} turns`,
    sawTaskRow: text.includes("task"),
    frameLines: frameLines(stdout).length,
  });
  // Non-vacuous: the row's other persisted carriers still paint, so a blank frame cannot pass
  // the check above by accident of the row not rendering at all.
  record(
    "and the same row still renders (so the readout is not passing on an empty frame)",
    text.includes("audit-persistence") || /task/i.test(text),
    { frameLines: frameLines(stdout).length }
  );
}
instance.rerender(createElement(Screen, { messages: all }));
await settle(120);

instance.unmount();

// ── the compact summary's fold window ────────────────────────────────────────
// A compact summary is the whole conversation's digest, so it is easily hundreds of
// lines. `MessageList` budgets the static region by MEASURED height, so an unbounded one
// crowds real messages out of the scrollback (and can exceed the viewport alone). Mounted
// directly rather than through `Screen` so it does not depend on the transcript fixture
// containing a compaction message. The rendered frame is the only thing that can prove
// the fold: a source-text assertion cannot tell a working `height` from an ignored one.
{
  // Long enough to be far past any plausible cap, in BOTH directions: 200 bullet lines is
  // hundreds of rendered lines once wrapped.
  const longSummary = `# Conversation Summary\n\n${Array.from(
    { length: 200 },
    (_, i) => `- digest line ${i + 1} with enough text to wrap around the pane width`
  ).join("\n")}`;
  const compactMessage = { id: "compact-fixture", role: "user", parts: [{ type: "text", content: longSummary }] };

  const compactStdout = new FakeStdout();
  // Wrapped in `StaticContext`, because the view derives its parse mode from where the row
  // lives. This fixture is the FINISHED checkpoint — what `MessageList` marks with
  // `staticMessage: true`. Mounted bare it would default to false and stream, and a streaming
  // window is tail-anchored: the assertion below would fold the digest's BEGINNING away and
  // fail for the right reason on the wrong fixture.
  const compactInstance = render(
    createElement(
      StaticContext,
      { value: { staticMessage: true } },
      createElement(CompactionSummaryView, { message: compactMessage })
    ),
    {
      stdout: compactStdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 30,
    }
  );
  await settle(400);
  compactInstance.unmount();

  const compactLines = frameLines(compactStdout);
  const foldLines = compactLines.filter((l) => /folded/.test(l));
  const painted = (compactStdout.text.match(/\S/g) ?? []).length;

  // Bound is generous (the component's cap is 40) but still far below what 200 wrapped
  // bullets produce — the assertion is "a fold happened", not "the constant is 40".
  record("a long compact summary folds instead of painting hundreds of lines", compactLines.length <= 80, {
    renderedLines: compactLines.length,
    foldIndicator: foldLines.at(-1) ?? null,
  });
  record(
    "the folded compact summary renders a fold indicator naming the hidden lines",
    foldLines.some((l) => /\d+ lines folded/.test(l)),
    {
      foldLines,
    }
  );
  // ...and it is not passing because nothing rendered at all.
  record("and the folded summary still renders its own content", painted > 200, { nonSpaceChars: painted });
  // The fold is at the BOTTOM and content renders from the START. This is what pins the STATIC
  // parse mode: the streaming window is tail-anchored, so a finished summary parsed as
  // streaming would fold the beginning away and show the digest's tail instead. It passes only
  // because the fixture registers `staticMessage: true` above.
  record(
    "the folded summary renders from the start, keeping its heading visible",
    compactLines.some((l) => /Conversation Summary/.test(l)),
    { hasHeading: compactLines.some((l) => /Conversation Summary/.test(l)), firstLines: compactLines.slice(0, 3) }
  );

  // The other direction of the same conditional, and the one a user actually watches: the SAME
  // component, same message, mounted WITHOUT the provider — the live summary that
  // `MessageViewWithCompact` injects while compaction runs. It must stream, because a summary
  // still arriving rendered as `final` is treated as already complete. Pinning this here is
  // what stops `streaming` from being "simplified" back to the constant it used to be: the
  // static fixture above cannot tell the two apart, so without this the constant passes green.
  const liveStdout = new FakeStdout();
  const liveInstance = render(createElement(CompactionSummaryView, { message: compactMessage }), {
    stdout: liveStdout,
    stdin: fakeStdin(),
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 30,
  });
  await settle(400);
  liveInstance.unmount();

  const liveLines = frameLines(liveStdout);
  // `streaming` drives the tail-anchored window, so a live summary drops the digest's head and
  // keeps its newest lines. That is the exact inverse of the static assertion above, and it is
  // observable on the frame — which is why this is a frame check and not a source one.
  record(
    "the same summary mounted without StaticContext streams instead (the live half)",
    !liveLines.some((l) => /Conversation Summary/.test(l)) && (liveStdout.text.match(/\S/g) ?? []).length > 200,
    { hasHeading: liveLines.some((l) => /Conversation Summary/.test(l)), firstLines: liveLines.slice(0, 2) }
  );
}

// ── the live text part must keep incremental stream parsing ──────────────────
// ink-stream-markdown 0.0.11 resolves the parse mode as `parseOptions?.final ?? !streaming`
// with `streaming` defaulting to FALSE, so a live text part that passes only
// `parseOptions` gets `final: true` and re-parses the whole message on every chunk — the
// streaming cache never engages. Up to 0.0.10 the resolver was "use `parseOptions` as-is
// once it mentions `final` OR `streamParse`", which the `streamParse` option satisfied.
//
// This one CANNOT be behavioural: the parse mode changes only the work done, never the
// rendered string, so there is no frame to assert on. It is a source assertion, and
// comments are stripped first so a commented-out prop cannot satisfy it.
{
  const textPartSource = fs.readFileSync(new URL("../../src/messages/TextPartView.tsx", import.meta.url), "utf8");
  const code = textPartSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // A bare boolean prop (`streaming`) or an explicit conditional (`streaming={!staticMessage}`).
  // Matched as a whole prop token so `STREAMING_PARSE_OPTIONS` and prose cannot satisfy it, and
  // the conditional form is accepted because that is what the component passes: the flag is
  // derived from `StaticContext` so rows promoted into the static region stop streaming.
  const hasStreamingProp = /(?:^|\s)streaming(?:=\{(?:true|!staticMessage)\})?(?=[\s/>])/.test(code);
  record("the live text part still asks for incremental stream parsing", hasStreamingProp, { hasStreamingProp });
  record(
    "and it passes the streamParse options that incremental parsing needs",
    /parseOptions=\{STREAMING_PARSE_OPTIONS\}/.test(code),
    {}
  );
}

// ── a cancelled run_command must not render as a failure ─────────────────────
// Runs LAST, deliberately: it mounts extra roots, and `useStatic` / `useDynamic` are module
// singletons that earlier assertions read exact row counts from — mounting mid-file shifted
// those counts and broke two unrelated checks. At the end nothing is left to disturb.
//
// The two shapes of ONE cancelled command, taken verbatim from the session that reported this
// (`ses_mu6ui27o_wf3j4m`, lines 39-40): the framework's abort fallback, which has no `exitCode`
// at all, and the tool's own catch, which synthesizes `-1`. They are written at different
// moments, so the row has to be correct for either.
//
// Scoped to the TEXT, not the colour: this harness's fake stdout makes the renderer emit no
// SGR at all (`frameLines` never sees an escape to strip), so a colour assertion here would
// pass vacuously. The body/warning colour agreement is pinned at the source level in
// `test/abort-and-streaming-bounds.test.mjs` instead.
{
  const cancelCases = [
    ["framework fallback", { success: false, error: "Cancelled by user.", cancelled: true }, false],
    [
      "tool's own catch",
      {
        command: "total=90; for i in $(seq 1 $total); do ...; done",
        stdout: "[  6%] =  19:01:47\n[  7%] =  19:01:48",
        stderr: "",
        exitCode: -1,
        durationMs: 0,
        success: false,
        cancelled: true,
        cachedOutputPath: null,
      },
      false,
    ],
    [
      "a real failure",
      {
        command: "false",
        stdout: "",
        stderr: "boom",
        exitCode: 1,
        durationMs: 5,
        success: false,
        cachedOutputPath: null,
      },
      true,
    ],
  ];

  const mountCommandRow = async (label, output) => {
    const row = {
      id: `msg-cmd-${label}`,
      role: "assistant",
      parts: [
        { type: "text", content: "Running the long task" },
        {
          type: "tool-call",
          id: `call-cmd-${label}`,
          name: "run_command",
          state: "complete",
          arguments: JSON.stringify({ command: output.command ?? "total=90" }),
          output,
        },
      ],
    };
    const rowStdout = new FakeStdout();
    const rowInstance = render(createElement(Screen, { messages: [row] }), {
      stdout: rowStdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 30,
    });
    await settle(220);
    const text = frameLines(rowStdout).join("\n");
    rowInstance.unmount();
    return { text };
  };

  for (const [label, output, isFailure] of cancelCases) {
    const { text } = await mountCommandRow(label, output);
    const where = (re) => text.split("\n").find((l) => re.test(l));
    if (isFailure) {
      // The guard must be able to fail: a genuine failure still reports its code.
      record("a real failure still reports its exit code", /Exit code: 1/.test(text), { line: where(/Exit code/) });
    } else {
      record(`cancelled run_command (${label}) reports no exit code`, !/Exit code/.test(text), {
        line: where(/Exit code/),
      });
      // The concrete symptom: the synthetic payload has no `exitCode`, so the old
      // unconditional line interpolated the literal string into the row.
      record(`cancelled run_command (${label}) leaks no undefined`, !/undefined/.test(text), {
        line: where(/undefined/),
      });
      // TEMPORARILY DISABLED — deliberate behavior change, not a defect to fix here.
      //
      // A cancel-marked output collapses to the bare `TOOL_CANCELLED_MESSAGE` in BOTH render
      // paths — `computeToolDisplay` (which produces this row's body, via `display.text`) and
      // `formatToolOutput` — so the partial stdout this case produced is intentionally not
      // painted. The two assertions above still hold under those guards (no exit code, no
      // `undefined` leaked); only the partial-output reachability changed.
      //
      // This is the render-smoke twin of the assertion disabled in `test/abort-and-streaming-bounds
      // .test.mjs` (see b1c68cf) and of the section-3 pair in validate-cancel-semantics.mjs.
      //
      // NOTE: neither is this harness part of the CI sequence, nor does any remaining assertion
      // here detect that guard — mutating `computeToolDisplay` to skip its short-circuit leaves
      // the smoke fully green (only `a real failure still reports its exit code` catches a
      // blanket `isCancelledOutputMarker` regression). So this disable is not just a skipped
      // check: for this behavior, the harness now has no coverage at all.
      // if (output.stdout) {
      //   record(`cancelled run_command (${label}) still shows its partial output`, text.includes("19:01:47"), {
      //     line: where(/19:01:47/),
      //   });
      // }
    }
  }
}

console.error = realConsoleError;

// ── a settled row's arguments occupy at most two rows ────────────────────────
//
// The header is a single `wrap="wrap"` Text, so Ink gave a finished `run_command` whatever
// height its arguments needed — a heredoc or a long pipeline pushed the result block far
// below the command that produced it. `clampHeaderInput` bounds it, but only a real mount can
// prove the HEIGHT: the unit test measures with the same wrapper the assertion calls, so it
// cannot catch a row that Ink lays out differently (padding, the icon column).
//
// Counted from the frame instead: the rows that carry argument text. A live row must keep
// its arguments verbatim, which is the other half of the rule.
{
  // `rows` matches the physical rows the arguments occupy; `mustTruncate` says whether this
  // input is guaranteed to overflow 110 columns (the header's text column at the fake
  // stdout's 120). A command that fits must NOT grow a marker — an ellipsis on a complete
  // command would claim something was cut when nothing was.
  const ARGS_ROWS = [
    {
      label: "40 physical lines",
      command: Array.from({ length: 40 }, (_, i) => `echo line${i}`).join("\n"),
      rows: /echo line\d+/,
      mustTruncate: true,
    },
    {
      label: "one long wrapping line",
      // Four-plus rows at 110 columns: long enough that the settled row MUST be cut, so the
      // "shows verbatim while live" half has room to differ.
      command:
        `find . -name "*.ts" -not -path "*/node_modules/*" | xargs grep -l TODO | head -20 | sort | uniq -c ` +
        `| sort -rn | awk '{print $2}' | tee /tmp/out | wc -l | while read n; do echo "count=$n"; done ` +
        `| sed 's/^/  /' | tail -5 | tr a-z A-Z | rev | head -3`,
      rows: /xargs|uniq|awk|\/tmp\/out|wc -l|count=|sed|tail|tr a-z/,
      mustTruncate: true,
    },
    {
      label: "a command that fits",
      command: "pnpm build",
      rows: /pnpm build/,
      mustTruncate: false,
    },
  ];

  const mountArgsRow = async (label, { command, settled }) => {
    const argsRow = {
      id: `msg-args-${label}`,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: `call-args-${label}`,
          name: "run_command",
          // A settled part carries an output; a live one does not.
          state: settled ? "complete" : "input-available",
          arguments: JSON.stringify({ command }),
          ...(settled
            ? { output: { command, stdout: "", stderr: "", exitCode: 0, durationMs: 5, success: true } }
            : {}),
        },
      ],
    };
    const rowStdout = new FakeStdout();
    const instance = render(createElement(Screen, { messages: [argsRow] }), {
      stdout: rowStdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 30,
    });
    await settle(220);
    const lines = frameLines(rowStdout);
    instance.unmount();
    return lines;
  };

  for (const [i, c] of ARGS_ROWS.entries()) {
    const settledLines = await mountArgsRow(`settled-${i}`, { command: c.command, settled: true });
    const argRows = settledLines.filter((l) => c.rows.test(l)).length;
    // A budget of two rows total, and the marker only when the input genuinely overflowed.
    record(
      `a settled run_command's arguments stay within two rows (${c.label})`,
      argRows > 0 && argRows <= 2 && settledLines.some((l) => l.includes("…")) === c.mustTruncate,
      { argRows, mustTruncate: c.mustTruncate, frame: settledLines.slice(6, 12) }
    );

    const liveLines = await mountArgsRow(`live-${i}`, { command: c.command, settled: false });
    const liveRows = liveLines.filter((l) => c.rows.test(l)).length;
    // The point of the split: before the call has an output the arguments are what the user
    // must read, so they stay verbatim — all 40 rows of them.
    record(
      `a live run_command still shows its arguments verbatim (${c.label})`,
      c.mustTruncate ? liveRows > 2 : liveRows === 1,
      { liveRows, frame: liveLines.slice(6, 12) }
    );
  }
}

// ── a settled result block keeps its row budget ───────────────────────────────
//
// The result block is fed logical lines (`splitStreamingLines`), and `formatRunCommandOutput`
// budgets those to three per stream. But its `<Text>` has no `wrap` prop, so Ink wraps each
// logical line at the terminal width — one 400-char line of compiler output occupies four
// rows. Five logical lines measured 17 rendered rows at 114 columns: the truncation was
// counted in lines while the height was spent in rows, so the budget it enforced was not the
// budget the screen paid.
{
  const wide = (ch) => ch.repeat(400);
  const mountOutputRow = async (label, output, stdoutWidth = 120) => {
    const row = {
      id: `msg-out-${label}`,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: `call-out-${label}`,
          name: "run_command",
          state: "complete",
          arguments: JSON.stringify({ command: "build" }),
          output,
        },
      ],
    };
    const rowStdout = new FakeStdout();
    rowStdout.columns = stdoutWidth;
    const instance = render(createElement(Screen, { messages: [row] }), {
      stdout: rowStdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 30,
    });
    await settle(220);
    const lines = frameLines(rowStdout);
    instance.unmount();
    return lines;
  };

  const stdoutRows = {
    command: "build",
    // Four long lines: the formatter keeps three and collapses the rest, but each kept line
    // wraps to several rows on its own.
    stdout: [wide("a"), wide("b"), wide("c"), wide("d")].join("\n"),
    stderr: "",
    exitCode: 0,
    durationMs: 5,
    success: true,
  };
  const outLines = await mountOutputRow("wide-stdout", stdoutRows);
  // The block is ▄ bar + content + ▀ bar, inside a half-line padded box. Count only the
  // content rows: those between the two bars.
  const topBar = outLines.findIndex((l) => /^\s*▄/.test(l));
  const bottomBar = outLines.findIndex((l, i) => i > topBar && /^\s*▀/.test(l));
  const contentRows = topBar >= 0 && bottomBar > topBar ? bottomBar - topBar - 1 : -1;
  record("a settled result block's rows match the line budget it enforces", contentRows > 0 && contentRows <= 6, {
    contentRows,
    topBar,
    bottomBar,
    tail: outLines.slice(-6),
  });

  const bothStreams = {
    command: "build",
    stdout: [wide("a"), wide("b"), wide("c"), wide("d")].join("\n"),
    stderr: [wide("e"), wide("f"), wide("g"), wide("h")].join("\n"),
    exitCode: 1,
    durationMs: 5,
    success: false,
  };
  const bothLines = await mountOutputRow("wide-both", bothStreams);
  const bothTop = bothLines.findIndex((l) => /^\s*▄/.test(l));
  const bothBottom = bothLines.findIndex((l, i) => i > bothTop && /^\s*▀/.test(l));
  const bothRows = bothTop >= 0 && bothBottom > bothTop ? bothBottom - bothTop - 1 : -1;
  record("stdout and stderr each keep their own row budget", bothRows > 0 && bothRows <= 12, {
    bothRows,
    tail: bothLines.slice(-8),
  });
}

// ── footer-relative exit summary ─────────────────────────────────────────────
// The exit summary is appended BELOW the footer, set off by its own top border. Mounted with a
// stand-in for the first line rather than the real transcript: the question is whether the
// summary lands under whatever precedes it, separated by the border, and a real `MessageList`
// would make "which rule is whose" ambiguous.
{
  // `useInitTerminalSize` is a hook, so it has to run inside a render — same shape as `Screen`.
  // The sentinel is a full literal line so "is it gone" is answerable without substring games.
  const FIRST_LINE_MARKER = "FIRSTLINE_LIVE_TRANSCRIPT_MARKER";
  const ExitSummaryScreen = () => {
    useSize.getActions().useInitTerminalSize();
    return createElement("ink-box", { flexDirection: "column" }, [
      createElement("ink-text", { key: "first-line" }, FIRST_LINE_MARKER),
      createElement(ExitSummary, { key: "summary" }),
    ]);
  };

  const footerStdout = new FakeStdout();
  const footerInstance = render(createElement(ExitSummaryScreen, {}), {
    stdout: footerStdout,
    stdin: fakeStdin(),
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 30,
  });
  await settle(120);
  useAgent.getActions().beginExit(["Session:   local-chat (ses_abc)", "", "Cost:      $0.12"]);
  await settle(220);

  const summaryLines = frameLines(footerStdout);
  const text = summaryLines.join("\n");
  const borderIdx = summaryLines.findIndex((l) => /─{20,}/.test(l));
  // No heading row: the summary opens straight on its first line, so the border's job is to
  // separate it from whatever is above, and "below the border" is the first captured line.
  const firstLineIdx = summaryLines.findIndex((l) => l.trim().startsWith("Session:"));

  // The border must come BEFORE the summary's first line and span the width — that is what makes
  // it a divider from whatever is above rather than a rule floating inside the block, and it is
  // the only thing here that can fail: deleting the border drops `borderIdx` to -1, and
  // `width="full"` is what makes it reach the screen edge like the footer's own rule.
  // Deliberately NOT asserted as "below the sentinel": this wrapper puts the sentinel first,
  // so such a check could not fail. Placement under the footer is `Agent`'s literal ordering.
  record(
    "the summary opens with a full-width border above its first line",
    borderIdx !== -1 && firstLineIdx !== -1 && borderIdx < firstLineIdx && summaryLines[borderIdx].length >= 100,
    { firstLines: summaryLines.slice(0, 4), borderWidth: summaryLines[borderIdx]?.length }
  );
  record("the summary keeps its captured lines verbatim", text.includes("Session:   local-chat (ses_abc)"), {});
  record("no heading is painted above the summary", !summaryLines.some((l) => /Session summary/i.test(l)), {
    firstLines: summaryLines.slice(0, 3),
  });
  // The builder emits a blank string between groups, and `frameLines` filters empties — so the
  // gap has to be read from the RAW frame. This is a real regression risk: an empty `<Text>` is
  // a zero-height row, so rendering every line as a plain `<Text>{line}</Text>` silently drops
  // the gap and pushes the groups together.
  const raw = rawFrameLines(footerStdout);
  const rawFirst = raw.findIndex((l) => l.includes("Session:"));
  record(
    "a blank group line still occupies a row",
    rawFirst !== -1 && raw[rawFirst + 1].trim() === "" && raw[rawFirst + 2].includes("Cost:"),
    { rows: raw.slice(rawFirst, rawFirst + 3).map((l) => JSON.stringify(l)) }
  );

  footerInstance.unmount();
  useAgent.getActions().beginExit(null);
}

// ── task list cursor memory across a list↔detail round-trip ──────────────────
// The row cursor lives outside the list component on purpose: the list unmounts while the detail
// view is shown, so a component-local index resets on every return. Driving the real key
// handlers (not the store's actions directly) is the point — a store-only test stays green even
// if the list goes back to its own `useState(0)`.
{
  const tasks = [
    { id: "task-a", name: "subagent-alpha", status: "completed" },
    { id: "task-b", name: "subagent-bravo", status: "completed" },
    { id: "task-c", name: "subagent-charlie", status: "completed" },
  ];
  // Rows come from the root session's snapshot, so the smoke needs a root session. Hand-rolled:
  // the subject here is the cursor, not a live agent.
  const fakeRoot = {
    id: "root-session",
    getSnapshot: () => ({ subagents: tasks }),
    subscribe: () => () => {},
  };

  useSubagentPanel.getActions().close();
  useAgent.getActions().setSession(fakeRoot);
  useSubagentPanel.getActions().openList();

  const listStdout = new FakeStdout();
  const listStdin = fakeStdin();
  // Wrapped in the `task` scope: a surface hook outside any scope is inert by design, which is
  // what stops a stray panel from answering the chat's keys.
  const listInstance = render(createElement(InputScopeProvider, { value: "task" }, createElement(SubagentPanel, {})), {
    stdout: listStdout,
    stdin: listStdin,
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 30,
  });
  await settle(200);

  const press = async (seq, wait = 80) => {
    // `useInput` reads through `stdin.read()` on the `"readable"` event, so input has to be
    // pushed into the Readable — emitting `"data"` never reaches it (and would put the stream in
    // flowing mode).
    listStdin.push(seq);
    await settle(wait);
  };
  const rows = () => frameLines(listStdout).filter((l) => /\b(alpha|bravo|charlie)\b/.test(l));
  // The cursor row is the one carrying the `❯` marker; its task label is the identity we track.
  // Labels are `getTaskLabel`'s — the `subagent-` prefix is stripped, so these read `alpha`.
  const cursorLabel = () => {
    const marked = frameLines(listStdout).find((l) => l.includes("❯"));
    const match = marked?.match(/\b(alpha|bravo|charlie)\b/);
    return match ? match[0] : null;
  };

  record("the task list renders a row per task", rows().length === 3, { rows: rows() });
  record("the cursor starts on the first row", cursorLabel() === "alpha", { cursor: cursorLabel() });

  await press("\u001B[B"); // ↓
  record("down moves the cursor to the second row", cursorLabel() === "bravo", {
    cursor: cursorLabel(),
  });

  await press("\r"); // ⏎ → detail
  record(
    "enter opens the detail view for the selected row",
    useSubagentPanel.getReadonlyState().view === "detail" &&
      useSubagentPanel.getReadonlyState().selectedSubagentId === "task-b",
    { view: useSubagentPanel.getReadonlyState().view, id: useSubagentPanel.getReadonlyState().selectedSubagentId }
  );
  record("the detail view replaces the list", rows().length === 0, { rows: rows() });

  await press("\u001B"); // Esc → back to list
  record("esc returns to the list", useSubagentPanel.getReadonlyState().view === "list", {
    view: useSubagentPanel.getReadonlyState().view,
  });
  record("the list is rendered again after coming back", rows().length === 3, { rows: rows() });
  // The regression this whole block exists for: a fresh open starts at row 0, so a local index
  // would leave the cursor on alpha here.
  record("the cursor is still on the row it was on before detail", cursorLabel() === "bravo", {
    cursor: cursorLabel(),
    rows: rows(),
  });

  // Rows can vanish (a subagent is destroyed) while the cursor sits past the new end. The stored
  // index is deliberately left out of range, so what keeps the panel sane is the clamp on read.
  useSubagentPanel.getActions().setSelectedIndex(99);
  await settle(120);
  record("an out-of-range cursor is clamped to the last row", cursorLabel() === "charlie", {
    cursor: cursorLabel(),
  });

  listInstance.unmount();
  useSubagentPanel.getActions().close();
  useAgent.getActions().setSession(null);
}

// ── resume picker: the cursor must stay on screen ──────────────────────────
// One defect lived in this component and it is not visible in a static render:
//
//   it rendered `sessions.slice(0, 10)` unconditionally, so past row 10 the `❯` cursor kept
//   moving through a set that was no longer drawn — arrows appeared dead because a repaint
//   with identical rows paints nothing.
//
// (The picker used to share this section with the `isAnyPanelOpen()` gate — arrows reaching the
// chat's prompt history behind the picker. Input ownership is structural now: see the
// `input routing` section, which asserts the same property through `InputScope`.)
{
  const sessions = Array.from({ length: 12 }, (_, i) => ({
    id: `ses-${i}`,
    name: `session-${String(i).padStart(2, "0")}`,
    model: "test-model",
    updatedAt: Date.now() - i * 1000,
  }));

  const pickerStdout = new FakeStdout();
  const pickerStdin = fakeStdin();
  // The picker replaces the chat screen, so it takes the `main` scope.
  const pickerInstance = render(
    createElement(
      InputScopeProvider,
      { value: "main" },
      createElement(SessionPicker, { sessions, onSelect: () => {}, onCancel: () => {} })
    ),
    {
      stdout: pickerStdout,
      stdin: pickerStdin,
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 30,
    }
  );
  await settle(200);

  const press = async (seq, wait = 80) => {
    pickerStdin.push(seq);
    await settle(wait);
  };
  // The cursor row is the one carrying `❯`; its session name is the identity we track.
  const cursorName = () =>
    frameLines(pickerStdout)
      .find((l) => l.includes("❯"))
      ?.match(/session-\d\d/)?.[0] ?? null;
  const renderedNames = () =>
    frameLines(pickerStdout)
      .map((l) => l.match(/session-\d\d/)?.[0])
      .filter(Boolean);

  record("the resume picker renders only a slice of a long list", renderedNames().length === MAX_VISIBLE_SESSIONS, {
    rows: renderedNames(),
  });
  record("the resume picker starts on the first row", cursorName() === "session-00", { cursor: cursorName() });

  for (let i = 0; i < 10; i++) await press("\u001B[B"); // ↓ × 10 → row 10, off the first page
  record(
    "the cursor row is still drawn after scrolling past the first page",
    cursorName() !== null && renderedNames().includes(cursorName()),
    { cursor: cursorName(), rows: renderedNames() }
  );
  record("scrolling moved the window instead of dropping the cursor", cursorName() === "session-10", {
    cursor: cursorName(),
    rows: renderedNames(),
  });

  await press("\u001B[B"); // ↓ → last row
  record("the cursor reaches the last row", cursorName() === "session-11", {
    cursor: cursorName(),
    rows: renderedNames(),
  });
  record("the last page shows the tail of the list", renderedNames().includes("session-11"), {
    rows: renderedNames(),
  });

  pickerInstance.unmount();
}

// ── resume picker: a long title must not wrap the row ────────────────────────
// The row is `title ··· meta`, and BOTH halves have to stay on one line: a title that wraps
// pushed the meta down (at width 60 a single session spent three rows and cut the date
// mid-token), which made the list unreadable and its height unpredictable. `useSize` is what
// the width split reads, and the real app only initialises it inside `Agent`, so the mount
// below mirrors that — without it `screenWidth` is 0 and every column collapses to `…`.
{
  const LONG_TITLE = "Refactor the runtime so a host can own several live agent instances at once";
  const sessions = [
    { id: "long", name: LONG_TITLE, model: "anthropic/claude-sonnet-4", updatedAt: Date.now() },
    { id: "short", name: "Add Parallel and Tavily websearch providers", model: "openai/gpt-5", updatedAt: Date.now() },
  ];
  const Screen = () => {
    useSize.getActions().useInitTerminalSize();
    return createElement(
      InputScopeProvider,
      { value: "main" },
      createElement(SessionPicker, { sessions, onSelect: () => {}, onCancel: () => {} })
    );
  };

  const titleStdout = new FakeStdout();
  const titleInstance = render(createElement(Screen), {
    stdout: titleStdout,
    stdin: fakeStdin(),
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 30,
  });
  await settle(200);

  /** Body rows: everything but the title/hint header and `ScrollableList`'s `──` rails. */
  const bodyRows = () => frameLines(titleStdout).filter((l) => !/Resume Session/.test(l) && !/^[─ ]+$/.test(l));

  for (const cols of [60, 80, 120]) {
    await resizeAndPaint(titleStdout, cols);
    const rows = bodyRows();

    record(`a long session title stays on one row at width ${cols}`, rows.length === sessions.length, {
      cols,
      rowCount: rows.length,
      rows,
    });
    // The meta is the half that must survive: a title is recognisable from its opening words, a
    // cut model name is not.
    record(
      `the model/date meta survives on every row at width ${cols}`,
      rows.every((l) => /\(.+/.test(l)),
      {
        cols,
        rows,
      }
    );
    // Nothing may bleed past the terminal — the overflow case either wraps (a lost row) or is
    // silently clipped by the terminal (content the user never sees).
    record(
      `no row overflows the terminal at width ${cols}`,
      rows.every((l) => l.length <= cols),
      {
        cols,
        widths: rows.map((l) => l.length),
      }
    );
  }

  // The ellipsis itself: at 60 columns the long title must actually be cut, and cut with `…`
  // rather than trimmed at a fixed column with no indication.
  await resizeAndPaint(titleStdout, 60);
  const narrow = bodyRows();
  record("an over-long title is ellipsised instead of clipped", narrow[0]?.includes("…") === true, {
    row: narrow[0],
  });

  // The converse, at a width with room for the short row: a row that FITS must not be
  // ellipsised, or the truncation would be unconditional rather than driven by the width.
  // It has to be measured per row — at 120 the long title still needs cutting (72 chars into a
  // 53-wide column), so "every row is clean" would be asserting the wrong thing.
  await resizeAndPaint(titleStdout, 120);
  const wide = bodyRows();
  record("a row that fits is not ellipsised at all", wide[1]?.includes("…") !== true, {
    rows: wide,
  });

  titleInstance.unmount();
}

// ── workspace header: a narrow bar shortens, it does not shred ─────────────
// Every group in the bar is a `<Text>`, and Ink boxes default to `flexShrink: 1`. Without a
// width-aware plan a narrow terminal shrinks ALL of them and the renderer truncates inside each
// one — the reported symptom was `Worksp · ● diff · … · mai 1 +−1`, i.e. five half-words, with
// the root path gone entirely. `planWorkspaceHeader` (tested directly in
// `test/workspace-header-layout.test.mjs`) drops the least informative groups instead; this check
// pins that the assembled component actually renders that way.
{
  const gitInfo = { branch: "main", shortSha: "abc1234", dirty: true, ahead: 1, behind: 0 };
  const diffStats = {
    files: new Map([
      ["a.ts", { added: 1, deleted: 0 }],
      ["b.ts", { added: 2, deleted: 1 }],
    ]),
    totalAdded: 3,
    totalDeleted: 1,
  };
  const rootPath = "/Users/example/Documents/GitHub/translate";

  const Screen = () => {
    useSize.getActions().useInitTerminalSize();
    return createElement(WorkspaceModeHeader, { mode: "diff", rootPath, gitInfo, diffStats });
  };

  const headerStdout = new FakeStdout();
  const headerInstance = render(createElement(Screen), {
    stdout: headerStdout,
    stdin: fakeStdin(),
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 30,
  });
  await settle(200);

  for (const cols of [120, 90, 60, 40]) {
    await resizeAndPaint(headerStdout, cols);
    const row = frameLines(headerStdout)[0] ?? "";

    // The groups that identify the view: a torn word here is the bug itself.
    for (const word of ["Workspace", "diff", "main*"]) {
      record(`the workspace header keeps ${word} intact at width ${cols}`, row.includes(word), { cols, row });
    }
    record(`the workspace header fits the terminal at width ${cols}`, row.length <= cols, {
      cols,
      length: row.length,
      row,
    });
  }

  // Degradation is visible in the bar rather than in a torn word: at 40 the full path is gone,
  // while the totals it gave way for are still there.
  const narrowRow = frameLines(headerStdout)[0] ?? "";
  record("the workspace header drops the path instead of shredding it", !narrowRow.includes(rootPath), {
    row: narrowRow,
  });

  headerInstance.unmount();
}

// ── the loading splash names startup, not the sandbox ────────────────────────
// The `loading` variant is what covers `initLoading`, and its copy is a claim about what the
// user is waiting for. It used to read "Initializing sandbox…", but the OS sandbox is not on
// the startup path at all: `ensureOsSandbox()` runs on the FIRST `run_command` (~5ms, and it
// degrades gracefully when bubblewrap/socat/rg are missing). The phase really awaits the
// workspace git probe plus `adapter.initialize`, so the label has to describe that instead of
// naming a subsystem the startup never touches. The check binds the component's DEFAULT (no
// `loadingText` prop), because that default is the one place the label is written — `Agent`
// renders the loading variant bare.
{
  const splashStdout = new FakeStdout();
  splashStdout.columns = 100;
  // No `loadingText` prop: the assertion has to bind the component's DEFAULT, because that
  // default is the single source of the label `Agent` renders. Passing the string here would
  // make the check tautological — it would pass even after the default regressed.
  const splashInstance = render(createElement(WelcomePanel, { variant: "loading", screenWidth: 100 }), {
    stdout: splashStdout,
    stdin: fakeStdin(),
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 30,
  });
  await settle(200);
  const splashFrame = frameLines(splashStdout).join("\n");

  // Wiring: the splash actually paints the exported label. This is NOT the regression guard —
  // reverting the constant to the old copy keeps it passing, because it only checks that the
  // component renders whatever the label is. That division is the point: one check proves the
  // label is wired up, the other proves the label is CORRECT.
  record("the loading splash paints the exported status label", splashFrame.includes(LOADING_STATUS_TEXT), {
    frame: frameLines(splashStdout),
  });
  // The regression guard: the sandbox is NOT initialised during startup, so the splash must not
  // claim it is. Reverting the copy to "Initializing sandbox…" fails THIS one and nothing else.
  record("the loading splash does not claim to initialise the sandbox", !/sandbox/i.test(splashFrame), {
    frame: frameLines(splashStdout),
  });
  splashInstance.unmount();
}

// ── the image preview zooms by asking the host for a smaller window ─────────
// Half-block characters give one cell 1×2 pixels, so a whole screenshot in a panel is a thumbnail.
// The fix is NOT a bigger raster (8× the cells would be megabytes of ANSI): the component asks the
// host to decode a smaller SOURCE window and draw it into the same cells. That is what these checks
// pin — the request shape, and that the picture stays inside the pane at every zoom.
{
  const calls = [];
  const paneWidth = 60;
  const paneHeight = 20;
  let slowFile = false;
  const env = {
    rootPath: "/fake",
    fs: {
      stat: async () => ({ isFile: true, isDirectory: false, size: 1024, mtime: new Date(0) }),
      readFile: async () => new Uint8Array([1, 2, 3]),
    },
    imageToText: async (bytes, options) => {
      calls.push(options);
      // The second file answers slowly so the switch itself can be observed: with an instant decoder
      // there is no window in which "the previous picture" could be visible.
      if (calls.length > 0 && slowFile) await new Promise((resolve) => setTimeout(resolve, 400));
      const cols = options.maxCols;
      const rows = Array.from({ length: Math.min(options.maxRows, 8) }, () =>
        "\u001b[38;2;255;0;0m\u001b[48;2;0;0;255m\u2580".repeat(cols)
      );
      return {
        rows,
        imageWidth: 800,
        imageHeight: 600,
        region: options.region ?? { x: 0, y: 0, width: 800, height: 600 },
      };
    },
  };

  const previewStdout = new FakeStdout();
  previewStdout.columns = paneWidth + 10;
  const instance = render(
    createElement(
      CoreEnvProvider,
      { value: env },
      createElement(WorkspaceImagePreview, {
        filePath: "/fake/workspace-file.png",
        width: paneWidth,
        height: paneHeight,
        color: true,
      })
    ),
    { stdout: previewStdout, stdin: fakeStdin(), exitOnCtrlC: false, patchConsole: false, maxFps: 30 }
  );
  await settle(300);

  const fitFrame = frameLines(previewStdout);
  record(
    "the image preview paints the decoded rows",
    fitFrame.some((line) => line.includes("\u2580")),
    {
      frame: fitFrame.slice(0, 3),
    }
  );
  record("the image preview names the file", fitFrame.join("\n").includes("workspace-file.png"), {
    frame: fitFrame[0] ?? null,
  });
  record("the fitted preview asks for the WHOLE image", calls.length > 0 && calls[0].region === undefined, {
    firstCall: calls[0] ?? null,
  });
  record(
    "every rendered row fits the pane",
    fitFrame.filter((line) => line.trim().length > 0).every((line) => line.length <= paneWidth + 10),
    { widths: fitFrame.map((line) => line.length) }
  );
  record(
    "the picture fills its row budget without spilling a line out of the pane",
    fitFrame.filter((line) => line.trim().length > 0).length <= paneHeight,
    { painted: fitFrame.filter((line) => line.trim().length > 0).length, paneHeight }
  );

  // Zoom in twice (1 → 1.5 → 2) through the same store the panel's keys write to.
  calls.length = 0;
  useWorkspacePanel.getActions().zoomImage(1);
  useWorkspacePanel.getActions().zoomImage(1);
  await settle(300);

  const zoomFrame = frameLines(previewStdout);
  const zoomCall = calls.at(-1);
  record("zooming in shows the zoom factor", zoomFrame.join("\n").includes("2×"), { frame: zoomFrame[0] ?? null });
  record("zooming in asks the host for a source window", Boolean(zoomCall?.region), { call: zoomCall ?? null });
  record(
    "the zoom window is a fraction of the image, not the whole one",
    Boolean(zoomCall?.region) && zoomCall.region.width < 800 && zoomCall.region.height < 600,
    { region: zoomCall?.region ?? null }
  );
  record(
    "the zoom window matches the pane's cell aspect",
    Boolean(zoomCall?.region) && Math.abs(zoomCall.region.width / zoomCall.region.height - paneWidth / (20 * 2)) < 0.05,
    { region: zoomCall?.region ?? null, paneAspect: paneWidth / 40 }
  );

  // A file switch must not paint the previous picture under the new name, and must not compute a zoom
  // window from the OLD image's size (which is what a shared `ready` state used to do).
  calls.length = 0;
  slowFile = true;
  useWorkspacePanel.getActions().zoomImage(1);
  instance.rerender(
    createElement(
      CoreEnvProvider,
      { value: env },
      createElement(WorkspaceImagePreview, {
        filePath: "/fake/other.png",
        width: paneWidth,
        height: paneHeight,
        color: true,
      })
    )
  );
  await settle(80);
  const switchedEarly = frameLines(previewStdout).join("\n");
  record("a file switch does not paint the previous picture", !switchedEarly.includes("\u2580"), {
    frame: frameLines(previewStdout).slice(0, 2),
  });
  await settle(300);

  useWorkspacePanel.getActions().resetImageView();
  instance.unmount();
}

// ── input routing: one screen owns a keystroke ───────────────────────────────
// The renderer broadcasts every keystroke to every subscribed handler, so "which screen owns the
// keyboard" can only be expressed by WHICH handlers are subscribed. These mounts assert that
// through the real hooks against the real renderer:
//
//   1. a `main` handler rendered inside the workspace screen is inert — the shape that used to
//      leak (the chat's handlers stayed subscribed under every panel and each one had to remember
//      `if (isAnyPanelOpen()) return`),
//   2. a handler mounted by another handler's state change never sees the keystroke that mounted
//      it — which is why the 300ms close debounce (`panelJustClosed`) could be deleted.
{
  const routingStdout = new FakeStdout();
  const routingStdin = fakeStdin();
  const seen = [];
  const onKey = (id) => () => seen.push(id);

  const MainProbe = ({ id, when }) => {
    useMainInput(onKey(id), { when });
    return null;
  };
  const WorkspaceProbe = ({ id, when }) => {
    useWorkspacePanelInput(onKey(id), { when });
    return null;
  };

  const Screen = () =>
    createElement(
      InputScopeProvider,
      { value: "workspace" },
      createElement(MainProbe, { id: "main", when: true }),
      createElement(WorkspaceProbe, { id: "workspace", when: true }),
      createElement(WorkspaceProbe, { id: "workspace-off", when: false })
    );

  const routingInstance = render(createElement(Screen), {
    stdout: routingStdout,
    stdin: routingStdin,
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 30,
  });
  await settle(120);

  routingStdin.push("x");
  await settle(80);
  record("a keystroke reaches only the mounted surface's handlers", seen.join(",") === "workspace", {
    seen: [...seen],
  });

  routingInstance.unmount();

  // Same property, expressed as the close-on-the-same-keystroke race the debounce used to cover.
  seen.length = 0;
  const raceStdin = fakeStdin();
  const Second = ({ id }) => {
    useMainInput(onKey(id));
    return null;
  };
  const Racer = () => {
    const [armed, setArmed] = useState(false);
    useMainInput(() => {
      seen.push("first");
      setArmed(true);
    });
    return armed ? createElement(Second, { id: "second" }) : null;
  };
  const raceInstance = render(createElement(InputScopeProvider, { value: "main" }, createElement(Racer)), {
    stdout: new FakeStdout(),
    stdin: raceStdin,
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 30,
  });
  await settle(120);

  raceStdin.push("a");
  await settle(80);
  record("a handler mounted by this keystroke does not receive it", seen.join(",") === "first", { seen: [...seen] });

  raceStdin.push("b");
  await settle(80);
  // Listener ORDER is not part of the contract: an inline handler re-subscribes on every render, so
  // which of the two runs first is an implementation detail. What matters is that both run — the
  // newly mounted one and the one that mounted it.
  record("the next keystroke reaches both handlers", seen.slice(1).sort().join(",") === "first,second", {
    seen: [...seen],
  });

  raceInstance.unmount();
}

// ── input routing: the two chords that are not a screen's own ─────────────────
// Moving the handlers onto their screens deleted two things that used to come for free from an
// always-subscribed global handler, and both were silent:
//
//   1. Ctrl+C stopped working everywhere except the chat (the renderer exits only on its own
//      `exitOnCtrlC`, which the CLI sets to false) — so the exit chord is registered on every
//      screen through `useExitInput`,
//   2. the first-run config wizard is mounted by the HOST, outside `Agent`, so it had no scope and
//      its handlers were inert — a fresh install could not be configured at all.
{
  const exitStdout = new FakeStdout();
  const exitStdin = fakeStdin();
  const seen = [];

  const ExitProbe = () => {
    useExitInput((input, key) => {
      if (key.ctrl && input === "c") seen.push("exit");
    });
    return null;
  };
  const MainProbe = () => {
    useMainInput((input) => seen.push(`main:${input}`));
    return null;
  };
  const WorkspaceProbe = () => {
    useWorkspacePanelInput((input) => seen.push(`workspace:${input}`));
    return null;
  };

  const instance = render(
    createElement(
      InputScopeProvider,
      { value: "workspace" },
      createElement(ExitProbe),
      createElement(MainProbe),
      createElement(WorkspaceProbe)
    ),
    { stdout: exitStdout, stdin: exitStdin, exitOnCtrlC: false, patchConsole: false, maxFps: 30 }
  );
  await settle(120);

  exitStdin.push("\u0003"); // Ctrl+C
  await settle(80);
  record("Ctrl+C is handled while a panel owns the screen", seen.includes("exit"), { seen: [...seen] });
  record("and it does not reach the chat's handlers", !seen.some((s) => s.startsWith("main:")), { seen: [...seen] });

  instance.unmount();
}

// ── the config wizard's keys live inside a scope ──
// The first-run wizard is mounted directly by the CLI host, so nothing in `Agent` wraps it. It was
// keyboard-dead until the host provided the `main` scope; this mount pins the component itself.
{
  const wizardStdout = new FakeStdout();
  const wizardStdin = fakeStdin();
  const chosenStyle = () =>
    frameLines(wizardStdout)
      .map((l) => l.match(/^\s*\S?\s*(openai|anthropic)$/)?.[1])
      .find((v) => v);
  const cursorStyle = () =>
    frameLines(wizardStdout)
      .map((l) => l.match(/❯\s*(openai|anthropic)/)?.[1])
      .find((v) => v);

  const instance = render(
    createElement(
      InputScopeProvider,
      { value: "main" },
      createElement(ConfigEditor, {
        onDone: () => {},
        onCancel: () => {},
        parseModelsConfig: (raw) => JSON.parse(raw),
        saveModelsConfig: async () => {},
      })
    ),
    { stdout: wizardStdout, stdin: wizardStdin, exitOnCtrlC: false, patchConsole: false, maxFps: 30 }
  );
  await settle(200);

  record("the config wizard opens on the style step", Boolean(chosenStyle()), { styles: [chosenStyle()] });
  const first = cursorStyle();
  wizardStdin.push("\u001B[B"); // ↓
  await settle(120);
  record("a scoped keypress reaches the config wizard", Boolean(first) && cursorStyle() !== first, {
    before: first,
    after: cursorStyle(),
  });

  instance.unmount();
}

const pass = results.every((r) => r.pass);
console.log(
  JSON.stringify({ source: sessionPath ?? "fixture(60 turns x 4 tools)", messages: all.length, results, pass }, null, 2)
);
process.exit(pass ? 0 : 1);
