# extension-message-transform Specification

## Purpose
TBD - created by archiving change add-extension-message-transform. Update Purpose after archive.
## Requirements
### Requirement: Extension message transformer registration

The `ExtensionContext` SHALL provide `registerMessageTransformer(fn)` returning a disposer. At most one transformer per extension SHALL be active; registering again SHALL replace the previous one. The disposer SHALL only clear the registration when the caller is still the registered transformer. Registration SHALL be tracked per extension so that disabling or destroying an extension removes its transformer along with its other registrations.

#### Scenario: Disposer unregisters

- **WHEN** an extension calls the disposer returned by `registerMessageTransformer` and a run follows
- **THEN** the transformer SHALL NOT be invoked for that run

#### Scenario: Re-registration replaces

- **WHEN** the same extension registers a second transformer without disposing the first
- **THEN** only the second SHALL be invoked

#### Scenario: Stale disposer is inert

- **WHEN** extension A disposes its transformer after extension A has already replaced it with a newer one
- **THEN** the newer transformer SHALL remain registered

#### Scenario: Disabled extension stops transforming

- **WHEN** an extension with a registered transformer is disabled
- **THEN** subsequent runs SHALL NOT invoke its transformer

### Requirement: Transformer runs on every wire build, after channel projection

The transformer SHALL be invoked on every message set sent to the model within a run — the initial call and each subsequent iteration — at a point **after** the channel-anchored wire projection has produced the model messages and **before** the messages are handed to the model engine. The transformer SHALL NOT be placed at a point that is superseded by a later channel projection within the same run. In the managed pipeline this point SHALL be a dedicated middleware that runs immediately after the `compaction` middleware; because both declare the same phase, the relative order SHALL be asserted against the pipeline the runner actually assembles, not against a hand-maintained factory list.

#### Scenario: First call of a run

- **WHEN** a run starts and a transformer is registered
- **THEN** the transformer SHALL be invoked for the initial model call

#### Scenario: Later iteration still transforms

- **WHEN** a run performs a second iteration after tool results and a transformer is registered
- **THEN** the transformer SHALL be invoked for that iteration as well

#### Scenario: Invocation receives the projected chain

- **WHEN** the transformer is invoked
- **THEN** `ctx.messages` SHALL be the model messages produced by the channel projection for that call, not the pre-projection engine array

### Requirement: Transformers receive model-capability context

The transformer context SHALL report model capabilities in full, so an extension never has to re-derive model ability from host configuration. It SHALL include: the raw set of capabilities the provider declared; which multimodal part types the current model does not accept, derived from the same capability source that gates pre-send stripping; and a named boolean per capability in the model-capability list. Unknown capabilities and declared-but-empty capabilities are different states, and the raw set is what tells them apart. When capabilities are **unknown** the raw set SHALL be `null`, the unsupported set SHALL be empty, and every capability boolean SHALL be `true` (permissive). When capabilities were **resolved and the model declares none**, the raw set SHALL be empty, every capability boolean SHALL be `false`, and the unsupported set SHALL contain every multimodal part type.

The capability list SHALL have a single runtime source of truth from which the capability union type is derived, and the named booleans SHALL be derived from a table exhaustively keyed by that union, so adding a capability cannot produce a context that silently omits its boolean.

#### Scenario: Capability set is exposed

- **WHEN** the current model lacks the vision capability and a transformer is invoked
- **THEN** `ctx.unsupportedPartTypes` SHALL contain `image` and `ctx.modelHasVision` SHALL be false

#### Scenario: Every capability has a named boolean

- **WHEN** the provider declares exactly one capability
- **THEN** exactly that capability's boolean SHALL be true and the others SHALL be false

#### Scenario: The capability list and the boolean surface cannot drift

- **WHEN** a capability is added to the model-capability list
- **THEN** the contextual boolean surface SHALL be required by the type system to name it, rather than silently omitting it at runtime

#### Scenario: Unknown capabilities stay permissive

- **WHEN** the model's capabilities are unknown or empty
- **THEN** `ctx.unsupportedPartTypes` SHALL be empty, `ctx.capabilities` SHALL be empty, and every `modelHas*` flag SHALL be true

### Requirement: Transform is wire-only and never persisted

A transformer's returned messages SHALL affect only the current run's model-facing wire. The system SHALL NOT write transformer output back to the UI channel, the session store, or any durable conversation state. Transformer output SHALL NOT be reused as input to a later run.

#### Scenario: Channel unchanged after transform

- **WHEN** a transformer replaces media parts with text and the run completes
- **THEN** the UI channel's message list SHALL be unchanged from before the run

#### Scenario: Persisted session unchanged

