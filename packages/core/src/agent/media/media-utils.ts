/**
 * Media utilities — dehydrate/hydrate UIMessage content parts for session persistence.
 *
 * **Dehydrate** (save): extract base64 data from ImagePart/AudioPart/VideoPart/DocumentPart
 * `source.value`, store as content-addressed files via {@link MediaStore}, and replace
 * `source.value` with a `media://<hash>` reference.
 *
 * **Hydrate** (load): reverse the process — read the file back and reconstruct the
 * original `source.value` (data URL or raw base64, matching the original shape).
 *
 * ## Rules
 * 1. **Always clone first** — never mutate the original UIMessage[] in place.
 * 2. **Both source types** — `source.type: "url"` (data URL prefix) and
 *    `source.type: "data"` (raw base64) are handled.
 * 3. **Scope** — ImagePart/AudioPart/VideoPart/DocumentPart `source.value`, plus
 *    binary parts nested inside stringified tool results (`tool-result.content`
 *    is the JSON text of a `ContentPart[]` — see "Stringified tool results").
 * 4. **Inline runtime values** — parts without `metadata.mediaRef` that still
 *    carry a data URL / raw base64 (or `media://` path) are left or resolved
 *    as appropriate; dehydrated sessions always carry `mediaRef`.
 *
 * ## Stringified tool results
 *
 * TanStack's `normalize-stream-chunk` turns `TOOL_CALL_END.result` into
 * `TOOL_CALL_RESULT.content` with `JSON.stringify` whenever the result is an
 * array, so a multimodal tool result is persisted as the JSON text of a
 * `ContentPart[]` (base64 inline) — a plain string, invisible to the part-scoped
 * walk above. Rewriting those nested `source.value`s too keeps the base64 out of
 * the session file (a single screenshot is ~100 KB, a read_file image >1 MB).
 */

import { isBase64Source, parseDataUrl } from "../../utils/data-url.js";

import { MediaStore } from "./media-store.js";
import {
  parseStringifiedMultimodalContent,
  repairStringifiedMultimodalUIMessages,
} from "./repair-stringified-multimodal.js";
import {
  buildMediaRefPath,
  defaultMimeForPartType,
  extensionToMime,
  isBinaryMediaPartType,
  isMediaHash,
  isMediaRefValue,
  parseMediaRefPath,
} from "./types.js";

import type { MediaRef } from "./types.js";
import type { ResolvedCoreEnv } from "../../env";
import type { AudioPart, DocumentPart, ImagePart, UIMessage, VideoPart } from "@tanstack/ai";

// ============================================================================
// Session media metadata (extends TanStack part metadata)
// ============================================================================

/** Metadata fields we read/write on binary media parts during session persist. */
export interface SessionMediaMetadata {
  mediaType?: string;
  filename?: string;
  imageIndex?: number;
  mediaRef?: MediaRef;
}

type BinaryMediaPart =
  | ImagePart<SessionMediaMetadata>
  | AudioPart<SessionMediaMetadata>
  | VideoPart<SessionMediaMetadata>
  | DocumentPart<SessionMediaMetadata>;

function isBinaryMediaPart(part: UIMessage["parts"][number]): part is BinaryMediaPart {
  return isBinaryMediaPartType(part.type);
}

function ensureMetadata(part: BinaryMediaPart): SessionMediaMetadata {
  if (part.metadata == null || typeof part.metadata !== "object") {
    part.metadata = {};
  }
  return part.metadata;
}

// ============================================================================
// Stringified tool results (tool-result.content)
// ============================================================================

