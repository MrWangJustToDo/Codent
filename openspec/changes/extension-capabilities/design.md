## Context

`ExtensionContext` today is a **registration** surface: tools, commands, interceptors, one context
provider, one message transformer, flushes, an event facade and a render slot. It is passed once, at
activation, and every handler either closes over it or over its own captured state.

Three consequences follow, and they are what this change addresses:

1. **No compute.** No extension can call a model, so any such work must be written in core and
   exposed through a private service. `agent/memory/` is the visible case (selection, extraction,
   usage accounting and the surfaced-commit timer live in `MemoryService` + the run lifecycle), but
   the same wall stops any extension that wants a classifier, a title, a summary or a reranker.
2. **No facts.** An extension cannot tell whether a run answered, what the conversation now looks
   like, how full the context is, or which mode the session is in. It can observe a few coarse
   events; everything else is inferred or unavailable.
3. **One context blob per extension.** A per-turn selection and a stable index cannot coexist: one
   extension publishes one section, so any change re-injects everything.

Pi's extension system solves exactly these three (`ctx.modelRegistry`, a live `ctx` per handler,
`message_*`/`turn_end` events, structured prompt options). This design takes the same axis without
copying its packaging, UI or provider-registration decisions.

## Goals / Non-Goals

**Goals:**

- An extension can **compute** (one-shot model completions, usage accounted automatically),
  **observe** (turn/message boundaries, conversation snapshot, context fill) and **contribute**
  (several independently admitted context sections) — the three things every non-trivial extension
  needs.
- Every new capability reuses an existing port: the one-shot query port, the unified event bus, the
  turn-context kind catalog, the session usage tracker. No parallel machinery.
- The shape is right for extensions we have not written yet: the API takes message lists, not a
  single prompt; a model is chosen by name from the session catalog; the context is live, not frozen.

**Non-Goals (and the phase they belong to):**

| Deferred | Phase | Why now |
|---|---|---|
| `ctx.abort()`, `ctx.compact()`, `ctx.sendMessage` / `appendEntry`, `ctx.executeTool` | 2 | Writes need policy (who may cancel, who may inject into the transcript) and their own audit; the read/compute half is what unblocks current work. |
| Interactive UI requests (confirm/select/input), provider/MCP registration, reload, trust gate | 3 | Each is a large surface; UI must stay JSON/remote-friendly, and trust interacts with the "all extensions get `ctx.llm`" decision. |
| Streaming completions, TS-on-the-fly loading | 4 | Streaming forces a chunk/channel surface into the extension API; nothing today needs it. |
| Moving memory itself | separate change | This change only makes it possible. |

Trust: **`ctx.llm` is available to every extension** (decision). The risk is recorded below; a
`project_trust`-style gate is Phase 3, not a blocker.

## Decisions

### The context is passed per dispatch, not captured once

Handlers gain a trailing `ctx` argument (`(event, ctx)`, `(input, options, ctx)`, `(args, ctx)`),
and the object reads session/run facts through accessors at call time. The activation-time context
stays valid and keeps its shape.

Why: the facts are run- and session-scoped, and the runtime already replaces sessions in place
(`session.new` / `session.resume`). A captured context either freezes those facts or silently
returns stale ones; both are the class of bug that produced "resume shows the old model" before.
Passing it per dispatch also matches how every other runtime part is written (services read live).

Why not replace the activation context outright: registration (`registerTool`, `registerCommand`, …)
is legitimately activation-scoped, and 34 built-in registration sites plus user extensions depend on
it. Additive is honest here — the argument is optional, so existing handlers keep working and the
migration is per handler where a live fact is actually needed.

Note the deliberate consequence: the context is a *live view*, so a handler must not stash it in
long-lived state expecting the old run's facts. That is documented on the type.

### `ctx.llm` is messages-first, catalog-bounded, and auto-accounted

Shape:

```
ctx.llm.complete({ system?, messages | prompt, schema?, model?, maxOutputTokens?, signal? })
  → { text }            (no schema)
  → { data }            (schema)
```

- **Messages, not a prompt string.** A single prompt is a shorthand. Extensions that summarize a
  conversation, classify a transcript, or run a two-message refinement need the list from day one;
  widening `prompt` later would be a breaking change to every caller.
