## ADDED Requirements

### Requirement: The runtime carries the resolved model read

`CodentAgent` SHALL accept the resolved model read at creation (`create({ models })` — the result of the
one shared pipeline, `loadModels`) and SHALL expose it as a read accessor (`readModels()`), alongside its
`env` and its session host. The runtime SHALL **carry** that read and MUST NOT resolve it a second time
(no second `loadModels` call, no per-session re-fetch of the provider plane).

The read SHALL be the shape the pipeline already produces: the entries with their `style` / `baseURL` /
selectable `models` (and the served model for the remote-provider plane), plus the active entry and the
active model. Every entry's selectable list SHALL contain the active model; that invariant is the
pipeline's to guarantee and readers SHALL NOT re-check or repair it.

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
- **THEN** each `readModels()` SHALL report its own entries and active model
- **AND** neither SHALL observe the other's list or active model

#### Scenario: No read supplied means no list

- **WHEN** a runtime is created without `models`
- **THEN** `readModels()` SHALL be `undefined`
- **AND** a host reading it MUST NOT synthesise a model list from the environment, the provider, or the
  process-global registry