interface NestedMediaPart {
  type?: string;
  source?: { type?: string; value?: string; mimeType?: string };
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Parts of `tool-result.content` when it is the JSON text of a `ContentPart[]`.
 * Returns `null` for plain-text results so callers can leave them untouched.
 */
function parseToolResultParts(content: unknown): NestedMediaPart[] | null {
  if (typeof content !== "string") return null;
  return parseStringifiedMultimodalContent(content) as NestedMediaPart[] | null;
}

/** Rewrite one nested binary part, returning whether anything changed. */
async function mapNestedMediaPart(
  part: NestedMediaPart,
  rewrite: (source: NonNullable<NestedMediaPart["source"]>, metadata: Record<string, unknown>) => Promise<boolean>
): Promise<boolean> {
  if (typeof part.type !== "string" || !isBinaryMediaPartType(part.type)) return false;
  const source = part.source;
  if (!source || typeof source.value !== "string" || source.value.length === 0) return false;

  const metadata = part.metadata != null && typeof part.metadata === "object" ? part.metadata : {};
  const changed = await rewrite(source, metadata);
  if (changed) {
    // Keep the JSON shape stable across dehydrate/hydrate: drop the container
    // again when the rewrite removed the last key (hydrate clears mediaRef).
    if (Object.keys(metadata).length > 0) part.metadata = metadata;
    else delete part.metadata;
  }
  return changed;
}

/**
 * Binary media carried directly on a `tool-call.output`.
 *
 * Tools such as `read_file` (image / PDF) and `webfetch` (image) return the bytes in their
 * structured output, and TanStack keeps that object on the `tool-call` part. `dehydrateUIMessages`
 * used to walk only `tool-result.content`, so every screenshot was persisted a second time as raw
 * base64 on the call — a 388 KB image in one real session — and the media store's retention never
 * saw it. The wire still needs the bytes, so this stores them and leaves a reference that
 * {@link hydrateToolCallOutput} restores on load.
 */
interface ToolCallOutputRecord {
  type?: string;
  base64?: string;
  mimeType?: string;
  contentType?: string;
  content?: string;
  isImage?: boolean;
  mediaRef?: MediaRef;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is ToolCallOutputRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mimeForToolCallOutput(output: ToolCallOutputRecord): string {
  if (typeof output.mimeType === "string" && output.mimeType.length > 0) return output.mimeType;
  // `webfetch` reports the response header, not `mimeType` (`image/png; charset=…`).
  if (typeof output.contentType === "string") {
    const mime = output.contentType.split(";")[0]?.trim().toLowerCase();
    if (mime) return mime;
  }
  if (output.type === "pdf") return "application/pdf";
  if (output.type === "image") return "image/png";
  return "application/octet-stream";
}

async function dehydrateToolCallOutput(output: unknown, store: MediaStore): Promise<unknown> {
  if (!isRecord(output)) return output;

  // `read_file` image / PDF: raw base64 in `base64`. Shape-check the media type too — a generic
  // extension output may carry a field named `base64` (a signature or id) that only looks like
  // base64, and moving it into the media store would rewrite its shape and normalize its bytes.
  const base64Mime = mimeForToolCallOutput(output);
  const mediaLike =
    output.type === "image" ||
    output.type === "pdf" ||
    base64Mime.startsWith("image/") ||
    base64Mime === "application/pdf";
  if (mediaLike && typeof output.base64 === "string" && isBase64Source(output.base64)) {
    const ref = await store.save(output.base64, base64Mime, undefined, "data");
    output.base64 = buildMediaRefPath(ref);
    output.mediaRef = {
      hash: ref.hash,
      mimeType: ref.mimeType,
      filename: ref.filename,
      size: ref.size,
      sourceType: ref.sourceType,
    };
    return output;
  }

  // `webfetch` image: the bytes are a data URL in `content`.
  if (output.isImage === true && typeof output.content === "string" && isBase64Source(output.content)) {
    // The data URL's own media type is authoritative for the round-trip: hydration rebuilds
    // `data:<mime>;base64,…` from the stored ref, so a mismatch would rewrite the header.
    const mime = parseDataUrl(output.content)?.mimeType || mimeForToolCallOutput(output);
    const ref = await store.save(output.content, mime, undefined, "url");
    output.content = buildMediaRefPath(ref);
    output.mediaRef = {
      hash: ref.hash,
      mimeType: ref.mimeType,
      filename: ref.filename,
      size: ref.size,
      sourceType: ref.sourceType,
    };
  }
  return output;
}

async function hydrateToolCallOutput(
  output: unknown,
  store: MediaStore,
  onMissing?: (miss: MediaHydrationMiss) => void
): Promise<unknown> {
  if (!isRecord(output) || !output.mediaRef) return output;
  if (!isMediaHash(output.mediaRef.hash)) {
    // A malformed ref must be REPORTED, not silently left as `media://bad`: the miss counter drives
    // the wire-recovery substitution, and without it the provider receives an unfetchable value on
    // every request (the exact failure the substitution exists to prevent). Mirrors the binary-part
    // path's `invalid-ref`.
    onMissing?.({ ref: buildMediaRefPath(output.mediaRef), reason: "invalid-ref", path: "tool-call" });
    return output;
  }

  // The owner is whoever still carries a `media://` value. A further hydrate on an already
  // hydrated output (base64 back in place) is a no-op, not a miss.
  const owner =
    typeof output.base64 === "string" && isMediaRefValue(output.base64)
      ? "base64"
      : typeof output.content === "string" && isMediaRefValue(output.content)
        ? "content"
        : null;
  if (!owner) return output;

  const ref = output.mediaRef;
  const loaded = await store.tryLoad(ref);
  if (!loaded) {
    onMissing?.({ ref: buildMediaRefPath(ref), reason: "not-found", path: "tool-call" });
    return output;
  }

  if (owner === "base64") output.base64 = loaded;
  else output.content = loaded;
  delete output.mediaRef;
  return output;
}

/**
 * Dehydrate binary parts nested in a stringified tool result. Leaves the field as
 * a string (the wire path revives it via `toModelOutput`), only shrinking the
 * embedded `source.value`s to `media://` references.
 */
async function dehydrateToolResultContent(content: unknown, store: MediaStore): Promise<string> {
  const parts = parseToolResultParts(content);
  if (!parts) return content as string;

  let changed = false;
  for (const part of parts) {
    const partType = part.type ?? "image";
    const didChange = await mapNestedMediaPart(part, async (source, metadata) => {
      const value = source.value as string;
      if (!isBase64Source(value)) return false;

      const mimeType = source.mimeType ?? guessMimeType(value, partType);
      const filename = typeof metadata.filename === "string" ? metadata.filename : undefined;
      const ref = await store.save(value, mimeType, filename, source.type === "data" ? "data" : "url");

      source.value = buildMediaRefPath(ref);
      metadata.mediaRef = {
        hash: ref.hash,
        mimeType: ref.mimeType,
        filename: ref.filename,
        size: ref.size,
        sourceType: ref.sourceType,
      };
      return true;
    });
    changed = changed || didChange;
  }

  return changed ? JSON.stringify(parts) : (content as string);
}

/** Reverse of {@link dehydrateToolResultContent}: restore nested `source.value`s. */
async function hydrateToolResultContent(
  content: unknown,
  store: MediaStore,
  onMissing?: (miss: MediaHydrationMiss) => void
): Promise<string> {
  const parts = parseToolResultParts(content);
  if (!parts) return content as string;

  let changed = false;
  for (const part of parts) {
    const partType = part.type ?? "image";
    const didChange = await mapNestedMediaPart(part, async (source, metadata) => {
      const value = source.value as string;
      if (!isMediaRefValue(value)) return false;

      const mimeType = source.mimeType ?? guessMimeTypeFromRef(value, partType);
      const filename = typeof metadata.filename === "string" ? metadata.filename : undefined;
      const sourceType = source.type === "data" ? "data" : "url";
      const parsed = parseMediaRefPath(value);
      if (!parsed) {
        onMissing?.({ ref: value, reason: "invalid-ref", path: "tool-result" });
        return false;
      }

      const loaded = await store.tryLoad({ hash: parsed.hash, mimeType, filename, size: 0, sourceType });
      if (!loaded) {
        onMissing?.({ ref: value, reason: "not-found", path: "tool-result" });
        return false;
      }

      source.value = loaded;
      delete metadata.mediaRef;
      return true;
    });
    changed = changed || didChange;
  }

  return changed ? JSON.stringify(parts) : (content as string);
}

// ============================================================================
// Deep Clone
// ============================================================================

/**
 * Deep-clone a UIMessage array so we never mutate the original.
 * Uses JSON.parse/stringify which handles the serializable subset of
 * UIMessage (all fields are plain data — no functions, symbols, etc.).
 */
function cloneMessages(messages: UIMessage[]): UIMessage[] {
  return JSON.parse(JSON.stringify(messages)) as UIMessage[];
}

// ============================================================================
// Dehydrate
// ============================================================================

/**
 * Dehydrate UIMessages: extract base64 binary assets to MediaStore and
 * replace `source.value` with `media://<hash>` references.
 *
 * @param messages - Original UIMessage[] (NOT mutated)
 * @returns A new UIMessage[] with dehydrated source values
 */
export async function dehydrateUIMessages(
  messages: UIMessage[],
  options: { env: ResolvedCoreEnv }
): Promise<UIMessage[]> {
  const store = new MediaStore(options.env);
  // Repair interrupt-snapshot corruption before extracting media (legacy sessions).
  const cloned = cloneMessages(repairStringifiedMultimodalUIMessages(messages));

  for (const message of cloned) {
    for (const part of message.parts) {
      if (part.type === "tool-result") {
        part.content = await dehydrateToolResultContent(part.content, store);
        continue;
      }

      // `read_file` / `webfetch` keep their bytes on the CALL's structured output.
      if (part.type === "tool-call") {
        part.output = await dehydrateToolCallOutput(part.output, store);
        continue;
      }

      if (!isBinaryMediaPart(part)) continue;

      const { source } = part;
      const value = source.value;
      if (!value || !isBase64Source(value)) continue;

      const mimeType = source.mimeType ?? guessMimeType(value, part.type);
      const metadata = ensureMetadata(part);
      const filename = metadata.filename;
      const sourceType = source.type === "data" ? "data" : "url";

      const ref = await store.save(value, mimeType, filename, sourceType);
      source.value = buildMediaRefPath(ref);
      metadata.mediaRef = {
        hash: ref.hash,
        mimeType: ref.mimeType,
        filename: ref.filename,
        size: ref.size,
        sourceType: ref.sourceType,
      };
    }
  }

  return cloned;
}

// ============================================================================
// Hydrate
// ============================================================================

// ============================================================================
// Hydration diagnostics
// ============================================================================

/** Which part of a UIMessage held a `media://` ref that failed to hydrate. */
export type MediaMissPath = "content" | "tool-result" | "tool-call";

/** A `media://` reference that could not be hydrated. */
export interface MediaHydrationMiss {
  /** The `media://` ref (or ref-like value) that failed to resolve. */
  ref: string;
  /** `invalid-ref` = malformed ref; `not-found` = ref parsed but the media file is gone. */
  reason: "invalid-ref" | "not-found";
  /** Which part of the message held the ref. */
  path: MediaMissPath;
}

export interface HydrateUIMessagesOptions {
  /** Invoked once per un-hydratable media ref. Hydration itself never throws. */
  onMissing?: (miss: MediaHydrationMiss) => void;
  /** Workspace env for media I/O — always the owning runtime's env. */
  env: ResolvedCoreEnv;
}

/**
 * Hydrate UIMessages: load binary assets from MediaStore and reconstruct
 * the original `source.value` (data URL or raw base64).
 *
 * @param messages - Dehydrated UIMessage[] (may contain `media://` refs)
 * @param options - Optional `onMissing` hook fired for each un-hydratable media ref
 * @returns A new UIMessage[] with fully hydrated source values
 */
export async function hydrateUIMessages(
  messages: UIMessage[],
  options: HydrateUIMessagesOptions
): Promise<UIMessage[]> {
  const store = new MediaStore(options.env);
  const onMissing = options?.onMissing;
  // Restore multimodal parts that were persisted as JSON.stringify(ContentPart[]).
  const cloned = cloneMessages(repairStringifiedMultimodalUIMessages(messages));

  for (const message of cloned) {
    // JSON persistence turns the Date-typed `createdAt` into an ISO string;
    // TanStack's wire conversion calls `createdAt.toISOString()` and would
    // crash on the string form.
    //
    // NOTE (upstream fixed): @tanstack/ai >= 0.53.0 `coerceCreatedAt`
    // (activities/chat/messages.js) accepts string timestamps, so new engine
    // output survives wire conversion without this revive. Kept to normalize
    // legacy persisted sessions that still store ISO strings.
    if (typeof message.createdAt === "string") {
      const revived = new Date(message.createdAt);
      if (!Number.isNaN(revived.getTime())) message.createdAt = revived;
    }
    for (const part of message.parts) {
      if (part.type === "tool-result") {
        part.content = await hydrateToolResultContent(part.content, store, onMissing);
        continue;
      }

      if (part.type === "tool-call") {
        part.output = await hydrateToolCallOutput(part.output, store, onMissing);
        continue;
      }

      if (!isBinaryMediaPart(part)) continue;

      const metadata = part.metadata;
      const mediaRef = metadata?.mediaRef;

      if (!mediaRef) {
        // Old session — no mediaRef. Check if source.value is a media:// ref
        // (might happen if hydrating an already-dehydrated session).
        const { source } = part;
        if (!isMediaRefValue(source.value)) continue;

        const mimeType = metadata?.mediaType ?? guessMimeTypeFromRef(source.value, part.type);
        const filename = metadata?.filename;
        const sourceType = source.type === "data" ? "data" : "url";
        const parsed = parseMediaRefPath(source.value);
        if (!parsed) {
          onMissing?.({ ref: source.value, reason: "invalid-ref", path: "content" });
          continue;
        }

        const loaded = await store.tryLoad({
          hash: parsed.hash,
          mimeType,
          filename,
          size: 0,
          sourceType,
        });
        if (loaded) {
          source.value = loaded;
        } else {
          onMissing?.({ ref: source.value, reason: "not-found", path: "content" });
        }
        continue;
      }

      if (!isMediaHash(mediaRef.hash)) {
        onMissing?.({ ref: buildMediaRefPath(mediaRef), reason: "invalid-ref", path: "content" });
        continue;
      }

      const loaded = await store.tryLoad(mediaRef);
      if (!loaded) {
        onMissing?.({ ref: buildMediaRefPath(mediaRef), reason: "not-found", path: "content" });
        continue;
      }

      part.source.value = loaded;
      if (metadata) {
        delete metadata.mediaRef;
      }
    }
  }

  return cloned;
}

// ============================================================================
// Helpers (MIME type only — ext/parse live in types.ts)
// ============================================================================

/** Guess MIME type from a data URL or raw base64 content. */
function guessMimeType(value: string, partType: string): string {
  const parsed = parseDataUrl(value);
  if (parsed?.mimeType) return parsed.mimeType;
  return defaultMimeForPartType(partType);
}

/** Guess MIME type from a media:// ref string. */
function guessMimeTypeFromRef(ref: string, partType: string): string {
  const parsed = parseMediaRefPath(ref);
  if (parsed) {
    const mime = extensionToMime(parsed.ext);
    if (mime) return mime;
  }
  return defaultMimeForPartType(partType);
}
