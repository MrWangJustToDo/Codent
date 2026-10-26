## MODIFIED Requirements

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

## ADDED Requirements

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
