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
  MEDIA_PROTOCOL,
  buildMediaRefPath,
  extensionToMime,
  isBinaryMediaPartType,
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

function isMediaRefValue(value: string): boolean {
  return value.startsWith(MEDIA_PROTOCOL);
}

// ============================================================================
// Hydration diagnostics
// ============================================================================

/** Which part of a UIMessage held a `media://` ref that failed to hydrate. */
export type MediaMissPath = "content" | "tool-result";

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

/** Fallback MIME per part kind, used when a data URL or media ref carries none. */
const PART_TYPE_DEFAULT_MIME: Record<string, string> = {
  image: "image/png",
  audio: "audio/mpeg",
  video: "video/mp4",
  document: "application/pdf",
};

/** Guess MIME type from a data URL or raw base64 content. */
function guessMimeType(value: string, partType: string): string {
  const parsed = parseDataUrl(value);
  if (parsed?.mimeType) return parsed.mimeType;
  return PART_TYPE_DEFAULT_MIME[partType] ?? "application/octet-stream";
}

/** Guess MIME type from a media:// ref string. */
function guessMimeTypeFromRef(ref: string, partType: string): string {
  const parsed = parseMediaRefPath(ref);
  if (parsed) {
    const mime = extensionToMime(parsed.ext);
    if (mime) return mime;
  }
  return PART_TYPE_DEFAULT_MIME[partType] ?? "application/octet-stream";
}
