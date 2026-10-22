/**
 * File type detection for read_file (MIME + extension + binary sampling).
 */

import type { ResolvedCoreEnv } from "../../../../../env";
import type { FileStat } from "../../../../../env/types";

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

function isBinaryExtension(env: ResolvedCoreEnv, filePath: string): boolean {
  const ext = env.path.extname(filePath).toLowerCase();
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
export async function detectReadFileType(
  env: ResolvedCoreEnv,
  filePath: string,
  stat?: FileStat
): Promise<ReadFileTypeInfo> {
  if (stat?.isDirectory) {
    return { type: "directory" };
  }

  const getMimeType = env.getMimeType;
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

  if (isBinaryExtension(env, filePath)) {
    return { type: "binary", mimeType };
  }

  return { type: "text", mimeType };
}

/** Bytes taken from a file's head to decide whether it is binary (see {@link headProbeSample}). */
export const BINARY_PROBE_BYTES = 4096;

/**
 * Build a bounded head sample for {@link isBinaryContent} from either raw bytes (a
 * `readFile(…, "buffer")` result) or a decoded string (the `readFileRange` path).
 *
 * Bounded on purpose: a multi-GB file must not be scanned end to end just to notice it is
 * binary — the caller reads the file once and probes only its head. A string source is
 * re-encoded to real UTF-8 bytes before the probe, so a decoded character can never be
 * mistaken for a control byte.
 *
 * Re-encoding (rather than narrowing each UTF-16 code unit with `& 0xff`) is the whole point:
 * a decoded char whose code point merely *ends* in a C0 byte — `─` U+2500, `│` U+2502,
 * `├` U+251C, and much of the CJK range — would otherwise be probed as that control byte and
 * reject perfectly good text as binary. Genuine control bytes and NUL still re-encode to
 * themselves, so the heuristic keeps its true positives; a multibyte character split at the
 * byte bound can only contribute a replacement character, never a false control byte.
 */
export function headProbeSample(source: Uint8Array | string, maxBytes: number = BINARY_PROBE_BYTES): Uint8Array {
  if (typeof source !== "string") {
    return source.subarray(0, Math.min(maxBytes, source.length));
  }
  // Encode the head, then keep the byte bound exactly: `slice` off UTF-16 units first only as an
  // upper bound, since each unit is at most 3 UTF-8 bytes.
  return new TextEncoder().encode(source.slice(0, maxBytes)).subarray(0, maxBytes);
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
