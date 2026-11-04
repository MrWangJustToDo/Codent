/**
 * File path → `file://` URL — the one definition.
 *
 * The extension loader (`import()` of a `.ts`/`.js` module) and the LSP client (`textDocument.uri`)
 * each had their own copy. Both left `#` and `?` unencoded, so a workspace path containing either
 * was parsed as a fragment/query: the extension loader reported "Failed to load extension" for a
 * file that exists, and the language server addressed a different document. Percent-encoding per
 * path segment closes both; the drive-letter colon is restored because `file:///C%3A/...` is not a
 * Windows path.
 */

import { toPosixPath } from "./posix-path.js";

/** Build a `file://` URL for `import()` or an LSP document URI. */
export function pathToFileUrl(absPath: string): string {
  const normalized = toPosixPath(absPath);
  // A POSIX absolute path already begins with `/`, so `file://` + the path gives three slashes.
  // A Windows drive path (`C:/...`) has no leading slash and needs the third one explicitly.
  const prefix = normalized.startsWith("/") ? "file://" : "file:///";
  const encoded = normalized
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":"))
    .join("/");
  return `${prefix}${encoded}`;
}
