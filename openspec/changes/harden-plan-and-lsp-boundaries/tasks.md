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

- [ ] 2.1 `LspConnection.sendRequest(method, params, options?: { timeoutMs?: number; signal?:
  AbortSignal })` in `env/lsp.ts`, documented as the contract: bounded, cancellable, and a rejection
  that is an ordinary tool failure.
- [ ] 2.2 `@codent/node`'s LSP transport applies `options.timeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS`
  to every request, wires `options.signal` to the request's cancellation token, and on expiry cancels
  the outstanding request (jsonrpc `CancellationTokenSource` → `$/cancelRequest`) before rejecting with
  a message naming the method and the deadline.
- [ ] 2.3 The LSP tools and `shared/resolve-position.ts` pass the run's signal
  (`ctx.abortSignal`) through, so a stopped run settles a pending request immediately.
- [ ] 2.4 `validate:lsp-request-deadline`: a connection that never answers rejects within the deadline
  with the request named, a request cancelled by the caller's signal settles without the deadline, and
  a healthy response is unaffected (the happy path still returns the server's result unchanged).

## 3. Verification

- [ ] 3.1 `pnpm build:core` + `pnpm --filter @codent/core tsc --noEmit`; the two new validators.
- [ ] 3.2 Full gates: `pnpm exec eslint <changed files>`, `node scripts/run-all-validators.mjs --dir
  packages/core`, `pnpm --filter @codent/app test`.
- [ ] 3.3 Non-vacuity: with the derivation replaced by the old name list, 1.3's `code_rewrite` case
  fails; with the transport's deadline removed, 2.4's never-answering case hangs.
