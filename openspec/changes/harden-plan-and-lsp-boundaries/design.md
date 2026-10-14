# Design — plan-mode tool boundary + LSP request deadline

## D1 — The boundary is derived from the declaration, not from a list

`present.category` already says what a tool does (`reads` / `edits` / `searches` / `commands` /
`tasks` / `other`), and it is declared exactly once per tool, next to the tool. Plan mode now withholds
by category (`edits`), which is what makes `code_rewrite` restricted without naming it, and what makes
a future editing tool restricted without a second edit.

**The field becomes load-bearing for a safety decision, and that is recorded where it is declared.**
The alternative — a second, explicit `mutating: true` flag — was rejected: it is the same fact spelled
twice, and the two spellings can disagree (a tool marked `edits` for display but not `mutating`, or the
reverse). A validator pins the derivation instead: it asserts every tool declaring `edits` is withheld,
and that the explicit exceptions are exactly the ones reasoned at `plan-tools.ts`.

### What the derivation also catches (found while implementing it)

Deriving from the declaration immediately withheld one tool the four-name list had missed besides
`code_rewrite`: `memory_write` declares `edits` (it maintains `.agents/memory/`), so plan mode no
longer lets a plan be authored while the agent rewrites its own memory either. That is the derivation
working as intended — the boundary answers "does this write", not "is this one of the four I remembered"
— and it is the kind of change a name list cannot describe.

## D2 — `kill_command` stays an explicit exception, with its own reason

It does not write the workspace, so it is not an `edits` tool; it is withheld because an unattended
background job has no UI to control it (the same reason `run_command`'s `run_in_background` is refused
while planning). Keeping it a named exception keeps the two reasons apart: the category rule answers
"does this touch the workspace", and the exception answers "can the user control its effect".

## D3 — The LSP deadline lives in the transport, as a default

The requirement is on the `LspConnection` seam, so the enforcement point is the host that implements
it, not each caller: `sendRequest(method, params, { timeoutMs, signal })` applies
`timeoutMs ?? DEFAULT` — a tool that forgets to pass one is bounded anyway, and a host that needs a
different number passes it. Putting the default in the tool instead would make the guarantee depend on
eight call sites remembering it, which is the shape that produced this defect.

The tools pass the run's abort signal, which is the half the seam cannot supply: the connection is
long-lived, the run is not. A stopped run therefore releases a pending request immediately instead of
waiting out the deadline.

## D4 — Cancellation is a real request cancellation

On expiry the transport sends `$/cancelRequest` for that request (via the jsonrpc
`CancellationTokenSource` the request was issued with) and rejects with a message naming the method and
the deadline. Sending the notification matters: a server that is busy computing a completion is
otherwise still working on a request nobody will read, and the next request queues behind it. The
rejection is an ordinary tool error — the tool returns it as its result, the run continues, and the
server keeps its session (a deadline is not a crash).

## D5 — What is NOT changed

- `run_command`'s deadline, `webfetch`, `websearch`: already bounded, untouched.
- The LSP extension's *startup* waits (`AUTO_DIAG_SERVER_WAIT_MS`, `FIRST_SYNC_WAIT_MS`): they bound a
  cold start, which is a different wait with a different honest number, and they already exist.
- `lsp-manager`'s `java/buildWorkspace` call and the transport's own `initialize` / `shutdown`: they
  already carry their own handling (a `.catch()`, or a startup path that the wait bounds).
