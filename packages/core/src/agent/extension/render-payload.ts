/**
 * Extension render-payload normalization.
 *
 * A payload crosses a process boundary (core → host, including remote servers)
 * and is also replayed to late subscribers, so every publish is normalized here
 * into a canonical shape: renderable, kind-checked at the root, and **proven
 * JSON-serializable**. Anything that cannot survive JSON round-tripping is
 * rejected at publish time rather than throwing later on the session / server
 * JSON paths.
 */

import type { ExtensionRenderPayload } from "./types.js";

/** Node types the generic host renderer understands — a closed set. */
const RENDER_NODE_TYPES = new Set(["text", "row", "column", "box"]);

/** Slot identity: `surface` + NUL + `key` (NUL cannot appear in either part). */
export const slotId = (surface: string, key: string): string => `${surface}\u0000${key}`;

/** Normalized result for a publish: `value === null` means "remove the slot". */
export interface NormalizedPayload {
  value: ExtensionRenderPayload | null;
  /** Canonical serialized form, reused as the dedupe fingerprint. */
  fingerprint: string;
}

/** Canonical payload for "no slot" (also the fingerprint of an absent slot). */
const EMPTY_PAYLOAD: NormalizedPayload = { value: null, fingerprint: "null" };

/**
 * JSON probe. Rejects values JSON would silently drop (functions, symbols) or
 * that break serialization outright (circular references, BigInt).
 */
function serializePayload(payload: ExtensionRenderPayload): string {
  return JSON.stringify(payload, (_key, value: unknown) => {
    const type = typeof value;
    if (type === "function" || type === "symbol" || type === "bigint") {
      throw new TypeError(`non-serializable ${type} in extension render payload`);
    }
    return value;
  });
}

/** Fingerprint of a retained payload; an absent/unserializable slot reads as empty. */
export function fingerprintOf(payload: ExtensionRenderPayload | null): string {
  if (payload === null) return "null";
  try {
    return serializePayload(payload);
  } catch {
    return "null";
  }
}

/** Cheap root check: reject payloads that are not plain, renderable data. */
function isRenderable(payload: unknown): payload is ExtensionRenderPayload {
  if (typeof payload === "string") return true;
  if (typeof payload !== "object" || payload === null) return false;
  const type = (payload as { type?: unknown }).type;
  return typeof type === "string" && RENDER_NODE_TYPES.has(type);
}

/**
 * Normalize a published payload.
 *
 * `null`/`undefined` and a whitespace-only string mean "remove the slot". Anything else that is not a
 * renderable node, or that cannot survive JSON serialization, is a BUG in the publisher and is
 * thrown so `ctx.ui.render` can report it (`agent:extension-error`). Folding those into "remove"
 * made a malformed publish indistinguishable from a deliberate clear, and the publisher's report
 * path was unreachable because this function never threw.
 */
export function normalizePayload(payload: unknown): NormalizedPayload {
  // `undefined` and `null` are both the common "nothing to show" value (a JS extension passing an
  // optional line), not a publisher bug: keep treating them as "remove the slot".
  if (payload === null || payload === undefined) return EMPTY_PAYLOAD;
  if (typeof payload === "string") {
    return payload.trim() === "" ? EMPTY_PAYLOAD : { value: payload, fingerprint: serializePayload(payload) };
  }
  if (!isRenderable(payload)) {
    throw new TypeError("extension render payload is not a renderable text/row/column/box value");
  }
  return { value: payload, fingerprint: serializePayload(payload) };
}
