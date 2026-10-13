## 1. Command read-only classification

- [x] 1.1 Remove `env` / `find` from `READONLY_PREFIXES`; classify `env` read-only only for a pure `NAME=value` assignment list
- [x] 1.2 Classify `find` as non-read-only when it carries a write/exec predicate (`-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint`, `-fprint0`, `-fprintf`, `-fls`)
- [x] 1.3 Extend the `sed` probe to a write/exec script command (`w` / `W` / `r` / `R` / `e`), keeping ordinary patterns and replacements read-only
- [x] 1.4 Reject `git … --output` / `--output=<file>` from the read-only set (`--output-indicator-*` excluded)
- [x] 1.5 Add `validate:command-safety-readonly` (assert the write forms are not read-only and the genuine read-only forms still are)

## 2. Workspace containment

- [x] 2.1 `execArgs` / `execArgsCapture` accept `{ timeout, cwd }` and forward `cwd` to `env.execFile` (already threaded end-to-end by node / server / remote client)
- [x] 2.2 Shared `resolveSearchPath` resolves against `rootPath` and rejects escapes (canonical forward-slash comparison)
- [x] 2.3 `glob` / `grep` / `tree` validate the `path` input and pass `cwd: rootPath`
- [x] 2.4 `native-fs` confinement resolves the real path (deepest existing ancestor) and re-checks against the real root
- [x] 2.5 Add `validate:search-path-containment` and `validate:fs-symlink-containment`

## 3. Verification

- [x] 3.1 `pnpm build` / `pnpm lint` / `pnpm typecheck` clean
- [x] 3.2 `@codent/core` and `@codent/node` validator suites green; `@codent/app` tests green; render smoke green
- [x] 3.3 `openspec validate harden-tool-safety-boundaries --strict`
