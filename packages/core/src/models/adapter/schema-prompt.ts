import type { SchemaInput } from "@tanstack/ai";

// ============================================================================
// Types
// ============================================================================

/** A JSON Schema node, as much of it as the renderer reads. */
interface JsonSchemaNode {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode | JsonSchemaNode[];
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  [key: string]: unknown;
}

/** A top-level JSON document found in a model reply, with its source span. */
interface JsonCandidate {
  raw: string;
  start: number;
  end: number;
}

/**
 * Keywords the renderer cannot express as a flat field list.
 *
 * Refusing is deliberate: the renderer's output *is* the contract in text mode,
 * so a construct it renders approximately produces a prompt that asks for one
 * shape while the validator demands another — a failure that looks exactly like
 * a model refusing to follow instructions.
 *
 * Note which shapes actually reach this guard: Zod expresses a union as a **type
 * array** (`type: ["string", "number"]`, including from `z.union`), which renders
 * faithfully as `string or number` — so a Zod schema rarely trips it. The guard is
 * for raw JSON Schema handed through by a caller, where `oneOf` / `$ref` do appear
 * and *cannot* be flattened into one field phrase.
 */
const UNSUPPORTED_KEYWORDS = ["oneOf", "anyOf", "allOf", "not", "$ref", "if", "then", "else"] as const;

// ============================================================================
// Contract renderer
// ============================================================================

/**
 * Render a schema's contract as prompt text.
 *
 * **Why this exists.** In text mode the prompt is the *only* place the contract
 * exists — there is no `response_format`, no `input_schema`, nothing the provider
 * enforces. So every field the schema requires has to be named, or the model has
 * no reason to emit it and the reply is rejected by a validator it never saw.
 *
 * Hand-writing that list per caller is what the memory prompts did, and it
 * drifted: `memory-llm-contract` carries a "a required field dropped from the
 * prompt is a regression" rule precisely because it happened. Deriving the list
 * from the schema makes the prompt and the validator incapable of disagreeing.
 *
 * Throws for a schema using a construct it cannot express faithfully — see
 * {@link UNSUPPORTED_KEYWORDS} — rather than rendering an approximation.
 */
export function renderSchemaContract(schema: SchemaInput): string {
  const jsonSchema = resolveJsonSchema(schema);
  if (!jsonSchema) {
    throw new Error(
      "renderSchemaContract cannot read this schema: it exposes neither a `~standard.jsonSchema` " +
        "surface nor a JSON Schema object. Text mode needs a readable contract, because the prompt " +
        "is the only place the contract exists."
    );
  }

  const lines: string[] = [];
  lines.push("Reply with a single JSON object and nothing else — no prose, no markdown code fences.");
  lines.push("");
  lines.push(
    `Root object: it must carry the key(s) ${rootKeys(jsonSchema).join(", ")}, spelled exactly as shown, ` +
      "with the values described below."
  );
  lines.push("");
  lines.push("JSON contract:");
  renderObjectFields(jsonSchema, lines, 0, "");

  lines.push("");
  lines.push(
    "Rules: emit every field marked required; omit optional fields entirely rather than sending null; " +
      "use only the top-level keys listed above, and do not add others."
  );

  return lines.join("\n");
}

/**
 * Render one object level as an indented field list.
 *
 * `path` is the location used in refusal messages, so an unsupported keyword deep
 * in a nested array names the field that introduced it instead of pointing at the
 * root and leaving the caller to bisect their own schema.
 */ function renderObjectFields(node: JsonSchemaNode, lines: string[], depth: number, path: string): void {
  const properties = node.properties ?? {};
  const required = new Set(node.required ?? []);
  const indent = "  ".repeat(depth);

  for (const [key, field] of Object.entries(properties)) {
    const fieldPath = path ? `${path}.${key}` : key;
    const optional = required.has(key) ? "" : ", optional";
    const note = field.description ? ` — ${field.description}` : "";
    lines.push(`${indent}- "${key}": ${describeType(field, fieldPath)}${optional}${note}`);
    renderNested(field, lines, depth + 1, fieldPath);
  }
}

function rootKeys(node: JsonSchemaNode): string[] {
  const keys = Object.keys(node.properties ?? {});
  return keys.length > 0 ? keys.map((key) => `"${key}"`) : ["(none — the schema declares no keys)"];
}

/** Render the inner shape of an object-valued or array-of-objects field. */
function renderNested(field: JsonSchemaNode, lines: string[], depth: number, path: string): void {
  const indent = "  ".repeat(depth);

  if (field.items && !Array.isArray(field.items) && field.items.properties) {
    lines.push(`${indent}Each item:`);
    renderObjectFields(field.items, lines, depth, path);
    return;
  }
  if (field.properties) {
    renderObjectFields(field, lines, depth, path);
  }
}

/** One field's type phrase — enough for a model to know what to emit. */
function describeType(field: JsonSchemaNode, path: string): string {
  assertSupported(field, path);

  const enumValues = field.enum ?? (field.const !== undefined ? [field.const] : undefined);
  if (enumValues) {
    return `one of ${enumValues.map((value) => JSON.stringify(value)).join(", ")}`;
  }

  const type = Array.isArray(field.type) ? field.type.filter((entry) => entry !== "null").join(" or ") : field.type;

  if (type === "array") {
    const items = field.items;
    if (Array.isArray(items)) return "array";
    if (!items) return "array";
    if (items.enum) return `array of ${items.enum.map((value) => JSON.stringify(value)).join(" | ")}`;
    if (items.properties || items.type === "object") return "array of objects (see below)";
    return `array of ${items.type ?? "values"}`;
  }

  if (type === "object") return "object";
  // A null-only field is expressible, just pointless — say so rather than
  // falling through to the vague default.
  if (type === "null") return "null (always null)";
  return type ?? "value";
}

