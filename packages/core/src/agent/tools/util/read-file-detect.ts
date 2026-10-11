/**
 * File type detection for read_file (MIME + extension + binary sampling).
 */

import { getEnv } from "../../../env";

import type { FileStat } from "../../../env/types";

export type ReadFileType = "text" | "image" | "pdf" | "directory" | "binary";

export interface ReadFileTypeInfo {
  type: ReadFileType;
  mimeType?: string;
}

/**
 * Known binary file extensions that should never be read as text.
 * Based on OpenCode's approach - only list known binary types.
 */
const BINARY_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".bz2",
  ".xz",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".class",
  ".jar",
  ".war",
  ".pyc",
  ".pyo",
  ".wasm",
  ".o",
  ".a",
  ".lib",
  ".obj",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".dat",
  ".db",
  ".sqlite",
  ".sqlite3",
]);

function isBinaryExtension(filePath: string): boolean {
  const ext = getEnv().path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Detect file type based on MIME type and extension.
 *
 * Strategy (following OpenCode's approach):
 * 1. Use MIME type to detect images and PDFs
 * 2. Use extension list to detect known binary files
 * 3. Everything else is assumed to be text (with binary content check later)
 */
export async function detectReadFileType(filePath: string, stat?: FileStat): Promise<ReadFileTypeInfo> {
  if (stat?.isDirectory) {
    return { type: "directory" };
  }

  const getMimeType = getEnv().getMimeType;
  const mimeType = (getMimeType ? await getMimeType(filePath) : false) || undefined;

  if (
    mimeType &&
    mimeType.startsWith("image/") &&
    mimeType !== "image/svg+xml" &&
    mimeType !== "image/vnd.fastbidsheet"
  ) {
    return { type: "image", mimeType };
  }

  if (mimeType === "application/pdf") {
    return { type: "pdf", mimeType };
  }

  if (isBinaryExtension(filePath)) {
    return { type: "binary", mimeType };
  }

  return { type: "text", mimeType };
}

/** True when the buffer looks like non-text binary (null bytes / high control-char ratio). */
export function isBinaryContent(buffer: Uint8Array): boolean {
  if (buffer.length === 0) return false;

  const sampleSize = Math.min(4096, buffer.length);
  let nonPrintableCount = 0;

  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i];
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) {
      nonPrintableCount++;
    }
  }

  return nonPrintableCount / sampleSize > 0.3;
}
