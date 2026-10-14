/**
 * Fail when a module normalizes an unknown error or classifies an abort by hand instead of calling
 * `toError` / `errorMessage` (`packages/core/src/utils/errors.ts`) and `isAbortError`
 * (`packages/core/src/runtime-types/abort.ts`).
 *
 * The error ternary was spelled at ~40 sites; the abort name check is the heuristic `isAbortError`
 * exists to replace.
 */

import { runGuard } from "./helpers/source-guard.mjs";

runGuard({
  name: "validate-no-inline-error-normalize",
  definitionFiles: ["utils/errors.ts", "runtime-types/abort.ts"],
  patterns: [
    { re: /instanceof Error \?[^;\n]*: new Error\(String\(/, reason: "manual error normalization" },
    { re: /instanceof Error \?[^;\n]*\.message : String\(/, reason: "manual error message extraction" },
    { re: /name === "AbortError"/, reason: "inline abort classification" },
  ],
  note: "Call toError / errorMessage / isAbortError from @codent/core.",
});
