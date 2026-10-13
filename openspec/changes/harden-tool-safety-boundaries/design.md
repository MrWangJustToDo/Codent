## Context

Three independent audit findings share one theme: a safety boundary that is enforced by a
**name** or a **string shape** rather than by what the thing can actually do.

- The command-safety analyzer (`command-analyzer.ts`) grants read-only status from a
  `READONLY_PREFIXES` set. That is a name check, so the argument decides nothing: `env`,
  `find`, `sed`, and `git log/diff/show` are read-only until their flags or script make them
  writes, and the flag set was incomplete.
- The search tools pass a caller string straight into `fd`/`rg`/`find`/`tree` with no path
  check and no `cwd`, so the boundary (the workspace root) is never consulted.
- The Node fs confinement compares normalized strings, which is lexical: the string is inside
  the root while the file it names is not.

## Goals / Non-Goals

**Goals**

- A write-capable command is never auto-approved under a read-only name.
- A tool never reads outside the workspace root, and `path:"."` means the root, not the host's
  `process.cwd()`.
- An in-root symlink cannot escape fs confinement.

**Non-Goals**

- A full shell interpreter for `sed`/`find` — the classification stays conservative (when a
  form cannot be proven read-only, it asks).
- Redesigning `ExecutionError`/`FileError`, or the approval UX.
- Sandboxing the binaries themselves (`rg`/`fd`/`find` behaviour is out of scope; the fix is
  the path we hand them and the `cwd` they run under).

## Decisions

**1. Conservative classification, not enumeration.** For `env`, read-only requires a pure
`NAME=value` list — anything else (a flag that takes an argument, or a command word) asks.
For `find`, a fixed predicate set (`-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint`,
`-fprint0`, `-fprintf`, `-fls`) marks a write. For `sed`, the script is parsed only far enough
to see a `w`/`W`/`r`/`R`/`e` command or an `s///w` flag; a pattern or replacement that merely
contains those letters stays read-only, because a false positive here costs an approval prompt
on nearly every `sed`. `git … --output`/`--output=` is a write; `--output-indicator-*` is not.

**2. Confine the path, and anchor the `cwd`.** `resolveSearchPath` resolves the caller's
`path` against `rootPath` (never `process.cwd()`) and rejects an escape with the same
`permission_denied` `FileError` the fs layer throws. The search argument is passed through
**unchanged** (so result paths stay root-relative exactly as today) and the binary runs with
`cwd = rootPath`. That is the whole fix for the "wrong tree" half: `execFile` already threads
`cwd` through node, the server route, and the remote client, so no new capability is needed.

**3. Resolve the real path, keep the lexical gate.** `native-fs` keeps the cheap lexical check
first (same error/message), then resolves the real path of the deepest **existing** ancestor
(a write target may not exist yet) and re-checks containment against the real root(s). The root
itself is realpathed once, so a workspace root that sits under a symlink (macOS `/tmp`) still
compares correctly. A dangling symlink is followed via `lstat`/`readlink`, because "a missing
tail cannot be a symlink" is false for it.

## Risks / Trade-offs

- [More approval prompts] → accepted: the affected forms are exactly the ones that were
  silently auto-approved while being able to write. Genuine read-only forms are asserted in
  the validator.
- [`realpath` per resolve adds a syscall] → accepted; correctness over the micro-cost, and the
  walk is bounded to the deepest existing ancestor.
- [Windows symlink privilege] → the symlink validator reports itself as a **skip** when a file
  symlink cannot be created (see the `validators-windows` job), the same convention the LSP
  validator uses.

## Migration Plan

1. `command-analyzer.ts` — the four classification changes + `validate:command-safety-readonly`.
2. `exec-args.ts` / `search-command.ts` / the three search tools + `validate:search-path-containment`.
3. `native-fs.ts` + `validate:fs-symlink-containment`.
4. Build / lint / typecheck / validators / app tests.

Rollback is per-step and the wire contracts are unchanged.

## Open Questions

- Should `sed`'s `r`/`R` (read-only file *reads*) count as mutating? Currently yes (conservative):
  they widen what the command reads, and the pattern does not distinguish read from write.
