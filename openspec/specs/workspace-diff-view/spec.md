# workspace-diff-view Specification

## Purpose

The terminal diff view backing the workspace panel: how it lists changed files, derives their paths,
and keeps rows, per-file diffs and line counts consistent.
## Requirements
### Requirement: Every changed file appears as a row

The workspace diff view SHALL list every file with uncommitted changes, including files inside directories that git has not yet tracked. For an untracked directory, the view SHALL list the files it contains rather than the directory itself.

#### Scenario: A newly created change directory is fully visible

- **WHEN** `openspec/changes/<name>/proposal.md`, `tasks.md` and a delta spec exist and none of them has ever been committed
- **THEN** each of those files appears as its own row in the diff view

#### Scenario: Nested untracked files are listed individually

- **WHEN** an untracked directory contains files at more than one depth
- **THEN** every file appears as its own row, at its own depth

#### Scenario: Tracked changes are unaffected

- **WHEN** a modified file, a deleted file and a staged rename exist alongside untracked files
- **THEN** all of them are listed, and each existing row is unchanged from before this fix

### Requirement: Parsed paths name real files

The diff view SHALL derive its paths from a parse that yields the real path of each changed file. A path whose bytes do not name a file SHALL NOT enter the row set, regardless of which git command produced it.

Git escapes paths it considers special when asked for line-oriented output — spaces and quotes are quoted, and non-ASCII bytes are octal-escaped by default. A parse that takes such a record literally produces a path that does not exist, so the view SHALL NOT rely on line-oriented output for path extraction.

This applies to **every** command whose output is parsed for paths, not only the commands the diff view itself issues. A path-extracting consumer added later, in this view or another, is covered by the same rule; the survey that established the current set is part of this requirement rather than an assumption behind it.

A rename SHALL produce **one** path, the destination. A `git status --porcelain -z` rename emits two records — the destination, then the source — and the source SHALL be consumed rather than indexed: it no longer exists in the worktree, so a row keyed by it cannot be opened. The `destination → source` pairing SHALL be produced separately by a function that answers only that question, so a consumer that needs the move (the per-file diff and its label) reads it explicitly instead of deriving it from the row set.

#### Scenario: A path containing a space

- **WHEN** a changed file's path contains a space
- **THEN** its row carries the real path, with no added quote characters

#### Scenario: A path containing a quote character

- **WHEN** a changed file's path contains a quote
- **THEN** the row carries the real path, and no intermediate directory is invented from the escaped text

#### Scenario: A path with non-ASCII characters

- **WHEN** a changed file's path contains non-ASCII characters
- **THEN** the row carries the real path rather than its octal-escaped form

#### Scenario: A rename

- **WHEN** a file is renamed
- **THEN** exactly one row is produced, keyed by the destination path — the path that exists — and the source path produces no row
- **AND** the `destination → source` pairing is available separately, and neither path is derived by splitting the record on a separator that can also occur inside a path

#### Scenario: A rename followed by another change

- **WHEN** a renamed file's source record is followed by an ordinary status record
- **THEN** the ordinary record is still parsed as its own row, because exactly one following record is consumed by the rename

#### Scenario: A path that names a directory is rejected

- **WHEN** a record names a directory rather than a file
- **THEN** it produces no row, and no row is produced whose name is empty

#### Scenario: A later consumer in another view is covered

- **WHEN** a consumer outside this view extracts a path from git output
- **THEN** it reads that output NUL-delimited for the same reason
- **AND** the requirement is not read as binding only the commands listed above

### Requirement: Every registered path is one the view can read

A path that appears as a row SHALL be usable to read that file's content. The row set, the per-file diff lookup and the per-file line counts SHALL be derived from the same parsed paths, so a row and its statistics cannot disagree about which file they describe.

For a rename, the row's content SHALL be read as a pair: the new side from the worktree at the destination, the old side from `HEAD` at the **source**. Reading both sides at the destination SHALL NOT be accepted, because `HEAD:<destination>` does not exist — it made every rename report as a whole-file addition with no old side to compare against.

