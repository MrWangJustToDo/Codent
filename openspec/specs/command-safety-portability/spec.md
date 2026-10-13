# command-safety-portability

## Purpose

How the command-safety layer (parse, arity normalization, file-command classification, approval policy) behaves when the host shell is not bash: shell-kind-aware grammar selection, a table-driven fallback when no grammar exists, what the fallback may and may not grant, and the guarantee that a missing grammar never disables run_command for subagents.
## Requirements
### Requirement: Command analysis is aware of the target shell

Command safety analysis MUST know which shell a command will run under, and MUST NOT assume bash
unconditionally. Platform detection alone is insufficient: a Windows host with Git Bash installed
genuinely runs bash, so the analysis MUST derive the shell kind from the same resolution that
selects the shell.

#### Scenario: Bash grammar is selected only for a bash shell

- **WHEN** a command will be executed by a bash-compatible shell
- **THEN** the bash grammar MUST be used to parse it
- **AND** this MUST hold on Windows hosts where a bash shell was resolved

#### Scenario: A non-bash shell does not get a bash parse

- **WHEN** a command will be executed by PowerShell or cmd.exe
- **THEN** it MUST NOT be parsed with the bash grammar as if it were bash
- **AND** the analysis MUST route it to the table-driven fallback rather than an AST parse

### Requirement: Unavailable shell grammar degrades loudly and safely

When no grammar is available for the target shell, the analysis MUST NOT silently behave as if the
command were unparseable-and-therefore-suspicious. It MUST apply a documented fallback, and the
report MUST carry a machine-readable flag for the degradation so hosts can surface it through
their own observability (session channels, the agent log) rather than the analysis layer writing
to a global console.

#### Scenario: Known commands stay classifiable without a grammar

- **WHEN** the target shell has no grammar and the command names a binary present in the built-in command tables
- **THEN** the analysis MUST still classify it from the tables
- **AND** a known read-only command MUST remain eligible for the read-only path

#### Scenario: The limitation is reported, not hidden

- **WHEN** the target shell has no available grammar
- **THEN** the analysis result MUST indicate that parsing was unavailable for that shell
- **AND** the report MUST be consumable by host-side reporting (a flag on the report), not only reflected in the approval outcome

#### Scenario: Unknown commands stay conservative

- **WHEN** the target shell has no grammar and the command is not present in the built-in tables
- **THEN** the analysis MUST NOT grant read-only status
- **AND** the default outcome MUST be the conservative one

### Requirement: An unavailable grammar must not disable tool execution

A shell-parsing gap MUST NOT make `run_command` unavailable to subagents. Today a parse failure
falls into the approval default, which subagents downgrade to a denial, so a missing grammar
becomes a silent loss of capability with no actionable message.

#### Scenario: Subagent can still run a known read-only command

- **WHEN** a subagent issues a read-only command on a host whose shell has no grammar
- **THEN** the command MUST be permitted
- **AND** it MUST NOT be denied with a message telling the model to ask the main agent for approval

#### Scenario: Genuinely risky commands are still denied

- **WHEN** a subagent issues a command that is not classified as read-only
- **THEN** it MUST still be denied
- **AND** the relaxation MUST NOT apply to unrecognised or write-capable commands

### Requirement: Command tables cover Windows-native commands

The arity table and the file-command classification sets MUST cover Windows-native commands so that
approval normalization is not Unix-only. Table entries MUST be additive: existing POSIX behaviour
MUST NOT change.

#### Scenario: Windows file commands are classified

- **WHEN** a command such as `dir`, `type`, `copy`, `del`, `move`, `findstr`, or `where` is analysed
- **THEN** it MUST be recognized by the command tables
- **AND** its read-only or write classification MUST be correct

#### Scenario: Windows command lookup has an arity entry

- **WHEN** the Windows command-lookup command is normalized
- **THEN** it MUST be treated as the platform counterpart of the POSIX lookup command
- **AND** its normalized prefix MUST NOT retain arguments that should have been dropped

#### Scenario: POSIX classification is unchanged

- **WHEN** a POSIX command is analysed after Windows entries are added
- **THEN** its normalization and classification MUST be identical to the behaviour before this change

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

