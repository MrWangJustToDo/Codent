# extension-ordering Specification

## Purpose

Extension-declared dispatch order: `ExtensionAPI.order` sequences the extension surfaces whose behaviour is observable as a sequence.

## Requirements

### Requirement: Extension-declared dispatch order

`ExtensionAPI` SHALL accept an optional `order?: number`. Lower values SHALL run first. An extension
that omits `order` SHALL be treated as `0`. The declaration SHALL be read once per extension and
SHALL apply to every dispatch-ordered surface the extension registers, so an author expresses
position once rather than per registration.

`order` SHALL govern exactly the surfaces whose behavior is observable as a sequence:

- interceptor dispatch — lower order runs earlier in the chain,
- message-transformer chaining — lower order runs earlier in the chain,
- same-named extension tool resolution — the highest order is the resolution winner, because a later-running extension is the one that supersedes (this is the same "later supersedes" direction the surface already had, now controllable),
- same-named extension command resolution — the highest order is the live command, and disabling it SHALL hand the name back to the next-ranked registration rather than deleting it,
- turn-context section ordering — lower order produces the earlier section.

A non-finite or otherwise invalid `order` SHALL be treated as `0` rather than producing an
implementation-defined sequence.

Ordering SHALL NOT be read as uniformly "lower wins": on the first-run surfaces lower runs first,
while on resolution surfaces (tools, commands) the **later** entrant wins. Both follow from one rule
— resolve the sequence by `(order, load sequence)` and read it in that sequence — so the two
directions SHALL NOT be implemented as separate ad-hoc comparisons.

#### Scenario: A gate declares itself early

- **WHEN** extension A declares `order: -100` and extension B declares `order: 100`, and both register an interceptor for the same hook
- **THEN** A's interceptor is invoked before B's, regardless of the order in which the two extensions were loaded

#### Scenario: An undeclared extension keeps its current position

- **WHEN** extension A declares no `order` and extension C also declares no `order`
- **THEN** A and C run in their existing load order relative to each other, identical to the order before this capability existed

#### Scenario: Invalid order falls back to the default

- **WHEN** an extension declares a non-finite `order`
- **THEN** it is treated as `0` and its position is determined by the tie-break rather than by the invalid value

#### Scenario: A higher order wins a same-named tool

- **WHEN** two extensions register a tool under the same name, the earlier-loaded declaring `order: -10` and the later-loaded declaring `order: 10`
- **THEN** the `order: 10` extension's tool definition is the one resolved

#### Scenario: A shadowed command comes back

- **WHEN** two extensions register a command under the same name and the higher-ranked one is disabled
- **THEN** dispatch and `contextForCommand` resolve the lower-ranked extension's command again

#### Scenario: A lower order produces the earlier context section

- **WHEN** two extensions register a turn-context provider, declaring `order: -10` and `order: 10`
- **THEN** the `-10` extension's `<ctx kind=...>` section precedes the `10` extension's section

### Requirement: Ordering is a stable sort over declared order then load sequence

Dispatch-ordered sequences SHALL be ordered by a **stable sort** on `(order, load sequence)`, where
the load sequence is recorded by the extension runner at load time. Extensions with equal `order`
SHALL retain their load order relative to one another, and this SHALL hold for every governed
surface. The sequence SHALL be the runner's record of load order, not a re-derivation from
discovery order.

#### Scenario: Equal orders preserve load order

- **WHEN** three extensions with no declared `order` are loaded in sequence A, B, C and each registers an interceptor for the same hook
- **THEN** the invocation order is A, B, C

#### Scenario: One declaration does not perturb the others

- **WHEN** extensions A, B, C are loaded in that order with no `order`, and B is later declared `order: 1`
- **THEN** the invocation order is A, C, B, and the relative order of A and C is unchanged

#### Scenario: Negative, zero, and positive all participate

