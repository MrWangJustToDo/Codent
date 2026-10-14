## Why

`@codent/core` has ~12 families of cross-cutting utility logic that were each re-derived instead of
shared. The audit found: two near-identical UTF-8 binary-search truncators plus a `length * 2`
byte approximation that contradicts the "one byte-length definition" rule; ~20 inline
`slice(0, N) + "..."` copies with inconsistent ellipsis budgets; six hand-written `KB`/`MB`
formatters; five `data:` URL regexes and three MIME maps (two in the same file); ~43 copies of the
unknown-error ternary; five inline `name === "AbortError"` checks beside a predicate whose one home
explicitly warns against exactly that; three near-identical line splitters plus 30 raw `split("\n")`
calls; and duplicated memory-expiry, slugify, and media part-type definitions.

The repository already proved the durable fix for this shape: one definition plus a `validate-*.mjs`
guard wired into CI (`path-normalization`, guarded by `validate-no-inline-path-normalization.mjs`).
Comments and one-time cleanups did not hold — a validator did. This change applies that pattern to
every duplicated family.

## What Changes

- Introduce **one shared definition per cross-cutting utility family** under
  `packages/core/src/utils/` (or the owning domain for domain-specific classifiers): byte
  length + byte-bounded truncation, character truncation with an omission marker, human-readable
  byte sizes, display line splitting, data-URL/MIME parsing, unknown-error normalization, abort
  classification, memory expiry, name slugification, binary media part membership, and shared
  entry-truncation for presentation formatting.
- Migrate every inline re-derivation to the shared definition (Phase 1: real duplicates; Phase 2:
  half-duplicates whose callers keep their own parameters).
- Fix the one approximation that contradicts an existing rule: `truncateHead`'s `length * 2` byte
  estimate becomes true UTF-8 accounting.
- Unify genuinely inconsistent thresholds to a single constant (ellipsis budgets such as `57` vs
  `60` and `117` vs `120`). Note: `OUTPUT_LIMITS.MAX_CONTENT_CHARS` (characters) and
  `OutputAccumulator.DEFAULT_MAX_BYTES` (bytes) are **not** a duplicate and stay distinct.
- Add a `validate-*.mjs` guard per shared rule that fails on a re-derived inline copy, plus a
  `validate:*` npm entry, so CI's glob discovers them.
- **No public `@codent/core` export changes** and **no dependency changes** — helpers stay internal.

## Capabilities

### New Capabilities

- `core-shared-helpers`: single-definition rules for core's cross-cutting utility logic (text and
  byte truncation, byte-size formatting, display line splitting, data-URL/MIME parsing, error and
  abort classification, memory expiry, slugify composition, media part membership, presentation
  entry formatting), where the shared helpers live, and the guards that fail on inline re-derivation.

### Modified Capabilities

None — no existing requirement's behavior changes. Existing contracts (`instruction-file-resolution`
byte budget, `tool-execution-portability` in-process truncation boundary, `run-abort-ownership`
abort verdict, `tool-presentation` payload, `session-search` ceilings) are preserved; this change
only adds the rule that their shared mechanics have one definition. The abort rule stays owned by
`run-abort-ownership` and is cross-referenced, not restated.

## Impact

- **packages/core/src/utils/**: new/extended shared helper modules (`bytes.ts`,
  `text-truncation.ts`, `byte-size.ts`, `display-lines.ts`, `data-url.ts`, `errors.ts`, `slug.ts`);
  deep-imported, no `index.ts` barrel.
- **Consumers (~80 sites)**: `agent/tools/util/*`, `agent/tools/presentation/*`, `agent/media/*`,
  `agent/memory/*`, `agent/plan/*`, `agent/compaction/*`, `agent/prompt/*`,
  `agent/lsp/tools/tool-shared.ts`, `models/adapter/*`, `managers/*`.
- **Scripts**: new `packages/core/scripts/validate-*.mjs` guards + `validate:*` entries in
  `packages/core/package.json`.
- **Docs**: `AGENTS.md` core naming/structure sections updated for the new modules; every documented
  path must resolve (`core-code-organization`).
- **Behavior**: observable output preserved except the two intended corrections (true-byte LSP bound;
  unified ellipsis budgets).
