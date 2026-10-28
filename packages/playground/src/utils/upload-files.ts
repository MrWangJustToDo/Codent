/**
 * Upload helpers for the workspace: upload plain files (via FileList) and
 * recursively upload folders (via DataTransferItem.webkitGetAsEntry, which the
 * browser fills when a folder is dragged in — reliable across Chrome / Safari /
 * Firefox on macOS, unlike the webkitdirectory file picker).
 */

import { errorMessage } from "@codent/core";

import type { WebContainer } from "@webcontainer/api";

/**
 * Recursively upload a file/folder entry into the WebContainer workdir.
 * `basePath` is the destination path (without trailing slash) that this entry
 * should live under; `getRelPath` maps an entry to its relative path.
 */
export async function uploadEntryTree(
  wc: WebContainer,
  entry: FileSystemEntry,
  basePath: string,
  onProgress?: (uploaded: number) => void
): Promise<number> {
  let count = 0;
  await walkEntry(entry, basePath);
  return count;

  async function walkEntry(entry: FileSystemEntry, destDir: string): Promise<void> {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      let file: File;
      try {
        file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
      } catch (err) {
        throw new Error(`Failed to read dropped file "${destDir}/${entry.name}": ${String(err)}`);
      }
      const destPath = `${destDir}/${entry.name}`;
      const content = new Uint8Array(await file.arrayBuffer());
      try {
        // WebContainer's native writeFile does NOT create parent dirs — mkdir first.
        await ensureParentDir(wc, destPath);
        await wc.fs.writeFile(destPath, content);
      } catch (err) {
        throw new Error(`Failed to write "${destPath}": ${errorMessage(err)}`);
      }
      count += 1;
      onProgress?.(count);
      return;
    }

    if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const nextDir = `${destDir}/${entry.name}`;
      // Pre-create the directory so subsequent writes inside it succeed.
      await wc.fs.mkdir(nextDir, { recursive: true }).catch(() => {});
      const reader = dirEntry.createReader();
      // readEntries returns at most 100 per call — loop until empty.
      let batch: FileSystemEntry[] = [];
      try {
        do {
          batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
          for (const child of batch) {
            await walkEntry(child, nextDir);
          }
        } while (batch.length > 0);
      } catch (err) {
        throw new Error(`Failed to read directory "${nextDir}": ${errorMessage(err)}`);
      }
    }
  }
}

/** Recursively create the parent directory of `filePath` (WebContainer native fs). */
async function ensureParentDir(wc: WebContainer, filePath: string): Promise<void> {
  const idx = filePath.lastIndexOf("/");
  if (idx <= 0) return; // root file — no parent needed
  const parent = filePath.slice(0, idx);
  await wc.fs.mkdir(parent, { recursive: true }).catch(() => {});
}

/** Whether a drop contains any entry we can handle (file or folder). */
export function hasUsableDropItems(items: DataTransferItemList): boolean {
  for (let i = 0; i < items.length; i += 1) {
    const kind = items[i].kind;
    if (kind === "file") return true;
  }
  return false;
}

/** Read every FileSystemEntry from a DataTransfer (browser-safe). */
export function collectDropEntries(items: DataTransferItemList): FileSystemEntry[] {
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  return entries;
}
