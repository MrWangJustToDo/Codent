/**
 * Path extraction from git's machine-readable output.
 *
 * Every consumer of git output in the diff view (`workspace-git-status`,
 * `workspace-diff-stats`, `workspace-diff-tree`) needs the same thing from that output:
 * the real path of a file. This module is the single place that produces one.
 *
 * ## Why this is not line-oriented
 *
 * `git status --porcelain` and `git diff --numstat` quote paths git considers special
 * when asked for line-oriented output: a space or a quote makes it wrap the path in
 * double quotes and backslash-escape the inside, and — with `core.quotePath` at its
 * default of true — non-ASCII bytes become octal escapes. Taking such a record literally
 * yields a path that does not exist, which the diff view then renders as a plausible-looking
 * row that cannot be opened. Both commands were doing exactly that.
 *
 * `-z` output is never quoted or escaped, and can represent a path containing a newline
 * (which a line-oriented parse cannot represent at all). So paths come from `-z` records.
 *
 * ## Why the boundary lives here
 *
 * Neither consumer can be trusted to filter, and neither can the next one be: the same
 * defect existed three times — twice in this view's commands, and once more in
 * `workspace-file-search`, which read `git ls-files` line-oriented in a different view and
 * was found only by surveying every git invocation. A path that does not name a file is
 * rejected at extraction instead, so no consumer has to know the rule.
 *
 * @see `docs` — the inputs these functions are pinned against are taken from git's own
 * output rather than hand-written, so a change in git's escaping fails the tests.
 */

import { toPosixPathKey } from "@codent/core";

/** Record separator git uses for `-z` output. */
export const GIT_RECORD_SEPARATOR = "\0";

/**
 * Whether a path names a file the diff view can read.
 *
 * Two shapes are rejected: an empty path, and one ending in `/` — which is what git
 * reports for an untracked *directory* when it has not been asked to expand them. Such a
 * record has no file behind it, so a row built from it opens nothing and renders with an
 * empty name (the directory's own name is the segment before the trailing slash, which the
 * tree builder drops).
 */
export function namesAFile(path: string): boolean {
  if (!path) return false;
  // Both separators: a Windows directory path ends in `\`, and normalisation happens after
  // this check, so a `/`-only test would let it through.
  if (path.endsWith("/") || path.endsWith("\\")) return false;
  return true;
}

/**
 * Turn a raw path from a git record into the path the diff view keys on, or `null` when the
 * record does not name a file.
 *
 * Order matters: the trailing separator is the *only* signal that git reported a directory, and
 * normalisation strips it. The rejection therefore has to happen against the raw value —
 * checking after normalising let `brand-new/` through as `brand-new`, which still has no file
 * behind it and rendered the same nameless row by a different route.
 */
export function filePathFromRecord(raw: string): string | null {
  if (!namesAFile(raw)) return null;
  const normalized = normalizeGitPath(raw);
  return namesAFile(normalized) ? normalized : null;
}

/** Split `-z` output into records, dropping the trailing empty record. */
export function splitGitRecords(raw: string): string[] {
  if (raw === "") return [];
  const records = raw.split(GIT_RECORD_SEPARATOR);
  // `-z` output is NUL-*terminated*, so a non-empty result always has an empty tail.
  if (records.length > 0 && records[records.length - 1] === "") records.pop();
  return records;
}

/**
 * Normalize a path git just reported: forward slashes, and no trailing separator.
 *
 * A thin alias for the shared path rule (`@codent/core`), kept under this name because the
 * git parse reads more clearly against "a git path" than against the general primitive. It
 * deliberately does not carry its own copy of the substitution — that copy is what the
 * anti-drift validator rejects.
 */
export const normalizeGitPath = toPosixPathKey;

/**
 * Parse a `git ls-files -z` / `git ls-files -z --others` payload into file paths.
 *
 * Records are bare paths — no status prefix, no counts — so this is the simplest shape, and
 * the one where line-oriented reading hurt most: `ls-files` output is consumed as a *name*
 * (the quick-open picker matches a query against it), so an octal-escaped non-ASCII path does
 * not merely display wrong, it makes the file unfindable by its own name.
 *
 * Paths git reports as directories are rejected here too, for the same reason as elsewhere:
 * a consumer should never be handed something it cannot read.
 */
export function parseGitPathList(raw: string): string[] {
  const paths: string[] = [];
  for (const record of splitGitRecords(raw)) {
    const path = filePathFromRecord(record);
    if (path !== null) paths.push(path);
  }
  return paths;
}

