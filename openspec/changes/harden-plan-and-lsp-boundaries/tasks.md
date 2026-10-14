# Tasks

## 1. Plan mode withholds by declaration

- [x] 1.1 Derive the withheld set in `agent/plan/plan-tools.ts` from `present.category === "edits"`
  (through the presentation registry, so a tool defined anywhere in core is covered), keeping
  `kill_command` as a named exception with its own reason beside it. Both ends must use the derived
  set: the exclude set for the record (`getPlanModeToolExcludeSet`) and the pre-execution refusal
  (`isPlanModeForbiddenTool` / `getPlanModeToolBlockReason`).
- [x] 1.2 Document on `ToolActivityCategory` (`presentation/types.ts`) that `edits` is load-bearing for
  plan mode's boundary, so re-categorizing a tool is a boundary change and not a display tweak.
- [x] 1.3 `validate:plan-tool-boundary`: every built-in whose presentation declares `edits` is withheld
  while restricting (including `code_rewrite`), every non-`edits` mutator the restriction names is
  listed with a reason, and the refusal path refuses a withheld call that arrives anyway.

## 2. LSP requests carry a deadline

- [x] 2.1 `LspConnection.sendRequest(method, params, options?: { timeoutMs?: number; signal?:
  AbortSignal })` in `env/lsp.ts`, documented as the contract: bounded, cancellable, and a rejection
  that is an ordinary tool failure.
- [x] 2.2 `@codent/node`'s LSP transport applies `options.timeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS`
  to every request, wires `options.signal` to the request's cancellation token, and on expiry cancels
  the outstanding request (jsonrpc `CancellationTokenSource` → `$/cancelRequest`) before rejecting with
  a message naming the method and the deadline.
- [x] 2.3 The LSP tools and `shared/resolve-position.ts` pass the run's signal
  (`ctx.abortSignal`) through, so a stopped run settles a pending request immediately.
- [x] 2.4 The assertions live in `validate:lsp-transport` rather than a new script — it already builds a
  real connection to a mock server, so the mock gained an unanswered method (`test/hang`) plus a log of
  the `$/cancelRequest` notifications it receives, and the checks are: an unanswered request rejects at
  its deadline naming the request, the server was actually told to cancel it, a caller-signal abort
  settles in ~50ms rather than at the deadline, and a healthy request is returned unchanged. A missing
  deadline is a 3s failure (an outer guard), not a hang.

## 3. Verification

- [x] 3.1 `pnpm build:core` + `pnpm --filter @codent/core tsc --noEmit`; the two new validators.
- [x] 3.2 Full gates: `pnpm exec eslint <changed files>`, `node scripts/run-all-validators.mjs --dir
  packages/core`, `pnpm --filter @codent/app test`.
- [x] 3.3 Non-vacuity: with the derivation replaced by the old name list, 1.3's `code_rewrite` case
  fails; with the transport's deadline removed, 2.4's never-answering case hangs.
