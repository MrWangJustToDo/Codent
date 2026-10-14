/**
 * Fail when a module converts bytes to a display size by hand instead of calling `formatByteSize`
 * (`packages/core/src/utils/byte-size.ts`).
 *
 * `Math.round(size / 1024) + "KB"` and its megabytes variant were each rewritten per caller.
 */

import { runGuard } from "./helpers/source-guard.mjs";

runGuard({
  name: "validate-no-inline-byte-size",
  definitionFiles: ["utils/byte-size.ts"],
  patterns: [{ re: /Math\.round\([^)]*\/\s*1024/, reason: "manual KB/MB conversion" }],
  note: "Call formatByteSize from @codent/core (packages/core/src/utils/byte-size.ts).",
});
