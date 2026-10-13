## ADDED Requirements

### Requirement: Read-only classification excludes write-capable command forms

A command SHALL be classified read-only only when none of its arguments can write or execute.
By name alone, `env` and `find` SHALL NOT be read-only. A command SHALL be classified
read-only only when:

- `env` — every argument after the command name is a `NAME=value` assignment (no option that
  takes or supplies a command word);
- `find` — no argument is a write/exec predicate (`-delete`, `-exec`, `-execdir`, `-ok`,
  `-okdir`, `-fprint`, `-fprint0`, `-fprintf`, `-fls`);
- `sed` — no script performs a `w`, `W`, `r`, `R`, or `e` command (including an `s///w` flag);
- `git log` / `git diff` / `git show` — no `--output` or `--output=<file>` argument.

#### Scenario: env cannot smuggle a command

- **WHEN** the command is `env rm -rf src` or `env -i sh -c "rm -rf src"`
- **THEN** it is not read-only and requires approval
- **AND** `env FOO=1` (a pure assignment list) is still read-only

#### Scenario: find write and exec predicates are writes

- **WHEN** the command is `find . -delete` or `find . -exec rm -rf {} ;`
- **THEN** it is not read-only
- **AND** `find . -name "*.ts"` is still read-only

#### Scenario: sed script commands that write are writes

- **WHEN** a `sed` script performs `w` / `W` / `r` / `R` / `e` (for example `sed -n "1w /tmp/pwn" f`)
- **THEN** the command is not read-only
- **AND** `sed -n "1,20p" f` and `sed "s/foo/bar/" f` are still read-only

#### Scenario: git output flag is a write

- **WHEN** the command is `git diff --output=/repo/x`
- **THEN** it is not read-only
- **AND** `git diff --output-indicator-new=x` is not treated as a write

### Requirement: The read-only classification is covered by a validator

The repository SHALL maintain an automated validator asserting the classification above: every
write-capable form is not read-only, and the genuine read-only forms still are.

#### Scenario: Validator is present and non-vacuous

- **WHEN** the core validator suite runs
- **THEN** it includes `validate:command-safety-readonly`
- **AND** that validator fails if any write-capable form above is classified read-only
