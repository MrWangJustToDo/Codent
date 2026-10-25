import { Box, Text, useApp, useIsScreenReaderEnabled } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAdapter } from "../context/adapter-context.js";
import { useCoreEnv } from "../context/core-env-context.js";
import { useWorkspacePanelInput } from "../hooks/input";
import { useEditorHandoff } from "../hooks/use-editor-handoff.js";
import { useSize } from "../hooks/use-size.js";
import { useWorkspaceGit } from "../hooks/use-workspace-git.js";
import { useWorkspacePanel } from "../hooks/use-workspace-panel.js";
import { COLORS } from "../theme/colors.js";
import { isImagePath } from "../utils/file-icons.js";
import { workspacePanelHint } from "../utils/keyboard-labels.js";
import { clearWorkspaceDiffStatsCache } from "../utils/workspace-diff-stats.js";
import { changedFileJumpTarget } from "../utils/workspace-diff-tree.js";
import { computeDirStatuses } from "../utils/workspace-dir-status.js";
import { clearWorkspaceFileListCache } from "../utils/workspace-file-search.js";
import { clearWorkspaceDiffCache } from "../utils/workspace-git-diff.js";
import { clearGitStatusCache } from "../utils/workspace-git-status.js";
import { workspaceRelativePath } from "../utils/workspace-path.js";
import { decideReveal } from "../utils/workspace-reveal.js";
import { clampScrollTop, ensureIndexVisible } from "../utils/workspace-scroll.js";

import { clearContentCache } from "./FileContent.js";
import { clearDirCache, FileTree, useDiffFileTree, useFileTree } from "./FileTree.js";
import { HEADER_LINES, WorkspaceModeHeader } from "./WorkspaceModeHeader.js";
import { PANE_TITLE_LINES, WorkspacePane } from "./WorkspacePane.js";
import { WorkspacePreviewPane } from "./WorkspacePreviewPane.js";
import { WorkspaceQuickOpen } from "./WorkspaceQuickOpen.js";

import type { EditorTarget } from "../adapter/types.js";
import type { CodeViewRef, DiffViewRef } from "@git-diff-view/cli";
import type { Key } from "ink";

// ============================================================================
// Constants
// ============================================================================

const TREE_WIDTH_RATIO = 0.34;
const MIN_TREE_WIDTH = 28;
const MIN_PREVIEW_WIDTH = 24;
const FOOTER_LINES = 1;
const PREVIEW_SCROLL_STEP = 3;

// ============================================================================
// File mode
// ============================================================================

