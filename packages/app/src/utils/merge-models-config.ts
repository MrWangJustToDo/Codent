/**
 * Merge a `ConfigEditor` draft into an existing `models.json` **document**.
 *
 * The editor writes a whole file: a single `direct` entry built from its steps.
 * That is correct on first run (there is nothing to lose) and wrong on a re-edit,
 * which is what this module exists for.
 *
 * It operates on the *raw* document (`RawModelsConfig`), not the validated one,
 * and that is the whole point. `parseModelsConfig` strips every key the schema
 * does not declare — `$schema`, a hand-written `headers` on an entry, a `global`
 * setting a newer build knows — so merging a validated document would silently
 * delete the user's own fields while reporting success. Here only the entry being
 * edited is rebuilt; every other object is carried across **by reference** and
 * re-serialized unchanged.
 *
 * Rules:
 * - the entry at `entryIndex` keeps its unknown keys: only the fields the wizard
 *   owns are replaced (see {@link WIZARD_ENTRY_KEYS}), so a hand-written `headers`
 *   on the edited entry survives a change to its `baseURL` — the user edited the
 *   connection, not the whole object;
 * - every other entry, the whole `global` block, top-level unknown keys
 *   (`$schema`) and `global`'s own unknown keys are preserved verbatim;
 * - `active.entryIndex` follows the merged entry, so saving re-opens the same
 *   connection rather than jumping to entry 0, and the previous model is kept
 *   when the new entry still offers it.
 *
 * NOTE: `global` survives a save but can never be EDITED by this path — it is carried across by
 * reference (below) so a hand-written block is not destroyed. `global.toolConfig` (the only key the
 * schema declares) is therefore invisible in the UI: a user cannot discover or change it from the
 * app, only by editing the file.
 *
 * Pure: no fs, no env, no validation. `parseModelsConfig` has already validated
 * the draft, so `draft.models` holds exactly one well-formed entry.
 */

import type { ModelsConfig, ModelsConfigEntry, RawModelsConfig } from "@codent/core";

export interface MergeModelsConfigOptions {
  /**
   * Index of the entry the wizard was seeded from. Defaults to the document's own
   * `active.entryIndex`, which is what a `/settings config` re-edit means — the
   * user is editing the connection the session is running on.
   */
  entryIndex?: number;
}

/**
 * The entry fields the wizard owns. Everything else on an entry is the user's and
 * is carried across an edit untouched — these are deleted before the draft is
 * overlaid so a *removed* field (clearing the apiKey, converting a
 * `remote-provider` to `direct`) really goes away instead of being kept by the
 * spread.
 */
const WIZARD_ENTRY_KEYS = ["type", "style", "baseURL", "apiKey", "models", "url"] as const;

/** Overlay the draft's connection onto an entry, keeping the entry's own keys. */
function mergeEntry(existingEntry: unknown, draftEntry: ModelsConfigEntry): unknown {
  if (!existingEntry || typeof existingEntry !== "object" || Array.isArray(existingEntry)) {
    return draftEntry;
  }
  const rest = { ...(existingEntry as Record<string, unknown>) };
  for (const key of WIZARD_ENTRY_KEYS) delete rest[key];
  return { ...rest, ...draftEntry };
}

/**
 * Replace the connection of one entry with the wizard's draft, preserving the
 * rest of the document. Returns a new object; the input is not mutated.
 */
export function mergeModelsConfig(
  existing: RawModelsConfig | ModelsConfig | null,
  draft: ModelsConfig,
  options: MergeModelsConfigOptions = {}
): RawModelsConfig {
  const draftEntry = draft.models[0];
  if (!draftEntry) {
    // A validated draft always has exactly one entry; treat an empty one as
    // "nothing to merge" rather than writing a config the schema rejects.
    return (existing as RawModelsConfig) ?? { models: [] };
  }

  // Keep the raw entries as `unknown`, not `ModelsConfigEntry[]` — a typed copy
  // would re-apply the declared shape on the way out and drop unknown keys.
  const rawEntries: unknown[] = existing ? [...(existing.models as unknown[])] : [];
  const requested = options.entryIndex ?? existing?.active?.entryIndex ?? 0;
  const replacesExisting = requested >= 0 && requested < rawEntries.length;
  const index = replacesExisting ? requested : rawEntries.length;

  if (replacesExisting) {
    rawEntries[index] = mergeEntry(rawEntries[index], draftEntry);
  } else {
    rawEntries.push(draftEntry);
  }

  // Keep the model when the new entry still offers it; otherwise fall back to the
  // entry's first id (or leave `model` off so `loadModels` resolves it).
  const offered = draftEntry.type === "direct" ? (draftEntry.models ?? []) : [];
  const previousModel = replacesExisting ? existing?.active?.model : undefined;
  const model = previousModel && offered.includes(previousModel) ? previousModel : offered[0];
  const active = { entryIndex: index, ...(model ? { model } : {}) };

  // Spread `existing` first so top-level unknown keys (`$schema`) survive, then
  // overwrite only what this edit owns. `global` is carried by reference, so its
  // unknown keys survive too.
  return {
    ...(existing ?? {}),
    ...(existing?.global ? { global: existing.global } : {}),
    models: rawEntries as ModelsConfigEntry[],
    active,
  };
}