Whether a renamed row has changes SHALL be decided by comparing those two contents, not by the emptiness of a pathspec-limited `git diff`: a pathspec naming either side of a rename always reports a whole-file delete or add, so it cannot distinguish a pure move from a move that was also edited.

#### Scenario: An untracked file shows an added count

- **WHEN** an untracked file with content appears in the diff view
- **THEN** its row shows a non-zero added line count

#### Scenario: A special-character path still shows its count

- **WHEN** a changed file whose path contains a space, a quote, or non-ASCII characters appears in the diff view
- **THEN** its row shows the added/deleted counts git reported for that file, rather than no counts

#### Scenario: Statistics and rows agree on the key

- **WHEN** line counts are merged into the row set
- **THEN** a stat computed for a file matches that file's row, so no row silently loses its counts

#### Scenario: A pure rename shows no content change

- **WHEN** a file is moved and its content is unchanged
- **THEN** its single row reports no added or deleted lines, and the preview shows the move through its label rather than through invented diff lines
- **AND** the preview's header describes it as a rename with identical contents, rather than claiming there are no changes — the row is a change, and its badge says so

#### Scenario: A rename that was also edited shows the edit

- **WHEN** a file is moved and its content is edited in the same change
- **THEN** its single row's diff shows exactly the edited lines, compared against the file's content at the source path in `HEAD`

#### Scenario: A move git did not detect is not treated as a rename

- **WHEN** a file is moved on disk without being staged, so git reports a deletion plus an untracked file
- **THEN** the view renders those two states as git reported them, and does not invent a rename pairing

### Requirement: Diff-view path handling is covered by tests

The path rules above SHALL be covered by automated tests, because each defect they replace was silent — a wrong path renders a row that looks plausible, and no test failed.

#### Scenario: The parse and tree rules are covered

- **WHEN** the test suite runs
- **THEN** it asserts that a directory-shaped record yields no file row, that an untracked directory's files each yield a row, that a rename yields one row with its pairing available separately, and that quoted and non-ASCII paths survive the parse as real paths

#### Scenario: Coverage is derived from git's own output

- **WHEN** the path-handling tests are written
- **THEN** their inputs are taken from git's actual output for such paths, so the tests pin the real escape behaviour rather than a copy of it

#### Scenario: Rename behaviour is exercised against a real repository

- **WHEN** the rename rules are tested
- **THEN** at least one case builds a scratch repository, performs a real move, and asserts against the output of the real `git status` / `git diff` / `git show` commands, because the defect was about what those commands print and what a reader can then open — a hand-written payload cannot reproduce it
- **AND** it drives those commands through the same CoreEnv implementation the product uses, so the test cannot pass against a command surface the product never issues

#### Scenario: The badge and the directory counts are both covered

- **WHEN** the classification rule is tested
- **THEN** the assertions cover both consumers — the kind chosen for the badge, and the bucket a directory summary increments — because the precedence bug existed independently in each

### Requirement: A change's status is classified once

The status code shown for a changed path SHALL be classified by one rule shared by every surface that reads it — the file tree's badge and the per-directory counts. A rename that was also modified (`RM`) SHALL be classified as a rename, not as a modification: the modification is what the row's diff shows, while the badge exists to say the path changed identity. Each surface SHALL NOT carry its own copy of the precedence.

The classification SHALL distinguish a rename (`R`) from a copy (`C`) as separate kinds, so a surface that renders the letter reads it from the classification rather than re-deciding it from the raw status string. Both kinds SHALL count as a move wherever a move is counted.

#### Scenario: A rename that was also modified

- **WHEN** a changed path's status code is `RM`
- **THEN** its tree badge reports a rename, and the ancestor directory's summary counts it as one rename rather than as a modification

#### Scenario: A copy is classified and counted

- **WHEN** a changed path's status code is `C`
- **THEN** its tree badge reports a copy, and the ancestor directory's summary counts it among its moves rather than falling through every bucket

#### Scenario: An ordinary modification is unaffected

- **WHEN** a changed path's status code is `M` or `MM`
- **THEN** it is classified as a modification, exactly as before

