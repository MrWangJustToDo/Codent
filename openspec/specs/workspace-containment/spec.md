# workspace-containment Specification

## Purpose
TBD - created by archiving change harden-tool-safety-boundaries. Update Purpose after archive.
## Requirements
### Requirement: Search tools confine their path to the workspace root

`glob`, `grep`, and `tree` SHALL resolve the caller's `path` against the workspace root
(`CoreEnv.rootPath`, never the host's `process.cwd()`), SHALL reject a path that resolves
outside the root, and SHALL run their search binary with the workspace root as its working
directory so the default `path:"."` means the root.

#### Scenario: An escaping path is rejected before the binary runs

- **WHEN** `path` is `"../.."` or an absolute path outside the workspace root
- **THEN** the call fails with a traversal (`permission_denied`) error
- **AND** no search binary is spawned

#### Scenario: Searches are rooted, not cwd-relative

- **WHEN** `path` is omitted or relative
- **THEN** the search runs with `cwd` set to the workspace root
- **AND** the search argument is passed through unchanged, so result paths stay root-relative

### Requirement: The Node filesystem gate resolves symlinks

The Node `CoreEnv` filesystem SHALL reject a path whose real location resolves outside the
workspace root (or an allowed extra read root), not only a path whose lexical form does, so an
in-root symlink pointing outside the workspace cannot escape confinement for reads or writes.
The lexical check SHALL remain the first gate, and a write target that does not exist yet SHALL
still be checked by resolving its deepest existing ancestor.

#### Scenario: An in-root symlink escape is blocked

- **WHEN** an in-root symlink points outside the workspace root
- **THEN** reading or writing through it fails with `permission_denied`

#### Scenario: Legitimate paths are not over-rejected

- **WHEN** the path is a real in-root file, an in-root symlink pointing back inside the root, or
  a not-yet-existing in-root write target
- **THEN** the operation proceeds

### Requirement: Containment is covered by validators

The repository SHALL maintain automated validators asserting both boundaries.

#### Scenario: Validators are present and non-vacuous

- **WHEN** the validator suites run
- **THEN** they include `validate:search-path-containment` and `validate:fs-symlink-containment`
- **AND** a validator that cannot exercise its platform-specific half reports a skip rather than a pass

