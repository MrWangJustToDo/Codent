# Change: Give LSP requests a deadline and derive plan mode's tool boundary

## Why

Two promises the agent makes that the code does not keep, and both leave a run ungovernable rather
than merely wrong:

- **Plan mode's "read-only" is nominal.** The withheld set is a four-name list (`write_file`,
  `edit_file`, `delete_file`, `kill_command`). The built-in `code_rewrite` is not on it, and it edits
  in place with `dry_run: false` — so a plan can be written while the code it describes is being
  changed underneath it, and plan mode has no other hard gate. Every future editing tool starts out
  exposed the same way.
- **An LSP request has no deadline.** `LspConnection.sendRequest` takes no timeout and the LSP tools
  do a bare `await` with no abort signal anywhere in the path. A language server that stops answering
  (indexing, a wedged process, a half-open pipe) blocks that run forever, and Esc cannot break it
  because nothing listens. Every other tool run in core is bounded.

## What Changes

- Plan mode withholds tools by their declaration: every tool whose `present.category` is `edits` is
  withheld, so a new editing tool is restricted without a second edit. The non-editing exception
  (`kill_command`) is named with its reason where it is declared.
- `LspConnection.sendRequest` accepts a deadline and an abort signal. The host transport applies a
  default deadline to every request, cancels the outstanding request with the server when it trips,
  and rejects with an error naming the request. The LSP tools pass the run's signal.

## Impact

- Specs: `tool-timeout-contract` (added requirement), new `plan-mode-tool-boundary`.
- Code: `agent/plan/plan-tools.ts`, `agent/tools/presentation/types.ts` (the category's meaning is
  documented as load-bearing), `env/lsp.ts`, `@codent/node`'s LSP transport, and the LSP tools
  (`hover` / `definition` / `references` / `symbols` / `completions` / `rename` / `code-actions` /
  `shared/resolve-position.ts`).
- No behaviour change for a healthy server: the deadline only fires where a run would otherwise hang.
