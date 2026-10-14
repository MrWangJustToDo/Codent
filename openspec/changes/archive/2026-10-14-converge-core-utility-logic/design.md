## Context

An audit of `packages/core/src` (376 `.ts` files, ~62k lines) clustered utility code by behaviour
rather than by name. It found the duplication below, all in core:

| Family | Evidence |
|---|---|
| UTF-8 byte truncation | `agent/prompt/instruction-files.ts:188` `truncateToBudget` and `agent/memory/memory-retrieval.ts:205` `truncateBody` are the same binary search; `agent/lsp/tools/tool-shared.ts:28` approximates bytes as `length * 2` |
| Char truncation + `…` | ~20 inline `slice(0, N) + "…"` sites in `presentation/input-format.ts`, `presentation/output-format.ts`, `compaction/serialize-conversation.ts`, `lsp/tools/*`, `log/event-log-rules.ts`, `plan/plan-summary.ts`, `tools/session-read-tool.ts`, `tools/grep-tool.ts` |
| Byte-size format | `Math.round(size / 1024) + "KB"` in `tools/util/format-read-file-result.ts:23,32` and `presentation/output-format.ts:152,155`; `MB` variants in `session-read-tool.ts:125`, `read-file-tool.ts:297` |
| data-URL / base64 / MIME | 5 regexes (`media/media-store.ts:52`, `media/media-utils.ts:77,394`, `tools/webfetch-tool.ts:340`, `models/adapter/chat-completions-text-adapter.ts:51`); `media/media-utils.ts` has the same `mimeDefaults` map twice; `media/types.ts:48` already owns MIME→ext |
| Error normalization | `error instanceof Error ? error : new Error(String(error))` at ~43 sites across 48 files, including a local `errorFromUnknown` (`managers/run-stream-recovery.ts:60`) |
| Abort classification | inline `error.name === "AbortError"` in `compaction/auto-compact.ts:501`, `compaction/reactive-compact.ts:157`, `managers/middleware/compaction-middleware.ts:124`, `managers/managed-agent-compact.ts:106,236` |
| Line splitting | `presentation/lines.ts:6` (CRLF folding), `tools/util/output-accumulator.ts:50` (no CRLF folding), `tools/util/search-command.ts:71`; 30 raw `split("\n")` |
| Memory expiry | `memory/memory-manager.ts:74` and `memory/memory-extractor.ts:525` |
| Slugify | `memory/memory-manager.ts:51` (keeps CJK) and `plan/plan-store.ts:13` (ASCII only) |
| Media part set | `media/media-utils.ts:62` and `:89` list `image/audio/video/document` twice |
| Presentation entry format | `presentation/output-format.ts:383` and `presentation/input-format.ts:101` are the same entries→truncated-value shape |

Precedent and constraints:

- `path-normalization` established the durable pattern — one definition in `src/utils/` plus
  `packages/app/scripts/validate-no-inline-path-normalization.mjs`. Its header states the failure
  mode this change is about: comments are not compile errors, so the count grows back.
- `validator-ci-coverage` guarantees a new `packages/core/scripts/validate-*.mjs` runs in CI by
  discovery; a `validate:*` entry is only needed for standalone runs.
- `core-code-organization` owns naming and barrel rules: new files must state their responsibility,
  and `utils/index.ts` must NOT be added unless the directory is consumed as a unit (today it is not
  — imports are deep, e.g. `../../../utils/bytes.js`).
- `utils/` is a universal leaf layer (`bytes.ts` is deliberately importable from `env`), so it must
  not gain a runtime dependency on `agent/`, `models/`, or `provider/`.
- `run-abort-ownership` already owns the abort verdict; this change must cross-reference it rather
  than create a second home for the semantics.

## Goals / Non-Goals

- **Goals**: one definition per utility family; migrate every inline copy; add a guard per family so
  the count cannot regrow; unify genuinely inconsistent thresholds; keep the change a pure refactor
  except two intended corrections (true-byte LSP bound, unified ellipsis budgets).
