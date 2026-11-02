/**
 * Coerce the argument shapes models actually send, before validation.
 *
 * Observed in real sessions: `edits` as a JSON string, `edits` as a single object, and the older
 * top-level `oldText` / `newText` pair. None of them is worth a failed turn — the pi agent does the
 * same normalization for exactly this reason.
 *
 * Shared with the approval preview (`previewEdit`) and the host's preview path: the server coerces
 * these shapes, so the UI must see the coerced form too or it would preview a different edit (or
 * none) from the one that will be written.
 */

/** Normalize `{ path, edits }` in place-free fashion; returns a shallow clone. */
export function normalizeEditArguments(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const args = { ...(input as Record<string, unknown>) };

  // 1. `edits` itself: a JSON string or a single edit object → an array.
  if (typeof args.edits === "string") {
    try {
      args.edits = JSON.parse(args.edits);
    } catch {
      // Leave the (invalid) string for the schema to report.
      return args;
    }
  }
  if (args.edits && typeof args.edits === "object" && !Array.isArray(args.edits)) {
    args.edits = [args.edits];
  }
  const edits: unknown[] = Array.isArray(args.edits) ? [...args.edits] : [];

  // 2. Legacy top-level pair → one more entry.
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    edits.push({ oldString: args.oldText, newString: args.newText });
    delete args.oldText;
    delete args.newText;
  }

  // 3. Legacy per-entry field names.
  args.edits = edits.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const record = entry as Record<string, unknown>;
    if (typeof record.oldText === "string" && typeof record.newText === "string") {
      const { oldText, newText, ...rest } = record;
      return { ...rest, oldString: oldText, newString: newText };
    }
    return entry;
  });

  return args;
}