/**
 * Parse a `git status --porcelain -z` payload into `path → status`.
 *
 * Each record is `XY <path>`. A rename or copy emits **two** records with the same status
 * — the new path first, then the old path — rather than one record with an ` -> `
 * separator. That separator cannot be parsed reliably anyway: it can occur inside a path.
 *
 * **The OLD path is not a key here** (see {@link parseGitStatusRenamesZ} for the pairing).
 * Indexing both sides was the earlier behaviour and it is what made a rename render as one
 * deletion plus one addition: the old path is not a file the view can open (it is gone from
 * the worktree), so its row showed the whole file as deleted. A rename is one change, so it
 * gets one row, keyed by the destination — the file that exists.
 *
 * @example
 * parseGitStatusZ("R  new file\0old file\0") // Map { "new file" => "R" }
 */
export function parseGitStatusZ(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const records = splitGitRecords(raw);

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length < 4) continue;
    const status = record.slice(0, 2).trim();
    const path = filePathFromRecord(record.slice(3));

    // A rename/copy consumes the following record, which holds the source path. The pair is
    // recovered separately by `parseGitStatusRenamesZ`; here the source is simply skipped so
    // it does not become a row of its own.
    if (status.startsWith("R") || status.startsWith("C")) {
      if (records[i + 1] !== undefined) i += 1;
    }

    if (path !== null) map.set(path, status);
  }

  return map;
}

/**
 * The rename/copy pairs in a `git status --porcelain -z` payload: destination → source.
 *
 * Separate from {@link parseGitStatusZ} because the two answer different questions. That one
 * answers "which paths are changed" (one entry per change), this one answers "which of those
 * were moved from where" — and only the diff and its label need the second. Keeping the pair
 * out of the path→status map is what stops the source from being rendered as its own row.
 *
 * Keyed by DESTINATION, matching `parseGitStatusZ`: in `status -z` the new path comes first,
 * and the source is the following record. (`git diff --numstat -z` uses the opposite order —
 * see `parseGitNumstatZ`; the two commands are not interchangeable.)
 *
 * @example
 * parseGitStatusRenamesZ("R  new file\0old file\0") // Map { "new file" => "old file" }
 */
export function parseGitStatusRenamesZ(raw: string): Map<string, string> {
  const renames = new Map<string, string>();
  const records = splitGitRecords(raw);

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length < 4) continue;
    const status = record.slice(0, 2).trim();
    if (!status.startsWith("R") && !status.startsWith("C")) continue;

    const destination = filePathFromRecord(record.slice(3));
    const sourceRecord = records[i + 1];
    // Consume the source record even when either side is unusable, so the next iteration does
    // not read a source path as if it were a `<status> <path>` record of its own.
    if (sourceRecord === undefined) continue;
    i += 1;

    const source = filePathFromRecord(sourceRecord);
    if (destination === null || source === null) continue;
    renames.set(destination, source);
  }

  return renames;
}

/**
 * Parse a `git diff --numstat -z` payload into `path → {added, deleted}`.
 *
 * The record shape is `added\tdeleted\t<path>`, with one asymmetry to be careful of:
 *
 * - for an ordinary entry the path is in the same record as the counts;
 * - for a rename the path field is **empty** and the two paths follow as their own records,
 *   **old first, then new**.
 *
 * That is the opposite order from `status -z`, where the new path comes first. The two
 * commands are not interchangeable and the rename path must not be shared between them.
 *
 * Binary files report `-\t-` and are counted as 0/0.
 */
export function parseGitNumstatZ(raw: string): Map<string, { added: number; deleted: number }> {
  const map = new Map<string, { added: number; deleted: number }>();
  const records = splitGitRecords(raw);

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const secondTab = record.indexOf("\t", tab + 1);
    if (secondTab === -1) continue;

    const addedRaw = record.slice(0, tab);
    const deletedRaw = record.slice(tab + 1, secondTab);
    let rawPath = record.slice(secondTab + 1);

    if (rawPath === "") {
      // Rename: the two paths are the next two records, source first.
      const oldPath = records[i + 1];
      const newPath = records[i + 2];
      if (oldPath === undefined || newPath === undefined) continue;
      i += 2;
      rawPath = newPath;
    }

    const path = filePathFromRecord(rawPath);
    if (path === null) continue;
    const added = Number(addedRaw);
    const deleted = Number(deletedRaw);
    map.set(path, {
      added: Number.isFinite(added) && added > 0 ? added : 0,
      deleted: Number.isFinite(deleted) && deleted > 0 ? deleted : 0,
    });
  }

  return map;
}
