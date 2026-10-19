/**
 * Validates path extraction from git's NUL-delimited output.
 *
 * Both git parsers in the diff view previously read git's *line-oriented* output literally.
 * Git quotes paths it considers special there (spaces, quotes) and octal-escapes non-ASCII
 * bytes by default, so the parsed path was not the real path: rows appeared with a trailing
 * quote, a quoted path was split into a bogus directory, and stat keys stopped matching row
 * keys. Every defect was silent — the row still rendered.
 *
 * The expected strings below are what git actually emits for these paths, captured from a
 * scratch repository rather than hand-written from the documented format, so a change in
 * git's escaping fails here instead of producing plausible-but-wrong paths.
 *
 * Run: node packages/app/test/workspace-git-paths.test.mjs
 */
import assert from "node:assert/strict";

const { parseGitStatusZ, parseGitStatusRenamesZ, parseGitNumstatZ, namesAFile, normalizeGitPath, splitGitRecords } =
  await import("../dist/utils/workspace-git-paths.mjs");

const NUL = "\0";
const z = (...records) => records.map((r) => `${r}${NUL}`).join("");

// ============================================================================
// namesAFile — the boundary that keeps directories out of the row set
// ============================================================================

assert.equal(namesAFile("src/a.ts"), true);
assert.equal(namesAFile(""), false, "an empty path names no file");
assert.equal(
  namesAFile("brand-new/"),
  false,
  "a trailing slash is what git reports for an unexpanded untracked directory — no file behind it"
);

assert.equal(normalizeGitPath("src\\win.ts"), "src/win.ts", "Windows separators normalize to forward slashes");
assert.equal(normalizeGitPath("dir/"), "dir");
assert.equal(normalizeGitPath("dir///"), "dir");

assert.deepEqual(splitGitRecords(""), []);
assert.deepEqual(splitGitRecords(z("a", "b")), ["a", "b"], "the NUL-terminated tail must not become an empty record");

// ============================================================================
// parseGitStatusZ
// ============================================================================

// Ordinary records.
{
  const m = parseGitStatusZ(z(" M src/modified.ts", "?? src/new.ts", " D src/gone.ts"));
  assert.equal(m.get("src/modified.ts"), "M");
  assert.equal(m.get("src/new.ts"), "??");
  assert.equal(m.get("src/gone.ts"), "D");
}

// A space in a path needs no unquoting: `-z` never quotes.
{
  const m = parseGitStatusZ(z(" M src/has space.ts"));
  assert.equal(m.get("src/has space.ts"), "M", "no trailing quote may survive");
}

// A quote in a path — the case that used to split into a bogus directory `"src/quo` plus a
// file `"te.ts"`. Real git emits the raw quote in `-z`.
{
  const m = parseGitStatusZ(z(' M src/quo"te.ts'));
  assert.deepEqual([...m.keys()], ['src/quo"te.ts'], "the raw path, not a quoted-and-escaped one");
}

// Non-ASCII is octal-escaped when line-oriented (`core.quotePath` defaults to true).
{
  const m = parseGitStatusZ(z(" M src/中文.ts"));
  assert.equal(m.get("src/中文.ts"), "M", "the real bytes, not \\345\\270\\246…");
}

// A path containing a newline is representable only because records are NUL-delimited.
{
  const m = parseGitStatusZ(z("?? src/line\nbreak.ts"));
  assert.equal(m.get("src/line\nbreak.ts"), "??");
}

// Rename: two records sharing a status — NEW first, then OLD. Only the DESTINATION becomes a
// row. The source is not a file the view can open (it is gone from the worktree), so indexing
// it produced a second row that rendered as a whole-file deletion — that pairing is what
// `parseGitStatusRenamesZ` now carries instead.
{
  const raw = z("R  src/ren-new.ts", "src/ren-old.ts");
  const m = parseGitStatusZ(raw);
  assert.deepEqual([...m.keys()], ["src/ren-new.ts"], "a rename is ONE row, keyed by the destination");
  assert.equal(m.get("src/ren-new.ts"), "R");
  assert.deepEqual(
    [...parseGitStatusRenamesZ(raw)],
    [["src/ren-new.ts", "src/ren-old.ts"]],
    "the pairing is available separately, destination → source"
  );
}

