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
 *    binary parts nested inside a tool result (`tool-result.content`) or a tool
 *    call's structured output (`tool-call.output`) — see "Nested tool media".
 * 4. **Inline runtime values** — parts without `metadata.mediaRef` that still
 *    carry a data URL / raw base64 (or `media://` path) are left or resolved
 *    as appropriate; dehydrated sessions always carry `mediaRef`.
 *
 * ## Nested tool media
 *
 * A multimodal tool result reaches the message channel in two shapes and both
 * must be walked:
 *
 * - **ContentPart[] (current)** — TanStack ≥ 1.0.1 `StreamProcessor` re-parses
 *   the stringified `TOOL_CALL_RESULT` and keeps the array on
 *   `tool-result.content`, which is also the same parts the `tool-call` carries in
 *   `output`. A tool result is `string | Array<ContentPart>`, so an array is not a
 *   text result with media in it — it is the media.
 * - **JSON text (legacy)** — `normalize-stream-chunk` stringifies an array
 *   `TOOL_CALL_END.result` into `TOOL_CALL_RESULT.content`, so a session written
 *   before the processor kept the array holds the JSON text of a `ContentPart[]`.
 *
 * Walking only the text form is what left every MCP screenshot inline — and twice
 * over, because the call's `output` carries the same parts. Rewriting the nested
 * `source.value`s keeps the base64 out of the session file (a single screenshot is
 * ~100 KB, a read_file image >1 MB).
 */

import { isBase64Source, parseDataUrl } from "../../utils/data-url.js";
import { isRecord as isPlainRecord } from "../../utils/is-record.js";

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

import type { BinaryMediaPartType, MediaRef } from "./types.js";
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
// Nested tool media (tool-result.content / tool-call.output)
// ============================================================================

