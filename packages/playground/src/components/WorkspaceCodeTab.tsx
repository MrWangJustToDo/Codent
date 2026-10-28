import { errorMessage } from "@codent/core";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { EDITOR_OPTIONS, definePlaygroundTheme } from "../editor/monaco-theme.js";
import { usePointerDrag } from "../hooks/use-pointer-drag.js";
import { useShellState } from "../hooks/use-shell-state.js";
import { Button } from "../ui/Button.js";
import { cx } from "../ui/cx.js";
import { IconDownload, IconFile, IconFolder, IconUpload } from "../ui/icons.js";
import { State } from "../ui/State.js";
import { collectDropEntries, hasUsableDropItems, uploadEntryTree } from "../utils/upload-files.js";

import { FileTree } from "./FileTree.js";

import type { OnMount } from "@monaco-editor/react";
import type { WebContainer } from "@webcontainer/api";

const MonacoEditor = lazy(() => import("@monaco-editor/react").then((m) => ({ default: m.Editor })));

const SIDEBAR_STORAGE_KEY = "codent-playground-sidebar";
const MIN_SIDEBAR_WIDTH = 150;
const MAX_SIDEBAR_WIDTH = 420;
const DEFAULT_SIDEBAR_WIDTH = 220;

function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= MIN_SIDEBAR_WIDTH) return n;
    }
  } catch {
    // ignore
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

function persistSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(width));
  } catch {
    // ignore
  }
}

function clampSidebarWidth(width: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(width, MAX_SIDEBAR_WIDTH));
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  md: "markdown",
  py: "python",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  sh: "shell",
  bash: "shell",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  vue: "html",
  svelte: "html",
  sql: "sql",
  dart: "dart",
  toml: "plaintext",
  env: "plaintext",
  csv: "plaintext",
  txt: "plaintext",
};

function extToLang(filename: string): string {
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1) return "plaintext";
  return EXT_LANG[filename.slice(dotIdx + 1).toLowerCase()] ?? "plaintext";
}

interface WorkspaceCodeTabProps {
  wc: WebContainer;
  rootPath: string;
  refreshKey: number;
}

