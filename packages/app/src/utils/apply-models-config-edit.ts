/**
 * Persist a mid-session `models.json` edit and make it live.
 *
 * The first-run wizard could stop at "write the file": startup continued through
 * the unified pipeline and read it back. Mid-session there is no restart, so a
 * save has to do the second half too, in the same order `initConfig` does:
 *
 * 1. merge the wizard draft into the **raw file on disk** (see
 *    {@link mergeModelsConfig}) and write it back, so nothing the wizard cannot
 *    represent is lost — not other entries, not `global`, not keys this build's
 *    schema does not declare;
 * 2. re-read the **written file** through `loadModels({ kind: "file" })` — not the
 *    in-memory draft — so the live provider is exactly what the next start reads;
 * 3. register the matching provider;
 * 4. update the config store's entry list (`modelsConfig`). The connection fields
 *    (`config.model` / `style` / `baseURL` / `apiKey`) are deliberately NOT written:
 *    the running session keeps its own connection, and re-picking the model is
 *    `/models`' job (`applyModelSelection`).
 *
 * The running session is deliberately not torn down: `useAgentChat` does not
 * depend on the connection fields, and `/models` already switches a live session
 * through `session.dispatch({ type: "model.set" })`. Editing the connection of
 * the running entry therefore applies on the next message, and the user can
 * re-pick with `/models` if the new list drops the current model.
 */

import {
  loadModels,
  readModelsConfigFile,
  registerModelProviderForEntry,
  normalizeRawGlobalToolConfig,
  writeModelsConfigFile,
  type LoadedModelsState,
  type ModelsConfig,
  type ModelsConfigEntry,
  type RawModelsConfig,
  type CoreEnv,
  errorMessage,
} from "@codent/core";
import { toRaw } from "reactivity-store";

import { useConfig } from "../hooks/use-config.js";

import { mergeModelsConfig } from "./merge-models-config.js";

export interface ApplyModelsConfigEditOptions {
  /** Entry the wizard was seeded from (defaults to the file's active entry). */
  entryIndex?: number;
  /**
   * The owning app runtime's env. The wizard runs inside the host process, so this is the
   * workspace whose `.agents/config/models.json` the user is editing; omitted = ambient (the
   * single-runtime hosts' compatibility seam).
   */
  env?: CoreEnv;
}

export type ApplyModelsConfigEditResult =
  | {
      ok: true;
      config: RawModelsConfig;
      /** Reloaded pipeline state, or `null` when the reload failed (see `reloadError`). */
      loaded: LoadedModelsState | null;
      model?: string;
      /**
       * The file was written, but the live pipeline could not be rebuilt — e.g. a
       * sibling `remote-provider` entry whose server is unreachable (`loadModels`
       * fetches every remote entry). The write stands and the edit is not rolled
       * back; the new connection applies on restart instead of immediately.
       */
      reloadError?: string;
    }
  | { ok: false; error: string };

/**
 * Save a wizard draft into `.agents/config/models.json` and reload the pipeline.
 */
export async function applyModelsConfigEdit(
  draft: ModelsConfig,
  options: ApplyModelsConfigEditOptions = {}
): Promise<ApplyModelsConfigEditResult> {
  try {
    // Read the **raw** document (no schema, no stripping) and merge against it.
    // Two reasons this is not `loadModelsConfigFromFile`:
    // - validation would drop every key the schema does not declare (`$schema`, a
    //   hand-written `headers`, a `global` field a newer build knows), so the write
    //   would silently delete the user's own fields;
    // - the file — not the in-memory store — is what must be preserved. The store
    //   can legitimately be empty (a config that failed to load, or a session
    //   started before the file existed), and merging against that would drop every
    //   entry the user already had.
    const existing = await readModelsConfigFile(undefined, options.env);
    const merged = mergeModelsConfig(existing, draft, options);

    // Rewrite the legacy `global.toolConfig.websearchProvider` key to `provider` on save.
    // `mergeModelsConfig` carries `global` across by reference to preserve unknown keys, so
    // without this the legacy spelling survives every save even though the read path maps it.
    const normalizedGlobal = normalizeRawGlobalToolConfig(merged.global);
    const toWrite =
      normalizedGlobal === merged.global ? merged : { ...merged, global: normalizedGlobal as ModelsConfig["global"] };

    await writeModelsConfigFile(toWrite, undefined, options.env);

    // Read back what was actually written — the merge and the schema both get a
    // vote here, so a live provider can never disagree with the file. The write is
    // already durable, so a reload failure must NOT be reported as a failed edit
    // and must not be rolled back: it degrades to "restart to apply".
    try {
      const loaded = await loadModels({ kind: "file", env: options.env });
      if (loaded) {
        await registerModelProviderForEntry(loaded);
        useConfig.getActions().setModelsConfig(loaded);
      }
      return { ok: true, config: merged, loaded, model: loaded?.active.model };
    } catch (reloadFailure) {
      return {
        ok: true,
        config: merged,
        loaded: null,
        reloadError: errorMessage(reloadFailure),
      };
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * The `models.json` entry a mid-session re-edit should start from: the active one, or none.
 *
 * Unwrapped with `toRaw` (the store hands out readonly proxies) and deep-cloned, because the
 * editor seeds React state from it — a shared reference would let the draft mutate the live
 * store mid-edit. A `remote-provider` entry has no connection fields, so the editor falls back
 * to a blank draft for it.
 *
 * Lives beside {@link applyModelsConfigEdit} because it is the read half of the same edit: it
 * answers "what am I editing", that one answers "what happens when I save".
 */
export function selectEditedEntry(): { entry: ModelsConfigEntry | undefined; entryIndex: number } {
  const loaded = toRaw(useConfig.getReadonlyState().modelsConfig) as LoadedModelsState | null;
  const entryIndex = loaded?.active.entryIndex ?? 0;
  const raw = loaded?.config.models[entryIndex] as ModelsConfigEntry | undefined;
  const entry = raw ? (JSON.parse(JSON.stringify(raw)) as ModelsConfigEntry) : undefined;
  return { entry, entryIndex };
}

/**
 * A saved edit's entry described for the confirmation line — e.g. `direct:anthropic@https://…`.
 *
 * `session` and `remote` have no connection fields worth printing, so they report the kind
 * instead. Takes the `loaded` state {@link applyModelsConfigEdit} returns rather than reading the
 * store, because the caller already holds the result of its own save.
 */
export function describeEditedEntry(loaded: LoadedModelsState | null, index: number): string {
  const entry = loaded?.entries[index];
  if (!entry) return "unknown";
  if (entry.type === "session") return "session-server";
  if (entry.type === "remote") return "remote-provider";
  return `direct:${entry.style}@${entry.baseURL.replace(/\/+$/, "")}`;
}