interface NestedMediaPart {
  type?: string;
  source?: { type?: string; value?: string; mimeType?: string };
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A container of content parts, in whichever shape it was stored.
 *
 * `stringify` remembers the shape so a rewrite round-trips it: a legacy session keeps its JSON text,
 * a current session keeps its array.
 */
interface NestedContent {
  parts: NestedMediaPart[];
  stringify: boolean;
}

/**
 * Nested parts of a tool result / tool-call output, or `null` for a plain-text result.
 *
 * Array elements are not shape-checked here: {@link mapNestedMediaPart} only rewrites a part that
 * is a binary media type carrying a base64 / `media://` value, so an unrelated array passes through.
 * Deliberately not gated on `isContentPartArray` either — a strict gate would skip a near-miss shape
 * (a part missing `source.mimeType`, an extra field) and re-open the leak this walk exists to close,
 * whereas the narrow per-part test above can only rewrite something that IS inline media. The cost
 * is that a tool returning its own record array with `{type:"document", source:{value:<base64>}}`
 * gets that value replaced by a ref in the **persisted** copy only; hydrate restores it on load.
 */
function nestedContentOf(content: unknown): NestedContent | null {
  if (Array.isArray(content)) return { parts: content as NestedMediaPart[], stringify: false };
  if (typeof content !== "string") return null;
  const parts = parseStringifiedMultimodalContent(content) as NestedMediaPart[] | null;
  return parts ? { parts, stringify: true } : null;
}

/**
 * Rewrite a nested container's binary parts, returning the value in its original shape.
 *
 * Copy-on-write at the **container** level only: when no part changed, `content` is returned as-is,
 * so a caller can compare references to treat the whole walk as a no-op. When something did change,
 * the array that comes back is the same array the walk mutated — parts are rewritten in place, which
 * is what keeps a part's position (and the JSON shape of a persisted message) stable.
 */
async function rewriteNestedContent(
  content: unknown,
  rewrite: (parts: NestedMediaPart[]) => Promise<boolean>
): Promise<unknown> {
  const nested = nestedContentOf(content);
  if (!nested) return content;
  const changed = await rewrite(nested.parts);
  if (!changed) return content;
  return nested.stringify ? JSON.stringify(nested.parts) : nested.parts;
}

/**
 * Rewrite one nested binary part, returning whether anything changed.
 *
 * `partType` is passed to the rewriter instead of being re-read there: `mapNestedMediaPart` has
 * already narrowed it to a binary media type, and a `?? "image"` fallback downstream was dead code
 * that also lied about which type was being stored.
 */
async function mapNestedMediaPart(
  part: NestedMediaPart,
  rewrite: (
    partType: BinaryMediaPartType,
    source: NonNullable<NestedMediaPart["source"]>,
    metadata: Record<string, unknown>
  ) => Promise<boolean>
): Promise<boolean> {
  if (typeof part.type !== "string" || !isBinaryMediaPartType(part.type)) return false;
  const partType = part.type;
  const source = part.source;
  if (!source || typeof source.value !== "string" || source.value.length === 0) return false;

  const metadata = part.metadata != null && typeof part.metadata === "object" ? part.metadata : {};
  const changed = await rewrite(partType, source, metadata);
  if (changed) {
    // Keep the JSON shape stable across dehydrate/hydrate: drop the container
    // again when the rewrite removed the last key (hydrate clears mediaRef).
    if (Object.keys(metadata).length > 0) part.metadata = metadata;
    else delete part.metadata;
  }
  return changed;
}

/**
 * The `mediaRef` metadata dehydrate wrote on a nested part, or `undefined`.
 *
 * Hydrate needs it for the media store's **file extension**, which is derived from the MIME type:
 * a part with no `source.mimeType` (a `url` source may omit it) saved as `<hash>.bin` for an
 * unmapped type — `image/avif`, `video/quicktime` — and hydrate would otherwise re-derive the MIME
 * from the ref's own extension, get `undefined`, fall back to the part type's default
 * (`image/png`) and look for a file that was never written. Reported as `not-found`, the image
 * would be substituted with a "media unavailable" placeholder on the wire.
 */
function storedMediaRefOf(metadata: Record<string, unknown>): MediaRef | undefined {
  const candidate = metadata.mediaRef;
  if (!isPlainRecord(candidate)) return undefined;
  const { hash, mimeType, filename, size, sourceType } = candidate;
  if (typeof hash !== "string" || typeof mimeType !== "string") return undefined;
  return {
    hash,
    mimeType,
    filename: typeof filename === "string" ? filename : undefined,
    size: typeof size === "number" ? size : 0,
    sourceType: sourceType === "data" ? "data" : "url",
  };
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

function isToolCallOutputRecord(value: unknown): value is ToolCallOutputRecord {
  // One clause order, one definition (`utils/is-record.ts`); this wrapper only narrows the type.
  return isPlainRecord(value);
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
  // MCP results (and any tool that returns `ContentPart[]`) keep the parts on the call's output —
  // the same array the tool result carries. Walking only the record shapes below left a second
  // copy of every inline screenshot in the session file.
  if (Array.isArray(output)) return dehydrateNestedMedia(output, store);
  if (!isToolCallOutputRecord(output)) return output;

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
  if (Array.isArray(output)) return hydrateNestedMedia(output, store, onMissing, "tool-call");
  if (!isToolCallOutputRecord(output)) return output;
  if (!output.mediaRef) {
    // A `media://` value with no ref beside it cannot be resolved — the hash does not name the file's
    // extension — and leaving it unreported means the wire keeps an unfetchable value, because the
    // miss counter is what arms the substitution. Same class as an `invalid-ref` below.
    const orphan = [output.base64, output.content].find(
      (value): value is string => typeof value === "string" && isMediaRefValue(value)
    );
    if (orphan) onMissing?.({ ref: orphan, reason: "not-found", path: "tool-call" });
    return output;
  }
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
 * Dehydrate the binary parts nested in a tool result's `content` or a tool call's `output`.
 *
 * The container keeps its shape: a `ContentPart[]` stays an array (which the model wire accepts
 * directly), a legacy JSON-text result stays a string.
 */
async function dehydrateNestedMedia(content: unknown, store: MediaStore): Promise<unknown> {
  return rewriteNestedContent(content, async (parts) => {
    let changed = false;
    for (const part of parts) {
      const didChange = await mapNestedMediaPart(part, async (partType, source, metadata) => {
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
    return changed;
  });
}

/** Reverse of {@link dehydrateNestedMedia}: restore nested `source.value`s. */
async function hydrateNestedMedia(
  content: unknown,
  store: MediaStore,
  onMissing: ((miss: MediaHydrationMiss) => void) | undefined,
  path: MediaMissPath
): Promise<unknown> {
  return rewriteNestedContent(content, async (parts) => {
    let changed = false;
    for (const part of parts) {
      const didChange = await mapNestedMediaPart(part, async (partType, source, metadata) => {
        const value = source.value as string;
        if (!isMediaRefValue(value)) return false;

        // The ref's own MIME is the load-side truth: it is what dehydrate used to name the file,
        // and re-deriving it from `source.mimeType` (which a `url` source may not carry) can name a
        // different extension than the one that was written. See `storedMediaRefOf`.
        const mimeType =
          storedMediaRefOf(metadata)?.mimeType ?? source.mimeType ?? guessMimeTypeFromRef(value, partType);
        const filename = typeof metadata.filename === "string" ? metadata.filename : undefined;
        const sourceType = source.type === "data" ? "data" : "url";
        const parsed = parseMediaRefPath(value);
        if (!parsed) {
          onMissing?.({ ref: value, reason: "invalid-ref", path });
          return false;
        }

        const loaded = await store.tryLoad({ hash: parsed.hash, mimeType, filename, size: 0, sourceType });
        if (!loaded) {
          onMissing?.({ ref: value, reason: "not-found", path });
          return false;
        }

        source.value = loaded;
        delete metadata.mediaRef;
        return true;
      });
      changed = changed || didChange;
    }
    return changed;
  });
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
        part.content = (await dehydrateNestedMedia(part.content, store)) as typeof part.content;
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
        part.content = (await hydrateNestedMedia(part.content, store, onMissing, "tool-result")) as typeof part.content;
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
