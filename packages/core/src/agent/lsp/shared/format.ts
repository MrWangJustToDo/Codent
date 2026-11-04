/** Format LSP locations / location links into `file:line:col` strings. */

import { toPosixPath, toPosixPathKey } from "../../../utils/posix-path.js";

import type { Location, LocationLink } from "vscode-languageserver-protocol";

function uriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === "file:") {
      const pathname = decodeURIComponent(url.pathname);
      // `new URL("file:///C:/dir/f.ts").pathname` is `/C:/dir/f.ts` — a leading separator
      // before a Windows drive letter, which is not a valid path. Left alone it produced
      // `/C:/...` in every LSP location string, and the root-strip below could never match a
      // `C:\...` root, so locations rendered as absolute POSIX-looking paths.
      if (/^\/[A-Za-z]:/.test(pathname)) return pathname.slice(1);
      return pathname;
    }
    return uri;
  } catch {
    return uri;
  }
}

// Separator normalization and trailing-separator removal are the shared path rules; keeping
// local copies here is what a validator now rejects.

/** Convert a file URI to a filesystem path (relative to rootDir when possible). */
export function fileUriToPath(uri: string, rootDir: string): string {
  const abs = uriToPath(uri);
  // Compare on normalized separators and without a trailing separator, so a `C:\repo` root
  // matches `C:/repo/f.ts` and `/repo/` matches `/repo/f.ts`.
  //
  // No guard: both helpers are pure `String.prototype.replace`/concatenation over strings this
  // signature guarantees (`uriToPath` always returns a string), so there is no failure to fall
  // through from — the old empty catch was unreachable.
  const normalizedRoot = toPosixPathKey(rootDir);
  const normalizedAbs = toPosixPath(abs);
  if (normalizedAbs === normalizedRoot) return ".";
  if (normalizedAbs.startsWith(`${normalizedRoot}/`)) {
    return normalizedAbs.slice(normalizedRoot.length + 1);
  }
  return abs;
}

/** Format a Location (file:line:col). */
export function formatLocation(loc: Location, rootDir: string): string {
  const path = fileUriToPath(loc.uri, rootDir);
  const line = loc.range.start.line + 1;
  const col = loc.range.start.character + 1;
  return `${path}:${line}:${col}`;
}

/** Format a LocationLink (file:line:col — target range). */
export function formatLocationLink(link: LocationLink, rootDir: string): string {
  const path = fileUriToPath(link.targetUri, rootDir);
  const line = link.targetRange.start.line + 1;
  const col = link.targetRange.start.character + 1;
  return `${path}:${line}:${col}`;
}