export const WorkspaceCodeTab = ({ wc, rootPath, refreshKey }: WorkspaceCodeTabProps) => {
  const { setExportOpen, showToast } = useShellState.getActions();

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [fileLang, setFileLang] = useState("plaintext");
  const [fileLoading, setFileLoading] = useState(false);
  const [modified, setModified] = useState(false);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const currentContentRef = useRef<string>("");
  const currentPathRef = useRef<string | null>(null);
  const modifiedRef = useRef(false);
  /**
   * Sequence of the newest `loadFile` call. A read is only allowed to publish its
   * result when it is still the newest one.
   *
   * Reads are independent async operations whose latency depends on file size, so
   * selecting a large file and then a small one lets the second read resolve first
   * and the first — now stale — overwrite it. The tab would then show the previous
   * file's contents under the new file's name. The same guard covers the
   * `refreshKey` re-read of the open file being superseded by a click.
   */
  const loadSeqRef = useRef(0);

  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const sidebarLiveRef = useRef(sidebarWidth);
  sidebarLiveRef.current = sidebarWidth;
  const containerRef = useRef<HTMLDivElement>(null);

  modifiedRef.current = modified;

  const loadFile = useCallback(
    async (path: string) => {
      const seq = ++loadSeqRef.current;
      setFileLoading(true);
      try {
        const content = await wc.fs.readFile(path, "utf-8");
        if (seq !== loadSeqRef.current) return;
        setFileContent(content);
        currentContentRef.current = content;
        setFileLang(extToLang(path.split("/").pop() ?? ""));
        setModified(false);
        currentPathRef.current = path;
      } catch {
        if (seq !== loadSeqRef.current) return;
        setFileContent("// Could not read this file (binary or removed).");
        setFileLang("plaintext");
        setModified(false);
        currentPathRef.current = path;
      } finally {
        // A superseded read must not clear the newer read's loading state.
        if (seq === loadSeqRef.current) setFileLoading(false);
      }
    },
    [wc.fs]
  );

  const saveCurrentFile = useCallback(async () => {
    const path = currentPathRef.current;
    if (!path) return;
    try {
      await wc.fs.writeFile(path, currentContentRef.current);
      setModified(false);
      showToast(`Saved ${path.split("/").pop() ?? path}`, "success");
    } catch {
      showToast(`Could not save ${path.split("/").pop() ?? path}`, "error");
    }
  }, [wc.fs, showToast]);

  const handleSelect = useCallback(
    (path: string) => {
      if (modifiedRef.current && currentPathRef.current) {
        void wc.fs.writeFile(currentPathRef.current, currentContentRef.current).catch(() => {});
      }
      setSelectedPath(path);
      void loadFile(path);
    },
    [wc.fs, loadFile]
  );

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------
  const uploadFileList = useCallback(
    async (files: FileList): Promise<number> => {
      let count = 0;
      for (const file of files) {
        const relativePath = file.webkitRelativePath || file.name;
        const parts = relativePath.split("/");
        const destPath = "/" + parts.slice(parts[0] === "" ? 1 : 0).join("/");
        const content = new Uint8Array(await file.arrayBuffer());
        // WebContainer's native writeFile does NOT create parent dirs — mkdir first.
        const parentIdx = destPath.lastIndexOf("/");
        if (parentIdx > 0) {
          await wc.fs.mkdir(destPath.slice(0, parentIdx), { recursive: true }).catch(() => {});
        }
        await wc.fs.writeFile(destPath, content);
        count++;
      }
      return count;
    },
    [wc.fs]
  );

  const handleUpload = useCallback(
    async (files: FileList) => {
      setUploading(true);
      try {
        const count = await uploadFileList(files);
        window.dispatchEvent(new CustomEvent("agent:action"));
        showToast(`Uploaded ${count} file${count > 1 ? "s" : ""}`, "success");
      } catch (err) {
        showToast(`Upload failed: ${errorMessage(err)}`, "error");
      } finally {
        setUploading(false);
      }
    },
    [uploadFileList, showToast]
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (!e.dataTransfer.items || e.dataTransfer.items.length === 0) return;
      setUploading(true);
      try {
        const entries = collectDropEntries(e.dataTransfer.items);
        let count = 0;
        if (entries.length > 0) {
          for (const entry of entries) {
            count += await uploadEntryTree(wc, entry, "", () => {});
          }
        } else {
          // Fallback: browsers without webkitGetAsEntry — upload the plain FileList.
          count = await uploadFileList(e.dataTransfer.files);
        }
        window.dispatchEvent(new CustomEvent("agent:action"));
        showToast(`Uploaded ${count} file${count > 1 ? "s" : ""}`, "success");
      } catch (err) {
        showToast(`Upload failed: ${errorMessage(err)}`, "error");
      } finally {
        setUploading(false);
      }
    },
    [wc, uploadFileList, showToast]
  );

  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      definePlaygroundTheme(monaco);
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void saveCurrentFile();
      });
    },
    [saveCurrentFile]
  );

  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      currentContentRef.current = value;
      setModified(true);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Sidebar resize (shared pointer-drag lifecycle + keyboard)
  // ---------------------------------------------------------------------------
  const { handlers: sidebarDragHandlers } = usePointerDrag({
    onMove: useCallback((clientX: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setSidebarWidth(clampSidebarWidth(clientX - rect.left));
    }, []),
    onEnd: useCallback(() => persistSidebarWidth(sidebarLiveRef.current), []),
  });

  const onSidebarKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 12;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSidebarWidth((w) => clampSidebarWidth(w - step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth((w) => clampSidebarWidth(w + step));
    } else if (event.key === "Home") {
      event.preventDefault();
      setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    }
  }, []);

  // Agent wrote files → re-read the open file.
  useEffect(() => {
    if (currentPathRef.current) void loadFile(currentPathRef.current);
  }, [refreshKey, loadFile]);

  // Flush unsaved edits when the tab unmounts.
  useEffect(
    () => () => {
      if (currentPathRef.current && modifiedRef.current) {
        void wc.fs.writeFile(currentPathRef.current, currentContentRef.current).catch(() => {});
      }
    },
    [wc.fs]
  );

  const filename = selectedPath?.split("/").pop() ?? "";

  return (
    <div
      ref={containerRef}
      className={cx("code", dragActive && "code--drag")}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        if (hasUsableDropItems(e.dataTransfer.items)) setDragActive(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false);
      }}
      onDrop={(e) => {
        setDragActive(false);
        void handleDrop(e);
      }}
    >
      <div className="code__sidebar" style={{ width: sidebarWidth }}>
        <div className="code__sidebar-head">
          <span>Explorer</span>
          <div className="code__sidebar-actions">
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={uploading ? <span className="spinner spinner--sm" /> : <IconUpload size={13} />}
              aria-label="Upload files"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            />
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<IconFolder size={13} />}
              aria-label="Upload a folder"
              disabled={uploading}
              onClick={() => folderInputRef.current?.click()}
            />
          </div>
        </div>
        <div className="code__tree">
          <FileTree
            wc={wc}
            rootPath={rootPath}
            onSelect={handleSelect}
            refreshKey={refreshKey}
            selectedPath={selectedPath}
            onRequestUpload={() => fileInputRef.current?.click()}
          />
        </div>
      </div>

      <div
        className="code__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file tree"
        aria-valuenow={sidebarWidth}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        tabIndex={0}
        {...sidebarDragHandlers}
        onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
        onKeyDown={onSidebarKeyDown}
      />

      <div className="code__main">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="visually-hidden"
          onChange={(e) => {
            if (e.target.files?.length) void handleUpload(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          className="visually-hidden"
          // @ts-expect-error webkitdirectory is a Chromium/WebKit extension
          webkitdirectory=""
          onChange={(e) => {
            if (e.target.files?.length) void handleUpload(e.target.files);
            e.target.value = "";
          }}
        />

        <div className="code__bar">
          {selectedPath ? (
            <>
              <span className="code__filename truncate" title={selectedPath}>
                {filename}
              </span>
              {modified && <span className="code__modified">Unsaved</span>}
            </>
          ) : (
            <span className="code__filename code__filename--muted">No file open</span>
          )}
          <div className="code__bar-spacer" />
          {selectedPath && (
            <Button size="sm" variant="ghost" disabled={!modified} onClick={() => void saveCurrentFile()}>
              Save
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<IconDownload size={13} />} onClick={() => setExportOpen(true)}>
            Export
          </Button>
        </div>

        <div className="code__editor">
          {selectedPath ? (
            <Suspense fallback={<State loading title="Loading editor" />}>
              <MonacoEditor
                key={selectedPath}
                value={fileContent}
                language={fileLang}
                theme="playground-dark"
                onChange={handleEditorChange}
                onMount={handleEditorMount}
                options={EDITOR_OPTIONS}
                loading={<State loading title="Loading editor" />}
              />
            </Suspense>
          ) : (
            <State
              icon={<IconFile size={19} />}
              title="No file open"
              hint="Pick a file in the explorer to read and edit it. Changes save back into the WebContainer."
            />
          )}
          {fileLoading && <div className="code__loading-bar" role="status" aria-label="Loading file" />}
        </div>
      </div>

      {dragActive && (
        <div className="code__dropzone" aria-hidden="true">
          <IconUpload size={22} />
          <span>Drop files or folders to add them to the workspace</span>
        </div>
      )}
    </div>
  );
};
