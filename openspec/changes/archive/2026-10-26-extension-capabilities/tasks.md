## 1. Per-dispatch context

- [x] 1.1 Thread an `ExtensionContext` argument through every dispatch site in `runner.ts`
      (interceptor, observer, tool `execute`, command `execute` / `injectMessage`, context sections,
      message transformer, flush) as an optional trailing argument
- [x] 1.2 Make `signal`, `getMessages()`, `getContextUsage()`, `getSystemPrompt()`, `sessionId`,
      `isIdle()`, `mode`, `model` read live through injected accessors, with the same sources the
      runtime uses (`getContextFillTokens()`, the run projection, the session data)
- [x] 1.3 `getMessages()` returns a defensive copy that cannot reach the wire; assert it in the
      handler-context validator
- [x] 1.4 Migrate the built-in extensions (`memory`, `skills`, `code-mode`, `lsp`) to the argument
      where it replaces captured state — no behaviour change (finding: none captures a run/session
      fact today — their activation-scoped resources stay, and the argument is additive, so no
      built-in needed a change; the existing extension validators confirm behaviour is unchanged)

## 2. Model access

- [x] 2.1 Add `ctx.llm.complete` (messages or prompt, optional `system`, `maxOutputTokens`, `signal`;
      schema form returns validated data) on top of `runSideTextQuery`
- [x] 2.2 Resolve `model` against the session's catalog over the same connection; unknown name → typed
      error; no URL/style/key fields in the shape
- [x] 2.3 Attribute usage to the session tracker inside the wrapper (no caller participation, no
      opt-out), including the failed-but-billed path
- [x] 2.4 Guardrails: default output-token cap, per-run completion budget with a typed refusal
      reported once as an extension error, and a side-query log row carrying the extension id

## 3. Events

- [x] 3.1 Add `turn:end` (`index`, `finishReason`, `toolCalls`) paired with `agent:iteration`
- [x] 3.2 Add `message:start` / `message:end` for assistant messages (role, message id, first-output
      flag, finalized text + tool-call count); fire for tool-call-only messages too
- [x] 3.4 Add `turn:start` (`index` + iteration budget) and pair it with `turn:end`; `agent:iteration`
      stays the retained progress projection with the same index
- [x] 3.3 Register the three events in `AgentEvents`, their metadata (dispatch `emit`, no channel, no
      retained value) and the visibility table (`observable`, default-not-logged)

## 4. Named context sections

- [x] 4.1 Accept a list of sections on the context provider (`name`, `content`, `disabledContent`),
      rendered as `<ctx kind="ext:<extensionId>:<name>">` (base section `ext:<extensionId>`), each
      admitted independently
- [x] 4.2 Keep the single-provider form under the extension-id kind; replace a duplicate section name
      and warn instead of failing activation
- [x] 4.3 Contain a throwing section producer to that section (report + skip), leaving the other
      sections and other extensions intact

## 5. Verification

- [x] 5.1 `validate:extension-handler-context` — live facts after a session switch, `getMessages()`
      copy isolation, idle vs. running, `getContextUsage()` equal to the footer basis
- [x] 5.2 `validate:extension-model-access` — text and structured calls, catalog model selection
      (known/unknown), abort, no-adapter, budget exhaustion, usage totals moving, no request for an
      unknown model
- [x] 5.3 `validate:extension-turn-events` — iteration/turn pairing, tool-only turn, aborted turn,
      message events for text and tool-call messages, no default log rows
- [x] 5.4 `validate:extension-context-sections` — independent admission of two sections, disable/enable
      under the same kinds, duplicate name, throwing producer (finding: `validate:turn-context-kinds`
      needed no change — its rule is catalog-scoped, and extension-owned kinds (`<id>:<name>`) are
      derived dynamically, never written literally; the new validator pins that derivation instead)
- [x] 5.5 Run `pnpm build`, `pnpm typecheck`, the app test suite, core validators, and eslint/prettier
- [x] 5.6 Update `AGENTS.md` (extension section: per-handler context, model access, events, section
      list; and the phase roadmap) plus the `ExtensionContext` doc comments

## 6. Review hardening

- [x] 6.1 Batch 1 — a cancelled tool call's synthetic output is not formatted as a result; `ctx.ui`
      subscriptions are contained + tracked; `disabledContent` cannot opt out of the disable notice;
      observer-failure reporting cannot recurse; the extension exit flush is released on teardown;
      the CLI exit path awaits teardown (bounded)
- [x] 6.2 Batch 2 — hook payloads carry `agentId` (+ real `sessionId`), `session:start` is awaited,
      child events carry `parentId`, built-ins declare `BUILTIN_EXTENSION_ORDER`, extension kinds are
      namespaced `ext:…`, interception boundaries documented in the authoring skill
- [x] 6.3 Batch 3 — ACP installs the process log guards; `ctx.env` is the extension's config map
      (documented, dead `<ID>_API_KEY` lookup removed); the UI context reports the live session name;
      hook event types are exported from `@codent/core`; commands keep a per-name stack so a shadowed
      command is restored; a throwing interceptor is reported as `agent:extension-error` attributed to
      its extension; `dispatch-order` moved to `agent/`; the write-only host command map removed; the
      scoped owner id has one definition; the log table marks its seven specialized rows instead of
      `false`; `runner.ts` sheds the UI/context bridge
