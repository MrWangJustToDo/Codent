/**
 * Redaction at the log seam.
 *
 * Logs retain 14 days and users paste them into issues. Tool inputs, provider error bodies and
 * `extension:log` strings are arbitrary text, so a key/token can reach disk unless the one builder
 * every writer passes through masks it. Patterns are deliberately conservative: a false positive
 * costs a few characters, a false negative leaks a credential.
 */

const STRING_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Authorization: Bearer xxx / x-api-key: xxx / api_key=xxx (quoted or bare)
  [/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s"',;}]+/gi, "$1[redacted]"],
  [/(x-api-key\s*[:=]\s*)[^\s"',;}]+/gi, "$1[redacted]"],
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd)\s*[:=]\s*)["']?[^\s"',;}]+/gi,
    "$1[redacted]",
  ],
  // Well-known token shapes even without a key name.
  [/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "[redacted]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]"],
  // Query-string credentials.
  [/([?&](?:api[_-]?key|access_token|refresh_token|token|key)=)[^&\s]+/gi, "$1[redacted]"],
];

const SENSITIVE_KEY =
  /^(?:authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd)$/i;
const SENSITIVE_KEY_SUFFIX = /(?:^|_)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd)$/i;

/** Mask credentials in free text. Idempotent (a redacted value no longer matches). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of STRING_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || SENSITIVE_KEY_SUFFIX.test(key);
}

/**
 * Redact strings recursively in log `data`.
 *
 * Objects keep their shape (a reader can see that a field existed) but a sensitive key's value is
 * replaced wholesale. Depth is bounded so a cyclic/huge payload cannot turn logging into a walk.
 */
export function redactLogValue(value: unknown, depth = 0, ancestors = new WeakSet<object>()): unknown {
  if (depth > 8) return "[redacted-depth]";
  if (typeof value === "string") return redactSecrets(value);
  // `ancestors` is the CURRENT path, not every object ever seen. A true cycle is returned as-is so
  // the serializer still rejects the whole entry (the documented contract: an unserializable value
  // is dropped, never written as a placeholder). A DAG — the same object referenced twice on
  // sibling branches — is NOT a cycle, so it is walked again and redacted at both occurrences
  // instead of the second one leaking because the first put it in a global `seen` set.
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return value;
    ancestors.add(value);
    const out = value.map((item) => redactLogValue(item, depth + 1, ancestors));
    ancestors.delete(value);
    return out;
  }
  if (value && typeof value === "object") {
    if (ancestors.has(value)) return value;
    ancestors.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? "[redacted]" : redactLogValue(item, depth + 1, ancestors);
    }
    ancestors.delete(value);
    return out;
  }
  return value;
}
