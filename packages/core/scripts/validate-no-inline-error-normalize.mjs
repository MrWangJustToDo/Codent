/**
 * Fail when a module normalizes an unknown error or classifies an abort by hand instead of calling
 * `toError` / `errorMessage` (`packages/core/src/utils/errors.ts`) and `isAbortError`
 * (`packages/core/src/runtime-types/abort.ts`).
 *
 * The error ternary was spelled at ~40 sites; the abort name check is the heuristic `isAbortError`
 * exists to replace.
 *
 * Core is checked against the allowlisted definition modules. The same two error spellings are
 * then checked in EVERY package: the helpers are on the public entry (`@codent/core`), so a host
 * has no reason to re-derive them — and until this pass existed the rule was unenforceable there
 * (the definition was not exported, and the guard only walked `packages/core/src`).
 */

import { runGuard, scanPackages } from "./helpers/source-guard.mjs";

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

const hostOffenders = scanPackages({
  definitionFiles: ["packages/core/src/utils/errors.ts"],
  patterns: [
    { re: /\b\w+ instanceof Error \?\s*\w+ : new Error\(String\(\w+\)\)/, reason: "manual error normalization" },
    { re: /\b\w+ instanceof Error \?\s*\w+\.message : String\(\w+\)/, reason: "manual error message extraction" },
  ],
});

if (hostOffenders.length > 0) {
  process.stderr.write("validate-no-inline-error-normalize: hosts must use the @codent/core helpers:\n");
  for (const offender of hostOffenders) {
    process.stderr.write(`  ${offender.rel}:${offender.line}  (${offender.reason})\n      ${offender.text}\n`);
  }
  process.exit(1);
}

console.log("validate-no-inline-error-normalize: hosts ok (0 inline duplicates)");
