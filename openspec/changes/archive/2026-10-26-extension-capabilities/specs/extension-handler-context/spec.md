## ADDED Requirements

### Requirement: Handlers receive a live context

Every extension handler SHALL receive the current `ExtensionContext` as a trailing argument, in
addition to whatever the handler already closes over: interceptors and observers (`(event, ctx)`),
tool `execute` (`(input, options, ctx)`), command `execute` / `injectMessage` (`(args, ctx)`),
context-section producers (`(ctx)`), the message transformer (`(transformCtx, ctx)`) and the awaited
flush (`(ctx)`). The synchronous exit flush SHALL NOT receive it — it runs on `process.on("exit")`,
where no run exists.

The argument SHALL be **live**, not a snapshot taken at activation: it reads the current session,
run and model at call time. A handler MUST NOT be able to observe a value from a previous run or a
replaced session through it.

#### Scenario: Event handler sees the current run

- **WHEN** an extension observes `agent:stop` and calls `ctx.getMessages()`
- **THEN** the returned window is the run that just finished, not the activation-time snapshot

#### Scenario: Session replacement invalidates old state

- **WHEN** the user switches session and a handler runs afterwards
- **THEN** `ctx.sessionId` is the new session and the old context's facts are no longer returned

#### Scenario: Additive signatures

- **WHEN** an existing handler is written with only its original arguments
- **THEN** it still activates and runs unchanged

### Requirement: The context exposes run and session facts

`ExtensionContext` SHALL expose, at call time:

- `sessionId` — the active disk session id, or `null` when none is bound;
- `sessionName` — the session's display name, or `null` when none is bound (also reported by
  `ctx.ui.getContext()`);
- `isIdle()` — whether a run is in flight;
- `mode` — the session mode as `AgentMode` (`normal` / `auto` / `plan`), the same value the
  `session:mode` channel and the UI report; a plan *phase* is not a mode;
- `model` — the model the session is currently using, if known;
- `getContextUsage()` — `{ fillTokens, limitTokens }`: the fill (the same single reading as
  `UsageTracker.getContextFillTokens()`) and the budget it is measured against, or `undefined` when
  no budget is configured;
- `getSystemPrompt()` — the effective system prompt for the current run;
- `getMessages()` — a read-only copy of the model-visible conversation (compaction and synthetic
  `<ctx>` blocks included);
- `signal` — the active run's `AbortSignal`, or `undefined` when idle.

Every fact SHALL be read through the same source the runtime itself uses; a second derivation
(e.g. a separate token estimate for `getContextUsage`) is not permitted.

#### Scenario: Context fill matches the UI

- **WHEN** an extension reads `ctx.getContextUsage()` during a run
- **THEN** the value equals the percentage basis the footer uses
- **AND** it follows `getContextFillTokens()`, not raw `inputTokens`

#### Scenario: No run in flight

- **WHEN** a command handler runs while the agent is idle
- **THEN** `ctx.isIdle()` is true and `ctx.signal` is `undefined`
- **AND** the other facts still describe the bound session

#### Scenario: Read-only conversation copy

- **WHEN** an extension mutates the array or an object returned by `ctx.getMessages()`
- **THEN** the next model request is unaffected

### Requirement: Re-enabling restores the context

Disabling an extension releases its per-dispatch registrations; enabling it again SHALL restore the
same live context, so a handler registered by the re-activation receives it exactly as it did before.

#### Scenario: Disable, then enable

- **WHEN** an extension is disabled and then enabled again
- **THEN** its tools, commands, sections, observers and interceptors receive the live context again
- **AND** the context is the same object, still reading current facts

### Requirement: One context object, one shape

The context passed to handlers SHALL have the same shape as the activation context, including the
registration methods, `ui`, `events`, `logger`, `z` and `coreEnv`. Registration methods remain valid
at any time; registering from a handler SHALL behave exactly as registering from activation.

#### Scenario: Same shape everywhere

- **WHEN** an extension stores the context from an event handler and later uses `ctx.ui.render`
- **THEN** it draws into the same slot as a call from activation

#### Scenario: Registering late

- **WHEN** a handler registers a tool while the extension is active
- **THEN** the tool becomes available under the same rules as a registration made at activation