- **Non-Goals**: changing public `@codent/core` exports, tool names, or schemas; changing the
  `instruction-file-resolution` byte budget (caller-supplied), the `tool-execution-portability`
  truncation boundary (line-count based), or `session-search` page ceilings; unifying things that are
  genuinely different (byte-vs-char caps, head-vs-tail semantics stay parameters); touching the
  already-single `abort.ts`, `text-decoding.ts`, `stale-file-sweep.ts`, or `formatDuration`.

## Decisions

- **D1 — Where helpers live.** Cross-cutting helpers go in `packages/core/src/utils/`, one file per
  family, deep-imported: `bytes.ts` (extended: `utf8ByteLength` + byte truncation), `text-truncation.ts`,
  `byte-size.ts`, `display-lines.ts`, `data-url.ts`, `errors.ts`, `slug.ts`. Domain-specific
  classifiers stay in their domain: memory expiry in `agent/memory/memory-expiry.ts`; media part
  membership exported from `agent/media/types.ts`. `runtime-types/abort.ts` is unchanged.
  *Alternative considered*: one barrel `utils/index.ts` — rejected by the barrel policy (the
  directory is not consumed as a unit).
- **D2 — Compatibility.** Each caller's observable output is preserved. Where thresholds are
  genuinely inconsistent (ellipsis budgets), one canonical constant wins, and the affected presenters
  and their `validate:*` assertions are updated in the same change. Where two "similar" limits are
  actually different units (`MAX_CONTENT_CHARS` vs `DEFAULT_MAX_BYTES`), they stay distinct.
- **D3 — Phasing.** Phase 1 = real duplicates (byte truncation, char truncation, byte-size, data-URL,
  error normalize, abort inline, memory expiry, media part set, `truncateHead` fix). Phase 2 =
  half-duplicates (`splitDisplayLines`, `slugifyName(policy)`, shared presentation entry formatter).
  Each phase builds and validates on its own.
- **D4 — Guards.** One `validate-*.mjs` per detectable family, mirroring
  `validate-no-inline-path-normalization.mjs`: walk `packages/core/src`, skip the single definition
  module, report `file:line`, exit non-zero. Patterns are deliberately tight (the path validator's
  comment warns that an over-broad regex gets disabled rather than fixed). Each guard gets a
  `validate:*` entry for standalone runs; CI discovery covers the rest.
- **D5 — Abort rule ownership.** The new capability forbids *re-deriving* the abort verdict; it does
  not restate the verdict. `run-abort-ownership` remains the semantics home, cross-referenced in the
  requirement text.

## Risks / Trade-offs

- **Guard false positives** (e.g. `slice(0, N) + "..."` is a common shape) → tight patterns, an
  explicit definition allowlist, and a per-guard reason; if a pattern proves noisy it is narrowed,
  not blanket-disabled.
- **Behavior drift from threshold unification** → enumerate every affected presenter up front,
  update its `validate:*` assertion, and diff tool-output fixtures before/after.
- **Layer cycle from a misplaced helper** (data-URL parsing needing media types) → the generic parser
  lives in `utils/` with no `agent/` import; media-specific membership stays in `media/`.
- **Blast radius (~80 sites)** → phase it; each phase compiles, typechecks, and runs the affected
  validators; no behavior change in Phase 1 except the two intended corrections.
- **Naming rule pressure** (`text-truncation.ts` must not read as a generic placeholder) → names
  state the responsibility; reviewed against `core-code-organization`.

## Migration Plan

1. Phase 1 modules + migrations; build + affected validators.
2. Phase 2 modules + migrations; build + affected validators.
3. Add guards + `validate:*` entries; run the full core validator suite.
4. Update `AGENTS.md`; confirm every documented path resolves.
5. Full `pnpm build:core`, `pnpm typecheck`, `pnpm lint`, `pnpm --filter @codent/app test`.

Rollback is a plain revert — no data, schema, or public-API change is involved.

## Open Questions

- Confirm the canonical ellipsis reservation (for example reserve 3 chars so a 60-char display becomes
  `slice(0, 57)`) is acceptable for the `tool-presentation` row text; it changes a few UI strings by
  a small number of characters.
- Confirm whether `toError` belongs in `utils/errors.ts` or beside `runtime-types/abort.ts`; both are
  leaf modules, so this is a naming/locality choice, not a layering one.
