/**
 * Narrow a value to a plain record (not `null`, not an array).
 *
 * One definition: media repair and the code-mode output projection both walk untrusted JSON with
 * the same test, and two copies with different clause order is how one starts accepting arrays.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
