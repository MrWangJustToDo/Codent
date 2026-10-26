## ADDED Requirements

### Requirement: An extension may publish several named context sections

The extension runtime SHALL allow one extension to publish more than one per-turn context
section. Each section SHALL carry its own stable kind, and each SHALL be admitted, re-injected
and superseded independently of the others — a change in one section MUST NOT re-inject another.

A single section per extension remains valid and is equivalent to one section whose kind is the
extension id.

#### Scenario: Two sections, independent admission

- **WHEN** an extension publishes sections `index` and `selection` in one turn, and only `selection` differs from the previous turn
- **THEN** only the `selection` block is re-injected
- **AND** the `index` block is left in the wire unchanged

#### Scenario: Section identity survives turns

- **WHEN** a section is unchanged across ten turns
- **THEN** it is not re-injected in any of them

#### Scenario: Disabled extension under the same kinds

- **WHEN** the extension is disabled at runtime
- **THEN** each of its sections is replaced by its declared disabled notice under the same kind
- **AND** re-enabling restores the content under the same kinds

### Requirement: Section kinds are declared, not implicit

Every section SHALL declare a kind at registration, derived from the extension id plus a section
name, and the runtime SHALL render the block's outer tag from that kind rather than from a
literal written in extension code.

Kinds MUST be unique within an extension, and two extensions MUST NOT collide: the namespace is
the extension id.

#### Scenario: Rendered kind

- **WHEN** an extension registers section `selection`
- **THEN** the injected block carries a kind derived from the extension id and `selection`
- **AND** the extension never writes a literal context tag

#### Scenario: Duplicate section name

- **WHEN** an extension registers the same section name twice
- **THEN** the second registration replaces the first and reports a warning
- **AND** the run continues with one section of that kind

### Requirement: Section failures are contained per extension

A throwing section producer SHALL be reported as an extension error and skipped; the extension's
other sections and every other extension's sections SHALL still be injected for that turn.

#### Scenario: One section throws

- **WHEN** a multi-section provider's second producer throws
- **THEN** the first and third sections are injected
- **AND** the failure is reported with the extension id and the section name