- **WHEN** a session is saved after a run in which a transformer rewrote messages
- **THEN** the persisted messages SHALL NOT contain the transformer output

#### Scenario: No cross-run leakage

- **WHEN** a second run starts after a run whose transformer produced an output
- **THEN** the second run's input SHALL be derived from the channel, not from the previous transformer output

### Requirement: Transformer owns the messages it is handed

The system SHALL hand each transformer an array and message objects that the system does not reuse elsewhere — specifically, not the array retained by the wire-projection cache. In-place edits to the message array or to a message object's own fields SHALL therefore NOT reach any other call or any retained state. The content-part objects inside a message SHALL NOT be promised as exclusively owned; a transformer that needs to change a part SHALL return a new message rather than mutating a part in place. When no transformer is registered, the existing wire-projection caching behaviour SHALL be preserved byte-for-byte, including reuse of the cached array identity.

#### Scenario: In-place edit does not reach the retained wire

- **WHEN** a transformer mutates a message object's field in place and returns `void`
- **THEN** the array retained for the wire-projection cache SHALL remain unmodified

#### Scenario: A repeated call still transforms

- **WHEN** two consecutive calls would be handed the same cached projection
- **THEN** each call SHALL apply the transformer afresh, and an in-place edit from the first call SHALL NOT make the second a no-op

#### Scenario: Zero-overhead when absent

- **WHEN** no transformer is registered
- **THEN** the wire projection cache SHALL be consulted exactly as before this change, no additional projection SHALL be computed, and the wire seam SHALL make no change to the engine configuration

### Requirement: Transformer chaining, ordering, and failure isolation

Multiple transformers SHALL run sequentially in the declaring extension's declared dispatch order (lower first, load sequence as the tie-break), each receiving the previous transformer's output. Transformer errors SHALL be contained: the system SHALL log a warning naming the extension, SHALL retain the last valid message set, and SHALL continue with any remaining transformers and with the run. A transformer return value that is not an array of messages SHALL be treated as invalid and SHALL likewise retain the last valid message set.

#### Scenario: Output chains

- **WHEN** extension A's transformer returns messages `[m1]` and extension B's transformer returns messages `[m2]`
- **THEN** the model SHALL receive `[m2]`

#### Scenario: Throwing transformer does not break the run

- **WHEN** a transformer throws
- **THEN** a warning SHALL be logged with the extension id, the message set SHALL be the last valid one, and the run SHALL continue

#### Scenario: Invalid return is ignored

- **WHEN** a transformer returns a non-array value
- **THEN** the last valid message set SHALL be used and a warning SHALL be logged

#### Scenario: Declared order decides which transformer sees whose output

- **WHEN** extension A is loaded first and declares a higher order than extension B, and both register a transformer
- **THEN** B's transformer is invoked first and A's receives B's output, because the chain follows declared order rather than load order

#### Scenario: Undeclared transformers keep their existing chain

- **WHEN** every registered transformer belongs to an extension with no declared order
- **THEN** the chain is the load order, exactly as before declared order existed

### Requirement: Transform does not change message-count guarantees

The transformer contract SHALL NOT promise that message count is preserved, and the system SHALL NOT rely on transformer output preserving the channel's structural invariants (compaction-summary position, keep-policy window). Pruning and compaction SHALL remain the responsibility of the core `context-transform` phase.

#### Scenario: Core invariants hold regardless of transform

- **WHEN** a transformer returns a message list with a different length than its input
- **THEN** the next call's projection SHALL be recomputed from the channel, and the channel's summary-first ordering SHALL be unaffected

### Requirement: Subagents do not inherit transformers

A subagent SHALL NOT run its parent agent's transformers. Subagent runs SHALL build their own extension runner scope, consistent with the existing extension and MCP isolation.

#### Scenario: Subagent wire untouched

- **WHEN** the root agent has a registered transformer and a subagent runs
- **THEN** the subagent's model messages SHALL NOT be passed through that transformer

### Requirement: Message transform is not an event-bus dispatch mode

`registerMessageTransformer` SHALL NOT be implemented as a third `AgentEventBus` dispatch mode, and SHALL NOT be surfaced as an interceptor pattern name. The existing frozen interceptor hook names SHALL remain unchanged.

#### Scenario: No new dispatch mode

- **WHEN** a consumer inspects `AgentEventBus`
- **THEN** only `emit` (observer) and `intercept` (interceptor) dispatch modes exist, and no message-transform event name appears in the interceptor pattern list

#### Scenario: Frozen hook names intact

- **WHEN** an extension registers interceptors for the previously documented hook names
- **THEN** those registrations SHALL behave exactly as before

