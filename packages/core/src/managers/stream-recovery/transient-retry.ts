/**
 * Detect transient provider / transport errors that should be retried with backoff
 * (same messages). Distinct from transform retries (reactive compact, multimodal strip).
 */

function errorText(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    const extra = typeof code === "string" ? ` ${code}` : "";
    return `${error.name} ${error.message}${extra}`;
  }
  if (typeof error === "object") {
    const record = error as { message?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
    return [record.message, record.code, record.status, record.statusCode].filter(Boolean).join(" ");
  }
  return String(error);
}

function errorStatus(error: unknown): number | undefined {
  if (error == null || typeof error !== "object") return undefined;
  const record = error as { status?: unknown; statusCode?: unknown };
  const raw = record.status ?? record.statusCode;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Billing / permanent quota — do not retry as rate-limit. */
function isNonRetryableQuota(text: string): boolean {
  return /insufficient[_\s-]?quota|billing|payment required|credit(s)? (exhausted|depleted)/i.test(text);
}

/**
 * Network-transport sentinels, matched against the flattened `name message` text.
 *
 * The list is kept here rather than inline because the reason it carries
 * `connection error` is not obvious. That string is the OpenAI SDK's **generic**
 * `APIConnectionError` message (`openai/core/error.mjs`: `super(undefined, undefined,
 * message || 'Connection error.')`) — it is what the SDK reports when the request
 * never got a response at all, and it is deliberately uninformative: the cause of the
 * connection failure lives on `error.cause`.
 *
 * That cause chain never reaches this function. TanStack's `toRunErrorPayload()`
 * (`@tanstack/ai` `activities/error-payload.js`) converts a thrown SDK error into a
 * `RUN_ERROR` event carrying only `{ message, code }` — its docstring names the reason:
 * "Never leaks the full error object (which may carry request/response state from an
 * SDK)". So by the time recovery sees the failure, `cause` is gone and `message` is
 * the bare sentinel; walking `cause` here would find nothing. Measured: a run against an
 * unreachable port yields `{ message: 'Connection error.', code: 'undefined' }` with no
 * `cause` property at all.
 *
 * Without `connection error` in this list such a failure matched **no** branch, so
 * `isTransientRetryableError` returned false and the run died on the spot instead of
 * retrying — the recovery loop never ran (0 `agent:retry` events in a 9,571-line log
 * covering two such failures, one of which had already burned 932s).
 *
 * `code` is not usable as a signal either: `extractCode()` only reads a string `code` or a
 * numeric `status`, so this path stringifies `undefined` into the literal `"undefined"`.
 *
 * Deliberately absent: the bare word `error` (would match `invalid api key`) and
 * provider `5xx` phrases that do not name a specific transient status (`internal server
 * error` is a legitimate permanent rejection from some gateways, and `isNonRetryableQuota`
 * already guards the billing cases).
 */
const NETWORK_FAILURE_PATTERN =
  /connection error|econnreset|econnrefused|etimedout|enotfound|eai_again|ehostunreach|enetunreach|epipe|socket hang up|network error|fetch failed|other side closed|terminated/i;

/**
 * Whether the failure is likely transient (429 / overload / gateway / network).
 * Used by {@link runStreamWithRecovery} before giving up.
 */
export function isTransientRetryableError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;

  const text = errorText(error);
  if (!text.trim()) return false;
  if (isNonRetryableQuota(text)) return false;

  if (/\b429\b|rate[_\s-]?limit|too many requests|overloaded|server_busy/i.test(text)) return true;
  if (/\b503\b|service unavailable|\b502\b|bad gateway|\b504\b|gateway timeout/i.test(text)) return true;
  return NETWORK_FAILURE_PATTERN.test(text);
}

/**
 * Provider-normalized retry hint in **milliseconds**, straight from the SDK.
 *
 * `@tanstack/ai` 0.67+ sets `retryAfterMs` on a `RUN_ERROR` (mirrored to
 * `metadata.tanstack.retryAfterMs`), resolving the `retry-after-ms` header first
 * then `retry-after` in seconds or as an HTTP date. Prefer this over
 * {@link extractRetryAfterSeconds}'s own header/message scraping: it is the same
 * value the adapter already normalized, and it lives on the chunk we are holding.
 */
export function extractRetryAfterMs(source: unknown): number | undefined {
  if (source == null || typeof source !== "object") return undefined;
  const record = source as {
    retryAfterMs?: unknown;
    metadata?: { tanstack?: { retryAfterMs?: unknown } };
  };
  const direct = record.retryAfterMs;
  if (typeof direct === "number" && direct > 0) return direct;
  const nested = record.metadata?.tanstack?.retryAfterMs;
  if (typeof nested === "number" && nested > 0) return nested;
  return undefined;
}

/**
 * Best-effort Retry-After seconds from SDK errors or message text.
 */
export function extractRetryAfterSeconds(error: unknown): number | undefined {
  if (error != null && typeof error === "object") {
    const record = error as {
      headers?: { get?: (name: string) => string | null; "retry-after"?: string };
      retryAfter?: unknown;
    };
    if (typeof record.retryAfter === "number" && record.retryAfter > 0) {
      return record.retryAfter;
    }
    const header =
      record.headers?.get?.("retry-after") ?? record.headers?.get?.("Retry-After") ?? record.headers?.["retry-after"];
    if (header) {
      const asInt = Number(header);
      if (Number.isFinite(asInt) && asInt > 0) return asInt;
    }
  }

  const text = errorText(error);
  const match = text.match(/retry[- ]after[:\s]+(\d+)/i);
  if (match) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}
