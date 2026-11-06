/**
 * Redaction at the log seam.
 *
 * Logs retain 14 days and users paste them into issues. Tool inputs, provider error bodies and
 * `extension:log` strings are arbitrary text, so a key/token can reach disk unless the one builder
 * every writer passes through masks it. Patterns are deliberately conservative: a false positive
 * costs a few characters, a false negative leaks a credential.
 */

import { truncateText } from "../../utils/text-truncation.js";

const STRING_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Private keys first: they span lines and would otherwise be partly consumed by later rules.
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
    "[redacted private key]",
  ],
  // A tool-input preview is truncated, so an END marker is often cut off — redact the rest.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*/g, "[redacted private key]"],
  // Authorization: Bearer xxx / x-api-key: xxx / api_key=xxx. `["']?` after the key covers JSON
  // (`{"api_key":"…"}`), whose quote used to sit between the key and the `:` and defeat the rule.
  [/(authorization["']?\s*[:=]\s*)["']?(?:bearer\s+)?[^\s"',;}]+/gi, "$1[redacted]"],
  [/(x-api-key["']?\s*[:=]\s*)["']?[^\s"',;}]+/gi, "$1[redacted]"],
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd)["']?\s*[:=]\s*)["']?[^\s"',;}]+/gi,
    "$1[redacted]",
  ],
  // Env-style keys: AWS_SECRET_ACCESS_KEY=…, GITHUB_TOKEN=…, DEPLOY_KEY=… (the generic rule above
  // requires the keyword to be followed immediately by `:`/`=`, which `_` breaks).
  [
    /(\b[A-Za-z0-9_]*(?:_KEY|_TOKEN|_SECRET|_SECRET_ACCESS_KEY|_PASSWORD|_PASS|_PWD)\s*["']?\s*[:=]\s*)["']?[^\s"',;}]+/gi,
    "$1[redacted]",
  ],
  // Well-known token shapes even without a key name.
  [
    /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|glpat-[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{8,})\b/g,
    "[redacted]",
  ],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]"],
  // JWT (three base64url segments) and credentials embedded in a URL.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  // Bounded scheme length: `[a-z0-9+.-]*` before a literal `://` backtracks quadratically on a
  // long scheme-like token, and this runs on raw (pre-truncation) tool output.
  [/(\b[a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@"],
  // Query-string credentials.
  [/([?&](?:api[_-]?key|access_token|refresh_token|token|key)=)[^&\s]+/gi, "$1[redacted]"],
];

const SENSITIVE_KEY =
  /^(?:authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd)$/i;
const SENSITIVE_KEY_SUFFIX =
  /(?:^|_)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|secret_access_key|password|passwd|pwd)$/i;

/** Mask credentials in free text. Idempotent (a redacted value no longer matches). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of STRING_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || SENSITIVE_KEY_SUFFIX.test(key);
}

const MAX_LOG_DATA_DEPTH = 8;
const MAX_LOG_DATA_ARRAY = 50;
const MAX_LOG_DATA_KEYS = 50;
const MAX_LOG_DATA_STRING = 4_000;
const MAX_LOG_DATA_CHARS = 64_000;

interface LogDataBudget {
  remaining: number;
}

/**
 * Redact strings recursively in log `data`.
 *
 * Objects keep their shape (a reader can see that a field existed) but a sensitive key's value is
 * replaced wholesale. Depth, array length, key count and total characters are all bounded: `data`
 * is not routed through the bridge's `summarizePayload`, so a specialized handler (or a host's
 * direct write) could otherwise persist an arbitrarily large JSONL line.
 */
export function redactLogValue(
  value: unknown,
  depth = 0,
  ancestors = new WeakSet<object>(),
  budget: LogDataBudget = { remaining: MAX_LOG_DATA_CHARS }
): unknown {
  if (depth > MAX_LOG_DATA_DEPTH) return "[redacted-depth]";
  if (budget.remaining <= 0) return "[redacted-budget]";
  if (typeof value === "string") {
    const text = truncateText(redactSecrets(value), MAX_LOG_DATA_STRING);
    budget.remaining -= text.length;
    return text;
  }
  // `ancestors` is the CURRENT path, not every object ever seen. A true cycle is returned as-is so
  // the serializer still rejects the whole entry (the documented contract: an unserializable value
  // is dropped, never written as a placeholder). A DAG — the same object referenced twice on
  // sibling branches — is NOT a cycle, so it is walked again and redacted at both occurrences
  // instead of the second one leaking because the first put it in a global `seen` set.
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return value;
    ancestors.add(value);
    const kept = value.slice(0, MAX_LOG_DATA_ARRAY);
    const out = kept.map((item) => redactLogValue(item, depth + 1, ancestors, budget));
    if (value.length > MAX_LOG_DATA_ARRAY) {
      out.push(`[... ${value.length - MAX_LOG_DATA_ARRAY} items omitted]`);
    }
    ancestors.delete(value);
    return out;
  }
  if (value && typeof value === "object") {
    if (ancestors.has(value)) return value;
    ancestors.add(value);
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, item] of entries.slice(0, MAX_LOG_DATA_KEYS)) {
      out[key] = isSensitiveKey(key) ? "[redacted]" : redactLogValue(item, depth + 1, ancestors, budget);
    }
    if (entries.length > MAX_LOG_DATA_KEYS) {
      out.__omittedKeys = entries.length - MAX_LOG_DATA_KEYS;
    }
    ancestors.delete(value);
    return out;
  }
  return value;
}