- **WHEN** extensions declare `order: -1`, no `order`, and `order: 1` and are loaded in the reverse of the order they should run
- **THEN** the invocation order is the declared ascending order, not the load order

### Requirement: Interceptor cancellation is position-dependent and stated

The position of a cancelling interceptor SHALL determine which later interceptors run, because a cancelling interceptor ends the dispatch chain. The system SHALL document that an extension which cancels prevents every interceptor declared after it from running, and that this dependency is the reason `order` exists for the interceptor surface.

#### Scenario: A cancelling interceptor suppresses later ones only

- **WHEN** extension A (`order: -100`) cancels a `tool:before:<tool>` event and extension B (`order: 100`) is registered for the same hook
- **THEN** B is not invoked, and neither is any other interceptor declared after A

#### Scenario: A later cancelling interceptor still sees earlier mutations

- **WHEN** extension A (`order: -100`) mutates the shared event without cancelling and extension B (`order: 100`) then cancels
- **THEN** B observes A's mutation before cancelling

### Requirement: Ordering does not touch order-insensitive surfaces

The declared `order` SHALL NOT reorder, delay, or otherwise affect surfaces whose behavior is not
observable as a sequence: observer subscriptions (`observe` / `observeAny`), extension UI render
slots, command lookup, and the flush registrations. Observer dispatch SHALL remain in registration
order, and extension UI slots SHALL remain combined by key rather than by extension position.

#### Scenario: Observers are unaffected by order

- **WHEN** extension A declares `order: -100` and extension B declares `order: 100`, and both register an observer for the same event
- **THEN** both receive the same already-final payload on every emission, and neither can observe a partially-applied state produced by the other

#### Scenario: Render slots are unaffected by order

- **WHEN** two extensions declaring different orders render into the same surface with different keys
- **THEN** the slots are combined by key as before, and the rendered sequence does not change with either extension's `order`

### Requirement: The effective dispatch order is reported

The extension catalog SHALL report each extension's effective position, and SHALL return entries in
dispatch order. The reported position SHALL be the value that actually orders the extension (its
declared `order`, or the default), so a consumer can distinguish "declared early" from "defaulted
early".

#### Scenario: Position is visible in the catalog

- **WHEN** a consumer reads the extension catalog
- **THEN** each entry carries its effective order and the entries are ordered as they are dispatched

#### Scenario: A defaulted extension is distinguishable from a declared one

- **WHEN** an extension declares no `order` and another declares `order: 0`
- **THEN** the catalog reports the same effective position for both, and the declaration state is derivable from the extension definition rather than from the catalog alone

### Requirement: Ordering is stable across reload, disable, and re-enable

Re-registering an extension (disable then enable) SHALL restore its dispatch position, and disabling
an extension SHALL remove it from every governed sequence without shifting the positions of the
remaining extensions relative to one another.

#### Scenario: Disable does not reshuffle the remainder

- **WHEN** extensions A, B, C run in that order and B is disabled
- **THEN** the invocation order is A, C, with A and C still in their original relative order

#### Scenario: Re-enable restores the position

- **WHEN** B is re-enabled after being disabled
- **THEN** B returns to the position determined by its `order` and load sequence, not to the end of the sequence

### Requirement: Built-in extensions are the dispatch baseline

Built-in extensions SHALL declare one canonical below-default order (`BUILTIN_EXTENSION_ORDER`,
currently `-100`), because they load **last**: without a declared position that load position makes
them run last in every chain and win every same-named tool, which is the opposite of a baseline.

#### Scenario: A user extension replaces a built-in tool

- **WHEN** a user extension registers a tool under a name a built-in also registers
- **THEN** the user extension's definition is live, because the built-in's below-default order loses the resolution reading

#### Scenario: A user extension gets the last word in a chain

- **WHEN** a built-in and a user extension both register an interceptor for the same hook
- **THEN** the built-in runs first and the user extension runs after it, even though the built-in loaded last
