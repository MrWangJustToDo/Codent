/**
 * Compare two strings by UTF-16 code unit.
 *
 * `localeCompare` is collation-dependent (ICU and locale), so the same list can order differently
 * on another machine or another ICU build. Anything whose order feeds a cacheable prefix — tool
 * schemas, prompt sections — must use this instead, or the prefix silently stops matching.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