// Rename where the source path contains a space — the old `^(.*) -> (.*)$` split could not
// represent this, and the order must not be inferred from a separator at all.
{
  const raw = z("R  src/ren new name.ts", "src/ren old name.ts");
  assert.deepEqual([...parseGitStatusZ(raw).keys()], ["src/ren new name.ts"]);
  assert.equal(parseGitStatusRenamesZ(raw).get("src/ren new name.ts"), "src/ren old name.ts");
}

// A rename that was then edited reads `RM` — one row, and the row's status must keep the
// `R` or the tree would report a plain modification and lose the fact that the file moved.
{
  const raw = z("RM src/ren-edit-new.ts", "src/ren-edit-old.ts");
  const m = parseGitStatusZ(raw);
  assert.deepEqual([...m.keys()], ["src/ren-edit-new.ts"]);
  assert.equal(m.get("src/ren-edit-new.ts"), "RM");
  assert.equal(parseGitStatusRenamesZ(raw).get("src/ren-edit-new.ts"), "src/ren-edit-old.ts");
}

// A copy (`C`) carries a source record too — same one-row rule, same pairing.
{
  const raw = z("C  src/copy.ts", "src/origin.ts");
  assert.deepEqual([...parseGitStatusZ(raw).keys()], ["src/copy.ts"]);
  assert.equal(parseGitStatusRenamesZ(raw).get("src/copy.ts"), "src/origin.ts");
}

// A rename followed by an ordinary record: the source record is consumed, so the next entry
// must still be read as `<status> <path>` and not as a stray source path.
{
  const raw = z("R  src/new.ts", "src/old.ts", " M src/after.ts");
  const m = parseGitStatusZ(raw);
  assert.deepEqual([...m.keys()], ["src/new.ts", "src/after.ts"]);
  assert.equal(m.get("src/after.ts"), "M");
  assert.deepEqual([...parseGitStatusRenamesZ(raw)], [["src/new.ts", "src/old.ts"]]);
}

// A truncated rename (status record with no source) must not become a pairing keyed to a
// nonexistent source, and must not swallow the next record.
{
  const raw = z("R  src/new.ts");
  assert.deepEqual([...parseGitStatusZ(raw).keys()], ["src/new.ts"]);
  assert.deepEqual([...parseGitStatusRenamesZ(raw)], [], "no source record means no pair");
}

// A directory-shaped path is rejected here, which is what stops the nameless row upstream.
{
  const m = parseGitStatusZ(z("?? brand-new/"));
  assert.deepEqual([...m.keys()], [], "an untracked directory record must not become a path");
}

// `--untracked-files=all` is what makes the individual files arrive instead of the directory.
{
  const m = parseGitStatusZ(z("?? brand-new/sub/deep/file.ts"));
  assert.equal(m.get("brand-new/sub/deep/file.ts"), "??");
}

// ============================================================================
// parseGitNumstatZ
// ============================================================================

// The record layout differs from status: counts and path share a record, separated by tabs,
// and a path may itself contain tabs after the second one.
assert.deepEqual(parseGitNumstatZ(z("2\t1\tsrc/modified.ts")).get("src/modified.ts"), { added: 2, deleted: 1 });

// Rename here is the OPPOSITE order from status -z: the path field is empty and the two
// paths follow as records with the SOURCE first. Sharing a rename parser between the two
// commands would get this backwards.
{
  const m = parseGitNumstatZ(`${"0\t0\t"}${NUL}src/old.ts${NUL}src/new.ts${NUL}`);
  assert.deepEqual([...m.keys()], ["src/new.ts"], "keyed by the destination, which git puts second here");
}

// The rename consumes exactly two path records; the following entry must still parse.
{
  const m = parseGitNumstatZ(`${"0\t0\t"}${NUL}a.ts${NUL}b.ts${NUL}${"4\t2\tc.ts"}${NUL}`);
  assert.deepEqual([...m.keys()], ["b.ts", "c.ts"]);
  assert.deepEqual(m.get("c.ts"), { added: 4, deleted: 2 });
}

// A truncated rename (only one path record) must be skipped, not mis-keyed.
{
  const m = parseGitNumstatZ(`${"0\t0\t"}${NUL}src/old.ts${NUL}`);
  assert.deepEqual([...m.keys()], []);
}

// Directory-shaped paths are rejected here too, so a stat cannot be keyed to something that
// has no row.
{
  assert.deepEqual([...parseGitNumstatZ(z("0\t0\tbrand-new/")).keys()], []);
}

console.log("workspace-git-paths validation passed");