/** Refuse a construct the renderer cannot express faithfully. */
function assertSupported(field: JsonSchemaNode, path: string): void {
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (keyword in field) {
      throw new Error(
        `renderSchemaContract cannot express \`${keyword}\` in the prompt contract (at "${path}"). ` +
          "Text mode renders the schema as a field list, so a schema using this keyword would be " +
          "described approximately — the model would be asked for one shape while the validator " +
          "demanded another. Simplify the schema, or keep structured output for it."
      );
    }
  }
  if (field.items && Array.isArray(field.items)) {
    throw new Error(
      `renderSchemaContract cannot express a tuple (\`items\` as an array) in the prompt contract (at "${path}").`
    );
  }
}

/**
 * Read a schema's JSON Schema form.
 *
 * Two shapes are accepted, matching what the port already supports: a Standard
 * Schema (Zod) exposing `~standard.jsonSchema.input()`, and a raw JSON Schema
 * object the caller passed through. Returns `null` when neither is available.
 */
function resolveJsonSchema(schema: SchemaInput): JsonSchemaNode | null {
  const standard = (schema as { "~standard"?: { jsonSchema?: { input?: () => unknown } } })["~standard"];
  const fromStandard = standard?.jsonSchema?.input?.();
  if (fromStandard && typeof fromStandard === "object") return fromStandard as JsonSchemaNode;

  const raw = schema as JsonSchemaNode;
  if (raw && typeof raw === "object" && (raw.type || raw.properties)) return raw;

  return null;
}

// ============================================================================
// Strict JSON document extraction
// ============================================================================

/**
 * Find a complete JSON object document in a model reply.
 *
 * **Locating, never repairing.** The reply may wrap the document in prose or a
 * fence, so it has to be found; but nothing here *modifies* the text. A truncated
 * document stays truncated (its final `{` never closes), a trailing comma still
 * makes `JSON.parse` throw, and an ambiguous reply with two complete documents is
 * refused rather than guessed at. That boundary is the whole reason this is
 * acceptable where `jsonrepair`-style mangling is not: the bytes that get parsed
 * are bytes the model actually produced, and the parsed value still has to pass
 * the caller's schema.
 *
 * Returns `null` when no single complete document is present; the caller reports
 * that as a failure rather than falling back to a partial result.
 */
export function extractJsonDocument(text: string): { value: unknown; raw: string } | null {
  const candidates = collectCandidates(text);
  const parsed: Array<{ value: unknown; raw: string }> = [];

  for (const candidate of candidates) {
    try {
      parsed.push({ value: JSON.parse(candidate.raw) as unknown, raw: candidate.raw });
    } catch {
      // Not a document. A sibling candidate may still be one — a fence holding
      // an example above the real reply, for instance — so keep looking.
    }
  }

  // Two parseable documents mean the reply did not follow "the JSON object
  // only". Picking one is a guess, and a wrong guess silently returns the
  // example instead of the answer.
  if (parsed.length !== 1) return null;
  return parsed[0];
}

/** Every top-level `{…}` span, fenced blocks first and de-duplicated. */
function collectCandidates(text: string): JsonCandidate[] {
  const fenced = fencedCandidates(text);
  const scanned = braceSpans(text).filter(
    // A document inside a fence would otherwise be collected twice, and two
    // copies of one document must not read as two documents.
    (span) => !fenced.some((fence) => span.start >= fence.start && span.end <= fence.end)
  );
  return [...fenced, ...scanned];
}

/** Complete `{…}` spans inside ```-fenced blocks, in document order. */
function fencedCandidates(text: string): JsonCandidate[] {
  const out: JsonCandidate[] = [];
  const fence = /```[ \t]*[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/g;

  for (const match of text.matchAll(fence)) {
    const body = match[1];
    const bodyStart = (match.index ?? 0) + match[0].length - body.length - 3;
    for (const span of braceSpans(body)) {
      out.push({ raw: body.slice(span.start, span.end), start: bodyStart + span.start, end: bodyStart + span.end });
    }
  }

  return out;
}

/**
 * Top-level brace-balanced spans, respecting string literals and escapes.
 *
 * Depth tracking is what makes this a *scan* rather than a repair: an
 * unterminated document (truncated output) leaves the depth above zero and
 * yields nothing, so no candidate is produced for the caller to salvage.
 *
 * Brackets are tracked alongside braces so an object nested in an **array** is
 * not offered as a candidate. An array-root reply (`[{"a":1}]`) would otherwise
 * yield its inner object, and a caller whose schema happens to match that object
 * would accept a reply the model never structured as an object at all — the exact
 * "looks like it worked" failure the object-root rule exists to prevent.
 */
function braceSpans(text: string): JsonCandidate[] {
  const spans: JsonCandidate[] = [];
  let depth = 0;
  let bracketDepth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "[") {
      bracketDepth++;
      continue;
    }

    if (char === "]") {
      if (bracketDepth > 0) bracketDepth--;
      continue;
    }

    if (char === "{") {
      if (depth === 0 && bracketDepth === 0) start = i;
      depth++;
      continue;
    }

    if (char === "}") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        // Only a brace that opened at the top level is a document; one that opened
        // inside an array is a member and is discarded here.
        if (bracketDepth === 0) spans.push({ raw: text.slice(start, i + 1), start, end: i + 1 });
        start = -1;
      }
    }
  }

  return spans;
}
