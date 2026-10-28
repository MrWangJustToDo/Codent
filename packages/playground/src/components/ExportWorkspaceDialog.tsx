import { errorMessage } from "@codent/core";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useShellState } from "../hooks/use-shell-state.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { IconDownload } from "../ui/icons.js";
import { buildWorkspaceZip, downloadUint8Array } from "../webcontainer/build-workspace-zip.js";
import { getBootedWebContainer } from "../webcontainer/create-env.js";
import {
  deselectByDirName,
  listWorkspaceEntries,
  pathDepth,
  selectedFilePaths,
  togglePathSelection,
  type WorkspaceEntry,
} from "../webcontainer/workspace-export-selection.js";

type Props = {
  onClose: () => void;
};

export const ExportWorkspaceDialog = ({ onClose }: Props) => {
  const { showToast } = useShellState.getActions();
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setError("");
      try {
        const wc = getBootedWebContainer();
        if (!wc) throw new Error("WebContainer is not ready yet.");
        const listed = await listWorkspaceEntries(wc.fs, "/", { maxEntries: 5000 });
        if (cancelled) return;
        setTruncated(listed.length >= 5000);
        setEntries(listed);
        // Default: everything except node_modules / .git
        const initial = new Set(listed.map((e) => e.path));
        setSelected(deselectByDirName(deselectByDirName(initial, listed, "node_modules"), listed, ".git"));
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const fileCount = useMemo(() => selectedFilePaths(selected, entries).length, [selected, entries]);

  const toggle = useCallback(
    (path: string, checked: boolean) => setSelected((prev) => togglePathSelection(prev, entries, path, checked)),
    [entries]
  );

  const runExport = useCallback(async () => {
    const wc = getBootedWebContainer();
    if (!wc) {
      setError("WebContainer is not ready yet.");
      return;
    }
    const files = selectedFilePaths(selected, entries);
    if (files.length === 0) {
      setError("Select at least one file to export.");
      return;
    }

    setExporting(true);
    setError("");
    try {
      const zip = await buildWorkspaceZip(wc.fs, files);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      downloadUint8Array(`playground-workspace-${stamp}.zip`, zip);
      showToast(`Exported ${files.length} file${files.length === 1 ? "" : "s"}`, "success");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }, [entries, onClose, selected, showToast]);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Export workspace"
      description="Download a ZIP of the WebContainer filesystem"
      leading={
        <span className="dialog__chip" aria-hidden="true">
          <IconDownload size={15} />
        </span>
      }
      size="md"
      footer={
        <>
          <span className="export__count">
            {fileCount} file{fileCount === 1 ? "" : "s"} selected
          </span>
          <Button variant="primary" disabled={exporting || loading || fileCount === 0} onClick={() => void runExport()}>
            {exporting ? "Packaging…" : "Download ZIP"}
          </Button>
        </>
      }
    >
      <div className="export__toolbar">
        <Button size="sm" onClick={() => setSelected(new Set(entries.map((e) => e.path)))} disabled={loading}>
          Select all
        </Button>
        <Button size="sm" onClick={() => setSelected(new Set())} disabled={loading}>
          Select none
        </Button>
        <Button
          size="sm"
          onClick={() =>
            setSelected((prev) => deselectByDirName(deselectByDirName(prev, entries, "node_modules"), entries, ".git"))
          }
          disabled={loading}
        >
          Skip node_modules / .git
        </Button>
      </div>

      <div className="export__list">
        {loading && <div className="export__status">Scanning workspace…</div>}
        {!loading && entries.length === 0 && !error && <div className="export__status">Workspace is empty.</div>}
        {!loading &&
          entries.map((entry) => {
            const depth = pathDepth(entry.path);
            const label = entry.path === "/" ? "/" : entry.path.slice(entry.path.lastIndexOf("/") + 1);
            return (
              <label
                key={entry.path}
                className={entry.type === "directory" ? "export__row export__row--dir" : "export__row"}
                style={{ paddingLeft: 10 + depth * 14 }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(entry.path)}
                  onChange={(e) => toggle(entry.path, e.target.checked)}
                />
                <span className="truncate" title={entry.path}>
                  {entry.type === "directory" ? `${label}/` : label}
                </span>
              </label>
            );
          })}
      </div>

      {truncated && (
        <p className="export__warn">Listing stopped at 5000 entries — trim the workspace or export in batches.</p>
      )}
      {error && (
        <p className="export__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
};
