import { isContentPartArray } from "@tanstack/ai";

import type { ModelToolContent } from "./contract.js";

/**
 * Is this already a model-facing projection, rather than a tool's own output?
 *
 * A `toModelOutput` is required to be a pure function of the tool's output (see
 * {@link defineServerTool}), and it is also required to be **idempotent**: a caller may hand it the
 * content it produced earlier — a compact wire re-projected after a restart, a host re-deriving a
 * transcript it received over HTTP, an extension decorator feeding a shaped result back through the
 * chain. Without this check a projection reads its own output as if it were the tool's: `matches`,
 * `tree`, `entries` are all `undefined`, which reaches the model as the literal `undefined`, and a
 * projection that dereferences them (`session_search`) throws instead of shaping.
 *
 * `ModelToolContent` covers both shapes a projection may return, so both pass through — the
 * `read_file` text branch returns a JSON string, and every other built-in returns `ContentPart[]`.
 * A tool's RAW output is never wire-shaped content (each built-in's `outputSchema` is an object), so
 * this cannot shadow a projection that still has work to do.
 *
 * Every `toModelOutput` opens with it; `validate:model-output-idempotency` drives each registered
 * projection with its own output, so one cannot be added without the check.
 */
export function isProjectedModelContent(output: unknown): output is ModelToolContent {
  return typeof output === "string" || isContentPartArray(output);
}