- **Model by name from the session catalog.** The runtime resolves it against the same
  `ModelCatalogRead` the UI projects, over the same connection. No base URL / style / key fields
  exist in the shape, so nothing can smuggle a provider. An unknown name is a typed error, not a
  silent fallback — a silent substitution would let an extension believe it ran a cheap model while
  the expensive one answered.
- **Auto-attribution.** The wrapper owns the session `UsageTracker` and records the port's usage
  before resolving. Pi asks callers to merge nested usage into their results; our own history
  (`validate-memory-extraction-usage`: tokens reached the jsonl but no session total) shows that
  discipline loses. There is no opt-out parameter.
- **Reuse `runSideTextQuery`.** It already implements capability-driven structured/text selection,
  text-mode contract rendering, and refusal of schema shapes it cannot express. A second
  implementation would drift.
- **Guardrails.** Default `maxOutputTokens`; a per-run completion budget that fails closed; each
  call logged as a side query with the extension id. The budget is a runtime config with a constant
  default, since an unbounded extension loop is the one failure mode that costs real money.

No streaming (Phase 4): it would add a chunk channel and cancellation surface for no current caller.

### Turn start is `agent:iteration`; this adds `turn:end` plus message events

`agent:iteration` already reports `{ current, max }` per turn and is retained on the `iteration`
channel — a second `turn:start` would be a duplicate source. `turn:end` completes it with the
finish reason and tool-call count, which is what "act after a model response and its tool calls"
needs.

`message:start` / `message:end` are the general form of "the model produced output". This is
deliberately **not** a bespoke `agent:first-output`: memory's commit point (surfaced memories) is
just the first assistant `message:start`, and every other consumer wants the boundaries anyway.
Two to four extra events per turn are cheap to the bus (observable, not default-logged), while a
purpose-built event would be a permanent shape for one caller.

Why not Pi's `agent_settled`: our runtime has no automatic post-run continuation loop — the pump's
iterations live inside a run and `agent:stop` already means "no more work will start on its own".

### Several named sections per extension

The context provider gains a list form: `{ name, content, disabledContent }`, rendered as
`<ctx kind="<extensionId>:<name>">`, each hashed and admitted independently by the existing
turn-context middleware. The legacy single-provider form keeps the extension-id kind.

Why: memory needs a stable index block and a per-turn selection block. One block would re-inject
the whole index whenever the selection changes — a real prompt-cache regression, not a cosmetic one.

### Access, not authority

This phase adds reads and computations. Writes (abort, compact, transcript injection, tool
orchestration) are Phase 2 because each needs a policy decision (does an extension's `abort` beat the
user's? what happens when two extensions inject messages?) and an audit trail. Keeping Phase 1
read-only means the blast radius of a misbehaving extension is "it spends tokens and shows wrong
context", not "it silently cancels runs".

## Risks / Trade-offs

- **Any extension can spend tokens** → the session connection bounds *where* (no new keys), the
  per-run budget bounds *how much*, and the side-query log bounds *observability*. A trust gate is
  Phase 3; until then, loading an extension is a trust decision (documented).
- **Per-dispatch context adds allocation per handler call** → the object is a thin view over
  accessors (no snapshot copies except `getMessages`, which is explicit); the bus already allocates
  an event per dispatch.
- **`getMessages()` returns a copy** → copying a 200-message window per call could be measurable if
  called in a hot loop. Mitigation: document it as handler-time work, and (implementation) copy
  lazily — the projection array is already fresh per call, so only the message objects need
  shielding.
- **`turn:end` / `message:*` volume** → classified observable and default-not-logged; only
  subscribers pay.
- **A model chosen by name may lack structured output** → the port already falls back to text mode
  using that model's capabilities; the caller sees either validated data or a typed failure.
- **Live context misused as long-lived state** → the type documents it; a handler that stashes it
  sees current facts, which is the safer failure.

## Migration Plan

Additive: new optional handler argument, new context members, new events, new provider list form.
No persisted state. The memory migration follows as its own change and may restructure its own log
scope/naming freely (no compatibility work is owed).

## Open Questions

- Per-run completion budget: constant vs. `ManagedAgentConfig` field (default: constant, overridable).
- Whether `getContextUsage()` should report the raw model window as well as the compaction budget
  (the footer shows the latter; an extension may want the former).
- Whether Phase 2's `ctx.executeTool()` reuses the code-mode sandbox bindings or the live tool
  registry (both exist; the registry is the correct one for hook parity).