export const WorkspaceFileMode = () => {
  const env = useCoreEnv();
  const adapter = useAdapter();
  const { setOptions } = useApp();
  const editorNotice = useEditorHandoff((s) => s.notice);
  /** Whether this host can hand the terminal to an editor; browser hosts cannot, and hide the key. */
  const canEdit = typeof adapter.openInEditor === "function";
  const paneFocus = useWorkspacePanel((s) => s.paneFocus);
  const mode = useWorkspacePanel((s) => s.mode);
  const selectedPath = useWorkspacePanel((s) => s.selectedPath);
  const treeScrollTop = useWorkspacePanel((s) => s.treeScrollTop);
  const quickOpen = useWorkspacePanel((s) => s.quickOpen);
  const imageZoom = useWorkspacePanel((s) => s.imageZoom);
  const screenReader = useIsScreenReaderEnabled();
  const { close, openQuickOpen, selectFile, setPaneFocus, toggleMode, setTreeScrollTop } =
    useWorkspacePanel.getActions();
  const { zoomImage, panImage, resetImageView } = useWorkspacePanel.getActions();

  const previewRef = useRef<CodeViewRef>(null);
  const diffRef = useRef<DiffViewRef>(null);

  const [rootPath, setRootPath] = useState("");
  const [cursorIndex, setCursorIndex] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  /** Transient footer message (`[]` with nowhere to go), auto-cleared. */
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);
  /**
   * The selected path the tree cursor has already been aligned to.
   *
   * The reveal effect must move the cursor when a selection ARRIVES (a `[` / `]` jump, a quick-open
   * pick, a Right on a file), and must not move it just because `items` was rebuilt. Rows are rebuilt
   * whenever the git status or the diff tree changes, and the reveal effect runs on every identity
   * change — so without this gate a 10s refresh tick re-ran it with a `select` action and yanked the
   * cursor back to the selected file, discarding wherever ↑/↓ had put it.
   *
   * "A selection arrived" is not the same condition as "a row is missing": the mount has no
   * selection yet, and a selection is not raised for every rebuild. Tracking the path the cursor was
   * last aligned to is what separates the two — a ref, because it is bookkeeping for an effect, not
   * rendered state.
   */
  const alignedSelectionRef = useRef<string | null>(null);

  const { gitStatus, gitRenames, gitInfo, diffStats, statusVersion, refreshGit } = useWorkspaceGit(rootPath);

  const screenWidth = useSize((s) => s.state.screenWidth);
  const screenHeight = useSize((s) => s.state.screenHeight) || 24;

  const bodyHeight = Math.max(10, screenHeight - HEADER_LINES - FOOTER_LINES);
  const paneBodyLines = Math.max(4, bodyHeight - PANE_TITLE_LINES - 2);
  const treeWidth = Math.max(MIN_TREE_WIDTH, Math.floor(screenWidth * TREE_WIDTH_RATIO));
  const previewWidth = Math.max(MIN_PREVIEW_WIDTH, screenWidth - treeWidth - 2);

  const isDiffMode = mode === "diff";

  // The rename source for the selected row, if it is one. `gitRenames` is keyed by relative
  // path and `selectedPath` is absolute, so the lookup goes through the same conversion the
  // tree used to build the row.
  const selectedRenamedFrom = useMemo(() => {
    if (!selectedPath || gitRenames.size === 0) return undefined;
    return gitRenames.get(workspaceRelativePath(rootPath, selectedPath));
  }, [selectedPath, gitRenames, rootPath]);

  const {
    items: fullItems,
    loading: treeLoading,
    toggleDir,
    reload,
    revealPath,
    pendingReveal,
    consumePendingReveal,
  } = useFileTree(rootPath, statusVersion);
  const {
    items: diffItems,
    toggleDir: toggleDiffDir,
    revealDiffDirs,
    resetDiffCollapsed,
  } = useDiffFileTree(gitStatus, rootPath);

  // Diff mode lists only changed files (preprocessed, merged-prefix tree);
  // preview mode shows the full workspace tree.
  const items = isDiffMode ? diffItems : fullItems;
  const handleToggleDir = isDiffMode ? toggleDiffDir : toggleDir;

  const dirStatuses = useMemo(() => computeDirStatuses(env, gitStatus, rootPath), [env, gitStatus, rootPath]);

  const scrollActivePane = useCallback(
    (direction: "up" | "down" | "top") => {
      const ref = mode === "preview" ? previewRef.current : diffRef.current;
      if (!ref) return;
      if (direction === "top") ref.scrollToTop(1);
      else if (direction === "up") ref.scrollUp({ step: PREVIEW_SCROLL_STEP });
      else ref.scrollDown({ step: PREVIEW_SCROLL_STEP });
    },
    [mode]
  );

  const moveCursor = useCallback(
    (nextIndex: number) => {
      const clamped = Math.max(0, Math.min(nextIndex, Math.max(0, items.length - 1)));
      setCursorIndex(clamped);
      const currentScroll = useWorkspacePanel.getReadonlyState().treeScrollTop;
      setTreeScrollTop(ensureIndexVisible(clamped, currentScroll, paneBodyLines, items.length));
    },
    [items.length, paneBodyLines, setTreeScrollTop]
  );

  // Jump between files that have git changes (`[` / `]`), wrapping around.
  //
  // The decision (walk order, wrap-around, reveal chain) is a pure function in
  // `workspace-diff-tree` so it can be pinned by tests; this only applies it. A
  // hidden target is expanded first because its row is absent from `items` —
  // otherwise the cursor would move nowhere while the preview still rendered the
  // file, reading as the jump silently doing nothing. In the full-tree view
  // `revealPath` is the effect's job (keyed off `selectedPath`), so only the
  // diff pane needs the keys.
  const jumpToChanged = useCallback(
    (direction: 1 | -1) => {
      const jump = changedFileJumpTarget(env, gitStatus, rootPath, selectedPath, direction);
      if (!jump) {
        // A silent no-op reads as a dead key. Say why: no changed files at all
        // (the git status may predate the edit the user is looking for — `r`
        // refreshes it), or the walk is already on the only changed file.
        setJumpNotice(gitStatus.size === 0 ? "no changed files — press r to refresh" : "no other changed files");
        return;
      }
      if (isDiffMode) revealDiffDirs(jump.revealKeys);
      selectFile(jump.target);
    },
    [env, gitStatus, rootPath, selectedPath, selectFile, isDiffMode, revealDiffDirs]
  );

  useEffect(() => {
    if (!jumpNotice) return;
    const timer = setTimeout(() => setJumpNotice(null), 2000);
    return () => clearTimeout(timer);
  }, [jumpNotice]);

  // A handoff failure is a message the user has to read after the editor is gone, so it outlives the
  // 2s used for "no other changed files" and clears itself from the store (it is not this screen's
  // state — the screen it was meant for no longer exists when it arrives).
  useEffect(() => {
    if (!editorNotice) return;
    const timer = setTimeout(() => useEditorHandoff.getActions().setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [editorNotice]);

  useEffect(() => {
    setRootPath(env.rootPath);
  }, [env]);

  // A mode switch swaps the whole row set (`fullItems` ↔ `diffItems`), so a row index no longer
  // names the same file — start the cursor at the top, mirroring `open()`. The store resets the
  // scroll offset along with the mode.
  useEffect(() => {
    setCursorIndex(0);
  }, [mode]);

  // The tree window must stay inside the row set. Rows shrink without a mode switch (a directory
  // collapse, a git-status refresh dropping changed files) and the pane grows/shortens on resize —
  // without this the offset outlives the rows and `FileTree` draws blank space. `clampScrollTop`
  // is the helper for exactly this and had no caller before.
  useEffect(() => {
    setCursorIndex((prev) => Math.min(prev, Math.max(0, items.length - 1)));
    const currentScroll = useWorkspacePanel.getReadonlyState().treeScrollTop;
    setTreeScrollTop(clampScrollTop(currentScroll, items.length, paneBodyLines));
  }, [items.length, paneBodyLines, setTreeScrollTop]);

  // A **selection** raises the reveal request; the effect below consumes it.
  //
  // Split from consumption on purpose: the request must be raised exactly once per
  // selection, while consumption has to re-run on every `items` change (the expand
  // it triggers is itself an `items` change). Raising it here rather than inferring
  // it from a missing row is what lets the two cases be told apart — see
  // `decideReveal`.
  //
  // `revealPath` awaits the ancestor directories' loads before posting the request,
  // so consumption only ever expands a chain whose data is already in hand.
  useEffect(() => {
    if (!selectedPath || isDiffMode) return;
    void revealPath(selectedPath);
  }, [selectedPath, isDiffMode, revealPath]);

  // Full-tree view: act on the tree's reveal state.
  //
  // Reveal intent is created by a **selection**, not by a missing row. The two are
  // not the same condition, and conflating them made a directory impossible to
  // collapse: once a file was selected, collapsing its directory removed the file's
  // row, the "row missing" branch fired, and the directory was expanded again — the
  // collapse flickered for one render and came straight back.
  //
  // So a row that is absent **without** an outstanding request is left alone: that is
  // the user's own collapse, and the expand state is theirs to own. `decideReveal`
  // holds the rule; this applies it.
  //
  // Consuming the request is also what keeps this effect from looping. Expanding
  // changes `expanded`, which rebuilds `items`, which re-runs this effect — but the
  // request is consumed by the first run, so the re-run has nothing left to do. That
  // is the property the old `revealedRef` marker provided; `pendingReveal` replaces
  // it at the only point where the intent is actually known.
  //
  // Diff mode does not reveal here: a `[`/`]` jump calls `revealDiffDirs` before
  // selecting, because the row it would read the chain from is exactly the row a
  // collapsed ancestor removed.
  useEffect(() => {
    const action = decideReveal({
      rowIndex: selectedPath ? items.findIndex((item) => item.path === selectedPath) : -1,
      selectedPath,
      pendingReveal,
      isDiffMode,
    });

    if (action.kind === "none") return;
    if (action.kind === "consume") {
      consumePendingReveal(selectedPath!);
      return;
    }

    // `select` fires on every `items` identity change, not only on a new selection. Align the cursor
    // only the first time a given selection is seen; after that the cursor is the user's.
    const alreadyAligned = alignedSelectionRef.current === selectedPath;
    alignedSelectionRef.current = selectedPath;
    if (alreadyAligned) return;

    setCursorIndex(action.index);
    const currentScroll = useWorkspacePanel.getReadonlyState().treeScrollTop;
    setTreeScrollTop(ensureIndexVisible(action.index, currentScroll, paneBodyLines, items.length));
    // A satisfied request is retired here so the post-expand re-run is a no-op
    // instead of expanding again forever.
    if (pendingReveal === selectedPath) consumePendingReveal(selectedPath!);
  }, [selectedPath, items, isDiffMode, pendingReveal, consumePendingReveal, paneBodyLines, setTreeScrollTop]);

  /**
   * Hand the selected file to the host's editor.
   *
   * The round-trip marker has to be written *before* the handoff: the host unmounts this screen while
   * the editor runs, so the code after the `await` may find a different React tree (or none). The
   * marker is what the resumed panel reads to refresh the caches the edit invalidated.
   */
  const openSelectedInEditor = useCallback(
    async (target: EditorTarget) => {
      if (!adapter.openInEditor) return;
      useEditorHandoff.getActions().beginRoundTrip(target.path);
      // Give the screen back before the handoff: the editor draws on the primary buffer, and the
      // panel's own alternate buffer is what the host is about to tear down. Doing it here (rather
      // than in the unmount cleanup) keeps the renderer alive and consistent for the switch, and
      // keeps the chat behind it untouched.
      setOptions({ isAlternateBufferEnabled: false });
      try {
        await adapter.openInEditor(target);
      } catch (error) {
        // The handoff never started (remote workspace, no local editor): drop the marker so a later
        // mount does not refresh for nothing, take the panel's screen back, and say why in the footer.
        useEditorHandoff.getActions().consumeRoundTrip();
        useEditorHandoff.getActions().setNotice(error instanceof Error ? error.message : String(error));
        setOptions({ isAlternateBufferEnabled: true });
      }
    },
    [adapter, setOptions]
  );

  // Full manual refresh: drop every cache, reload the tree, reset pane scroll,
  // collapse state in BOTH trees, and re-fetch git state.
  const refreshAll = useCallback(() => {
    clearDirCache();
    clearGitStatusCache();
    clearWorkspaceDiffStatsCache();
    clearWorkspaceFileListCache();
    clearContentCache();
    clearWorkspaceDiffCache();
    reload();
    // Diff mode's collapse state lives in `useDiffFileTree`, not in the store, so
    // `reload()` above does not touch it — without this the diff tree would keep
    // directories collapsed across a refresh while the full tree resets.
    resetDiffCollapsed();
    // The cursor/scroll reset with the trees, so the reveal effect must be allowed to place the
    // cursor on the selected file again — otherwise `r` would leave the cursor wherever the row
    // indices happened to land after the re-list.
    alignedSelectionRef.current = null;
    scrollActivePane("top");
    setRefreshToken((t) => t + 1);
    void refreshGit(rootPath);
  }, [reload, scrollActivePane, refreshGit, rootPath, resetDiffCollapsed]);

  /**
   * Refresh what an edit can change, without touching the tree.
   *
   * The editor wrote one file, so the caches that describe file *content* and repository *status* are
   * stale — but the tree's own state must survive: `refreshAll` also clears the expanded chain, and
   * that is the one thing the resumed screen cannot rebuild on its own. The selection reveal below
   * (raised by `selectedPath` on mount) is what expands the edited file's chain and puts the cursor
   * back on it, exactly as a `[`/`]` jump or a quick-open pick does.
   */
  const refreshAfterEdit = useCallback(() => {
    clearGitStatusCache();
    clearWorkspaceDiffStatsCache();
    clearWorkspaceFileListCache();
    clearContentCache();
    clearWorkspaceDiffCache();
    setRefreshToken((t) => t + 1);
    void refreshGit(rootPath);
  }, [refreshGit, rootPath]);

  // An editor handoff is the one refresh that happens without a keypress: the panel spent the edit
  // unmounted, so every cache still describes the pre-edit workspace. `rootPath` gates it because the
  // first render still has the empty string and the refresh needs the real root.
  useEffect(() => {
    if (!rootPath) return;
    if (!useEditorHandoff.getReadonlyState().roundTrip) return;
    useEditorHandoff.getActions().consumeRoundTrip();
    refreshAfterEdit();
  }, [rootPath, refreshAfterEdit]);

  /** Keybindings that work regardless of which pane has focus. Returns true when handled. */
  const handleGlobalKey = useCallback(
    (inputChar: string, key: Key): boolean => {
      if (key.tab) {
        toggleMode();
        return true;
      }
      if (key.escape) {
        close();
        return true;
      }
      if (inputChar === "r" && !key.ctrl) {
        refreshAll();
        return true;
      }
      if (key.ctrl && inputChar === "p") {
        openQuickOpen();
        return true;
      }
      if (key.ctrl && inputChar === "e") {
        // The same chord that opened the panel closes it: the chat screen only ever opens, so the
        // close half lives here, with the screen it belongs to.
        close();
        return true;
      }
      if (inputChar === "e" && !key.ctrl && !key.meta && canEdit) {
        // The cursor row is what "selected" means to every other key in this pane (`enter` opens it);
        // a directory has nothing to edit, and the key is consumed rather than falling through.
        const row = items[cursorIndex];
        if (row?.type === "file") {
          // Carry the first visible source line so the editor opens where the user was reading. Only
          // the preview knows a *source* line: the diff view's scroll state counts display rows
          // (hunks, headers, collapsed regions), which would land somewhere else in the file.
          const line = mode === "preview" ? previewRef.current?.getScrollState().startLine : undefined;
          void openSelectedInEditor({ path: row.path, ...(line ? { line } : {}) });
        }
        return true;
      }
      if (inputChar === "]" || inputChar === "[") {
        jumpToChanged(inputChar === "]" ? 1 : -1);
        return true;
      }
      return false;
    },
    [
      toggleMode,
      close,
      refreshAll,
      openQuickOpen,
      jumpToChanged,
      canEdit,
      items,
      cursorIndex,
      mode,
      openSelectedInEditor,
    ]
  );

  /** Tree-pane navigation (arrows expand/select, enter toggles). */
  const handleTreeKey = useCallback(
    (key: Key) => {
      if (key.upArrow) {
        moveCursor(cursorIndex - 1);
        return;
      }
      if (key.downArrow) {
        moveCursor(cursorIndex + 1);
        return;
      }
      if (key.rightArrow) {
        const current = items[cursorIndex];
        if (!current) return;
        if (current.type === "directory") {
          if (!current.expanded) {
            void handleToggleDir(current.path);
            return;
          }
          setPaneFocus("preview");
          return;
        }
        if (selectedPath === current.path) {
          setPaneFocus("preview");
          return;
        }
        selectFile(current.path);
        return;
      }
      if (key.leftArrow) {
        const current = items[cursorIndex];
        if (current?.type === "directory" && current.expanded) {
          void handleToggleDir(current.path);
          return;
        }
        if (current && current.indent > 0) {
          for (let i = cursorIndex - 1; i >= 0; i--) {
            const candidate = items[i];
            if (candidate && candidate.indent === current.indent - 1) {
              moveCursor(i);
              break;
            }
          }
        }
        return;
      }
      if (key.return) {
        const current = items[cursorIndex];
        if (!current) return;
        if (current.type === "directory") void handleToggleDir(current.path);
        else selectFile(current.path);
      }
    },
    [cursorIndex, items, moveCursor, handleToggleDir, selectedPath, selectFile, setPaneFocus]
  );

  /**
   * Whether the preview pane is showing the zoomable image view.
   *
   * Only then do `+`/`-`/`0` and the arrow keys mean zoom and pan. Everything else in this pane is
   * text or a diff, where the arrows must keep scrolling exactly as before.
   */
  const imageViewActive =
    mode === "preview" &&
    selectedPath !== null &&
    isImagePath(selectedPath) &&
    Boolean(env.imageToText) &&
    !screenReader;

  /** Preview-pane navigation (scroll the file/diff, ← returns to the tree, `+`/`-`/`0` zoom images). */
  const handlePreviewKey = useCallback(
    (key: Key) => {
      if (imageViewActive) {
        // Zoom/pan owns the arrow keys only while zoomed: at 1× the window is the whole image, so
        // there is nothing to pan and scrolling keeps its old meaning.
        const zoomed = imageZoom > 1;
        if (zoomed) {
          // Directions, not distances: the store sizes the step from the visible window, so a press
          // moves the same number of CELLS at 2× and at 8× (a constant step skipped a whole screen
          // at deep zoom, where the pannable range is large and the window is small).
          if (key.upArrow) return panImage(0, -1);
          if (key.downArrow) return panImage(0, 1);
          if (key.leftArrow) return panImage(-1, 0);
          if (key.rightArrow) return panImage(1, 0);
        }
        if (key.leftArrow) {
          setPaneFocus("tree");
          return;
        }
        if (key.rightArrow) return;
        if (key.upArrow) {
          scrollActivePane("up");
          return;
        }
        if (key.downArrow) scrollActivePane("down");
        return;
      }

      if (key.leftArrow) {
        setPaneFocus("tree");
        return;
      }
      if (key.rightArrow) return;
      if (!selectedPath) return;
      if (key.upArrow) {
        scrollActivePane("up");
        return;
      }
      if (key.downArrow) scrollActivePane("down");
    },
    [imageViewActive, imageZoom, panImage, selectedPath, scrollActivePane, setPaneFocus]
  );

  /** Zoom keys, only while an image preview is on screen. Returns whether the key was consumed. */
  const handleImageZoomKey = useCallback(
    (inputChar: string) => {
      if (!imageViewActive) return false;
      if (inputChar === "+" || inputChar === "=") {
        zoomImage(1);
        return true;
      }
      if (inputChar === "-" || inputChar === "_") {
        zoomImage(-1);
        return true;
      }
      if (inputChar === "0") {
        resetImageView();
        return true;
      }
      return false;
    },
    [imageViewActive, resetImageView, zoomImage]
  );

  useWorkspacePanelInput(
    (inputChar, key) => {
      if (handleGlobalKey(inputChar, key)) return;
      if (paneFocus === "tree") handleTreeKey(key);
      else if (!handleImageZoomKey(inputChar)) handlePreviewKey(key);
    },
    // The quick-open overlay is the other workspace sub-surface: while it is up it owns the keys.
    { when: !quickOpen }
  );

  return (
    <Box flexDirection="column" flexGrow={1} width={screenWidth} height={bodyHeight + HEADER_LINES + FOOTER_LINES}>
      <WorkspaceModeHeader mode={mode} rootPath={rootPath} gitInfo={gitInfo} diffStats={diffStats} />

      {quickOpen ? (
        <WorkspaceQuickOpen rootPath={rootPath} width={screenWidth} height={bodyHeight} />
      ) : (
        <Box flexDirection="row" flexGrow={1} height={bodyHeight} gap={0}>
          <WorkspacePane active={paneFocus === "tree"} width={treeWidth} height={bodyHeight}>
            <FileTree
              items={items}
              gitStatus={gitStatus}
              dirStatuses={dirStatuses}
              rootPath={rootPath}
              cursorIndex={cursorIndex}
              selectedPath={selectedPath}
              scrollTop={treeScrollTop}
              visibleCount={paneBodyLines}
              loading={isDiffMode ? gitStatus.size === 0 && treeLoading : treeLoading}
              emptyLabel={isDiffMode ? "(no changes)" : undefined}
              diffStats={diffStats?.files ?? null}
            />
          </WorkspacePane>

          <WorkspacePane active={paneFocus === "preview"} width={undefined} height={bodyHeight}>
            <WorkspacePreviewPane
              mode={mode}
              rootPath={rootPath}
              selectedPath={selectedPath}
              {...(selectedRenamedFrom !== undefined ? { renamedFrom: selectedRenamedFrom } : {})}
              refreshToken={refreshToken}
              width={previewWidth - 2}
              height={paneBodyLines}
              previewRef={previewRef}
              diffRef={diffRef}
            />
          </WorkspacePane>
        </Box>
      )}

      <Box flexShrink={0} height={FOOTER_LINES} paddingX={1}>
        <Text color={COLORS.muted} dimColor>
          {jumpNotice ?? editorNotice ?? workspacePanelHint({ edit: canEdit })}
        </Text>
      </Box>
    </Box>
  );
};
