# core-shared-helpers Specification

## Purpose

The one-definition rules for `@codent/core`'s cross-cutting utility logic — text and byte
truncation, byte-size formatting, display line splitting, data-URL/MIME parsing, error and abort
classification, memory expiry, name slugification, binary-media part membership, and presentation
entry formatting — where the shared helpers live, and the guards that fail when a module re-derives
one instead of calling it.

## Requirements
### Requirement: Byte length and byte-bounded truncation have one definition

The system SHALL compute UTF-8 byte length through one definition and SHALL perform byte-bounded
truncation through one definition. No module SHALL re-derive a UTF-8 byte count with
`new TextEncoder().encode(x).length`, and no module SHALL approximate a UTF-8 byte budget from a
character count (for example `length * 2`). Truncation SHALL NOT split a multi-byte character.

#### Scenario: A caller truncates to a byte budget

- **WHEN** instruction loading, memory retrieval, or a captured search result needs to bound text by bytes
- **THEN** it calls the shared byte-truncation definition and contains no binary search or `TextEncoder` byte count of its own

#### Scenario: No character-count approximation of a byte budget

- **WHEN** an LSP tool bounds its output by a byte budget
- **THEN** the bound is computed with the shared UTF-8 byte counter, not `length * 2`

#### Scenario: The definition itself is allowed

- **WHEN** the guard scans the module that defines byte length and byte truncation
- **THEN** that module passes

### Requirement: Character truncation with an omission marker has one definition

Truncating a string to a maximum character count with a trailing omission marker SHALL be performed
by one definition that owns the marker text and reserves its budget. A caller MAY pass a different
limit, but SHALL NOT spell the `slice(...) + "…"` pattern itself.

#### Scenario: A display formatter truncates a value

- **WHEN** a tool input or output formatter shortens a value for display
- **THEN** it calls the shared truncation definition and contains no literal `slice(0, N) + "..."`

#### Scenario: The marker budget is owned once

- **WHEN** two callers ask for the same visible width
- **THEN** the marker reservation is computed in one place, so their results cannot differ by a hand-computed offset (for example `57` vs `60`)

### Requirement: Human-readable byte sizes have one definition

Formatting a byte count as a human-readable `KB`/`MB` string SHALL be performed by one definition.

#### Scenario: Image and PDF sizes render

- **WHEN** `read_file` reports an image or PDF size in its model text and in its display text
- **THEN** both obtain the string from the shared byte-size definition

### Requirement: Display line splitting has one definition

Splitting text into display lines SHALL be performed by one definition, parameterized by whether CRLF
is normalized and whether a trailing empty segment from a final newline is dropped; several
near-identical copies SHALL NOT exist.

#### Scenario: A caller needs normalized lines

- **WHEN** formatted tool output is split for display
- **THEN** it calls the shared line splitter with CRLF normalization

#### Scenario: A caller needs counting semantics

- **WHEN** an output accumulator counts lines without altering content
- **THEN** it calls the shared line splitter with the counting semantics it needs rather than its own `split("\n")` wrapper

### Requirement: Data-URL parsing and MIME mapping have one definition

Parsing a `data:*;base64,` URL SHALL be defined once, covering the MIME type, the payload, and raw
base64 recognition; mapping between MIME types and file extensions SHALL also be defined once. The
media module SHALL NOT maintain a second MIME map.

#### Scenario: A data URL is parsed

- **WHEN** webfetch, media persistence, or a model adapter needs the MIME type or payload of a data URL
- **THEN** it calls the shared parser and carries no `data:` regular expression of its own

#### Scenario: MIME-to-extension is not duplicated

- **WHEN** media persistence writes a content-addressed file
- **THEN** the extension comes from the single MIME-to-extension map, and no second map for the same purpose exists

### Requirement: Failure classification has one definition

Normalizing an unknown thrown value to an `Error` SHALL be performed by one definition, and deciding
whether a failure is a user abort SHALL be performed by one definition. A module SHALL NOT spell
`error instanceof Error ? error : new Error(String(error))`, and SHALL NOT test
`error.name === "AbortError"`, outside that definition. The abort verdict itself remains the one
owned by the run-abort rules; this requirement forbids re-deriving it, not restating its semantics.

#### Scenario: A caught value is normalized

- **WHEN** a module needs a guaranteed `Error` from a `catch`
- **THEN** it calls the shared normalizer, and the guard fails if it re-spells the ternary

#### Scenario: An abort is classified

- **WHEN** a module must decide whether a failure is a user abort
- **THEN** it calls the shared abort predicate and does not test the error name inline

### Requirement: Domain classifiers have one definition

Classifying a memory as expired and producing a name slug SHALL each be defined once. A caller whose
slug policy differs SHALL pass that policy to the shared definition rather than maintaining a second
slugify implementation.

#### Scenario: Expiry is classified

- **WHEN** memory listing or extraction filtering decides whether a memory has expired
- **THEN** both use the one expiry definition

#### Scenario: Slug policy differs by caller

- **WHEN** the memory store and the plan store each produce a slug with a different character policy
- **THEN** they call one slug definition with their policy, and no second slug skeleton exists

### Requirement: Binary media part membership has one definition

The set of part types carrying inline binary media SHALL be defined once, covering `image`, `audio`,
`video`, and `document`, and used by every membership test in the media module.

#### Scenario: A part is tested for binary media

- **WHEN** media dehydrate or hydrate tests whether a part is binary
- **THEN** it uses the one membership definition, and no second set or `||` chain lists the same four types

### Requirement: Presentation entry formatting shares one truncation primitive

The generic-argument formatter and the tool-argument formatter SHALL share one entry-truncation
primitive, since both render an object's entries as truncated `key=value` strings.

#### Scenario: Two entry formatters agree

- **WHEN** either formatter truncates a stringified entry value
- **THEN** it calls the shared truncation definition, so the two cannot drift in pattern or budget

### Requirement: Shared cross-cutting helpers live in one place

Cross-cutting utility helpers SHALL live under `packages/core/src/utils/` (or the owning domain for a
domain-specific classifier), SHALL be imported by deep path, and SHALL NOT introduce an `index.ts`
barrel unless the directory is consumed as a unit. A helper module's file name SHALL state its
responsibility.

#### Scenario: A caller imports a shared helper

- **WHEN** a module under `agent/`, `managers/`, `models/`, or `provider/` needs a shared helper
- **THEN** it imports the defining module by deep path, and no barrel is added under `utils/`

#### Scenario: The layer graph stays acyclic

- **WHEN** a `utils/` helper needs a type from another layer
- **THEN** the dependency is type-only or the helper moves to the owning domain, so `utils/` remains a leaf

### Requirement: Re-derived shared rules fail a check

A check SHALL fail when a source module re-spells a shared rule instead of calling its definition,
naming the module and line, so the count cannot grow back by copying a neighbour. The check SHALL
allowlist the single definition module, and each guard SHALL have a corresponding standalone
`validate:*` entry.

#### Scenario: A new inline re-derivation is rejected

- **WHEN** a module contains an inline re-derivation of a shared rule
- **THEN** the check fails and names the module and line

#### Scenario: The definition module passes

- **WHEN** the check runs against the module that defines the rule
- **THEN** that module passes

#### Scenario: A guard runs in CI

- **WHEN** a guard is added under `packages/core/scripts/`
- **THEN** it runs in CI without editing any workflow, because coverage is discovered

