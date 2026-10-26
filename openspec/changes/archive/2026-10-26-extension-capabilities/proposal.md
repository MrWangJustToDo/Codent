## Why

Our extension runtime gives an extension *registration* (tools, commands, interceptors, one context
provider, one message transformer, a render slot) and **nothing else**. It cannot ask a model
anything, cannot count what it spends, cannot read the conversation it is shaping, cannot tell
whether the run answered, and cannot contribute a second context section. Every capability that
needs those lives in `core` behind a private service.

The memory subsystem is the clearest casualty (`agent/memory/extension.ts` owns tools/index/`/memory`
while selection, extraction, usage accounting, the surfaced-commit timer and the selection's own
context kind live in `managers/services/memory-service.ts` and the run lifecycle — its header comment
admits the split), but it is not the only one: skills, LSP and code-mode all reach into core-side
plumbing that an outside extension could not reach.

Pi's extension system (`badlogic/pi-mono`) shows the shape that closes the gap: a **live context per
handler** (`ctx.modelRegistry.complete(...)`, `ctx.signal`, `ctx.sessionManager`, `ctx.isIdle()`),
turn- and message-level events, and per-run prompt/context editing. This change builds the same axis
for our runtime, in one phase, so extensions become able to **observe, compute and contribute** —
not just register.

## What Changes

**A live per-handler context.** Handlers receive an `ExtensionContext` as a trailing argument
(interceptors, observers, tool `execute`, command `execute`/`injectMessage`, context providers), in
addition to the activation context they already capture. The context is not a snapshot: it reads the
current session, run and model through accessors, so a session switch or a new run cannot leave a
handler acting on stale state.

**Model access (`ctx.llm`).** One-shot completions — text or schema-constrained — over a message
list, using the session's own connection. An optional `model` picks another entry **from the
session's catalog** (never a new provider or key). Tokens are attributed to the session's usage
tracker automatically; there is no caller-side accounting to forget. No streaming, no tools, no
transcript entry.

**Read facts.** The context exposes what an extension needs to reason about the run it is in:
`sessionId`, `isIdle()`, plan/auto mode, current model, context-window fill, the effective system
prompt, a read-only copy of the model-visible conversation, and the run's abort signal.

**Turn and message events.** `turn:start` / `turn:end` bracket one model turn (index + budget; finish
reason + tool-call count), and `message:start` / `message:end` expose assistant message boundaries.
This replaces the temptation to bolt on a purpose-built "first output" event: it is derivable, and
every consumer gets the general facts instead.

**Named context sections.** One extension may publish several per-turn sections (`index`,
`selection`, …), each admitted by its own content hash so a changing section never re-injects a
stable one.

**Roadmap (explicitly out of this change).** Phase 2: the *write* side — `ctx.abort()`, `ctx.compact()`,
session writes (`sendMessage` / `appendEntry`), and `ctx.executeTool()` with hook parity. Phase 3:
interactive UI requests (confirm/select/input over the remote-friendly JSON protocol), runtime
provider/MCP registration, reload and a trust gate. Phase 4: streaming completions and TS-on-the-fly
loading. Each is a deliberate slice; none is needed to unblock memory.

## Capabilities

### New Capabilities

- `extension-handler-context`: a live, per-dispatch context (its shape, freshness, invalidation and restoration after a disable/enable), and the run/session facts it exposes.
- `extension-model-access`: `ctx.llm` — one-shot text/structured completions over a message list, model selection within the session catalog, automatic usage attribution, abort and guardrails.
- `extension-turn-events`: explicit turn boundaries (`turn:start` / `turn:end`) and assistant message events.
- `extension-context-sections`: several named per-turn sections per extension, admitted independently.

### Modified Capabilities

<!-- None. New events are covered by `agent-event-bus`'s "adding an event edits the registry + metadata"
     rule and by `extension-event-observation`'s exhaustiveness requirement, so no existing
     requirement changes. -->

## Impact

- `@codent/core`:
  - `agent/extension/types.ts` — `ExtensionContext` additions (`llm`, run/session facts, `signal`,
    `getMessages`), the optional trailing handler argument, and the section list form.
  - `agent/extension/runner.ts` — per-dispatch context construction, multi-section collection, and
    threading the argument through every dispatch site (interceptor, observer, tool, command,
    provider, transform, flush).
  - `agent/extension/event-visibility.ts`, `agent/agent-event-bus/{types,meta}.ts` — `turn:end`,
    `message:start`, `message:end` registry/meta/visibility entries.
  - `managers/` — emit the new events from the stream/lifecycle middleware; expose the run's adapter,
    tracker, signal, projection and context fill to the extension runtime.
  - `models/adapter/side-text-query.ts` — reused unchanged; the extension port wraps it.
  - Built-in extensions (`memory`, `skills`, `code-mode`, `lsp`, `log`) — adopt the context argument
    where it replaces captured state (34 registration sites, all additive).
- `@codent/app` / `@codent/acp` / `@codent/server`: no behavioural change (hosts only observe events).
- Tests: `validate:extension-handler-context`, `validate:extension-model-access`,
  `validate:extension-turn-events`, `validate:extension-context-sections`. (`validate:turn-context-kinds`
  needs no change: extension-owned kinds are not catalog kinds.)
- Docs: `AGENTS.md` extension section (replace the "registration only" description with the new
  access surface and the phase roadmap) and the `ExtensionContext` doc comments.
