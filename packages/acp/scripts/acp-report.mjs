/**
 * Shared PASS/FAIL reporter for the ACP validation scripts.
 *
 * The catalog conformance run outgrew the mapping-unit script it used to live in (the 800-line
 * ceiling), so it moved to `validate-acp-catalog.mjs`. Both files need the identical reporter —
 * and, crucially, the identical "count failures, then exit non-zero" footer — so it lives here
 * rather than being copy-pasted into two scripts that would drift apart.
 *
 * Run: `pnpm --filter @codent/acp run validate:acp`
 */

/**
 * Build a checker whose `check()` prints each verdict and tallies failures.
 *
 * @returns {{ check: (label: string, cond: unknown, detail?: unknown) => void, failures: number }}
 */
export function createChecker() {
  const state = { failures: 0 };
  return {
    /**
     * @param label - What is being asserted, phrased as the fact that must hold.
     * @param cond - The verdict; anything falsy is a failure.
     * @param detail - Optional diagnostic, printed ONLY on failure — the reason (a mismatch, an issue
     *   list) is worth nothing when the check passes and is the first thing to look at when it does not.
     */
    check(label, cond, detail) {
      if (cond) {
        console.log(`PASS  ${label}`);
      } else {
        state.failures += 1;
        console.log(`FAIL  ${label}`);
        if (detail !== undefined) console.log(`      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
      }
    },
    get failures() {
      return state.failures;
    },
  };
}

/** Print the summary line and exit with a status derived from `failures`. */
export function finish(failures) {
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}
