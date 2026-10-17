## ADDED Requirements

### Requirement: The runtime carries the resolved model read

`CodentAgent` SHALL accept the resolved model read at creation (`create({ models })` — the result of the
one shared pipeline, `loadModels`) and SHALL expose it as a read accessor (`readModels()`), alongside its
`env` and its session host. The runtime SHALL **carry** that read and MUST NOT resolve it a second time
(no second `loadModels` call, no per-session re-fetch of the provider plane).

The read SHALL be the **catalog**: the entries with their `style` / `baseURL` / selectable `models` (and the
served model for the remote-provider plane). It MUST NOT carry an "active" selection: which entry/model a
session runs on belongs to that SESSION (its persisted `model` and the entry its connection came from), so
the runtime supplies the list a session chooses from and never a second, runtime-level answer. The default a
new session is seeded with travels with the session's creation defaults, not with the read.

Every entry's selectable list SHALL contain the model the plane resolved as its default; that invariant is
the pipeline's to guarantee and readers SHALL NOT re-check or repair it.

A runtime created without a model read (`models` omitted, e.g. a test or a `--remote-session` runtime that
was handed no list) SHALL report `readModels()` as `undefined` — absence, never an invented list.

Hosts and connection layers (the TUI's model command, the ACP host's selectors and write paths) SHALL
project this accessor rather than deriving an available-model list of their own.

#### Scenario: The read is the pipeline's result, not a second resolution

- **WHEN** a runtime is created with the result of `loadModels({ kind: "provider" })`
- **THEN** `readModels()` SHALL return those entries and that active selection unchanged
- **AND** reading it SHALL NOT issue another `GET /api/provider/info` (no per-read network work)

#### Scenario: Two runtimes do not share a read

- **WHEN** two runtimes are created with different `loadModels` results (different workspaces or provider
  planes)
- **THEN** each `readModels()` SHALL report its own entries
- **AND** neither SHALL observe the other's list

#### Scenario: The selection belongs to the session, not the runtime

- **WHEN** a runtime is created with a model catalog and a session is created from it, then the session's
  model changes
- **THEN** the session SHALL report the new model (and the entry it came from)
- **AND** `readModels()` SHALL be unchanged — the catalog is not a selection, and a second session on the
  same runtime SHALL choose independently

#### Scenario: No read supplied means no list

- **WHEN** a runtime is created without `models`
- **THEN** `readModels()` SHALL be `undefined`
- **AND** a host reading it MUST NOT synthesise a model list from the environment, the provider, or the
  process-global registry
