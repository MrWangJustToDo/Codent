/**
 * The multimodal content-part vocabulary, in one place.
 *
 * Two layers consume the same four names for different reasons — the media store decides what is
 * persisted as a binary asset (`agent/media`), and the adapter decides what may go on the wire
 * (`models/adapter`) — and layer boundaries keep them from importing each other. A tuple here is
 * the shared definition; each layer keeps its own predicate/derived type on top.
 *
 * Adding a part type is a one-line change here plus the capability/label maps in the adapter.
 */
export const MULTIMODAL_PART_TYPES = ["image", "audio", "video", "document"] as const;

/** One multimodal content part type. */
export type MultimodalPartType = (typeof MULTIMODAL_PART_TYPES)[number];

/** Whether `type` names a multimodal content part. */
export function isMultimodalPartType(type: string | undefined): type is MultimodalPartType {
  return typeof type === "string" && (MULTIMODAL_PART_TYPES as readonly string[]).includes(type);
}
