/**
 * Model + mode as ACP session config options, and the write paths behind them.
 *
 * The protocol has **no** `session/set_model`: model selection is a `configOptions` entry with
 * `category: "model"` (go-sdk v0.13.5 removed the never-stabilized `session/set_model` /
 * `SessionModelState` surface entirely, and our SDK's `methods.agent` table never had it). So the
 * declaration and its write-back are two halves of one contract, and they live together here:
 *
 *  - `sessionConfigOptions` — what the client is told (`session/new`, `session/fork`, and every
 *    `config_option_update`),
 *  - `applyMode` / `applyModel` — how the client changes it, each dispatching through the session
 *    and then **re-reading** it rather than echoing the request.
 *
 * Both writes exist in exactly one place on purpose. `session/set_mode` and
 * `session/set_config_option(mode)` are two spellings of one behaviour; a second copy would drift,
 * and the drift would show up as the agent broadcasting a current value that never took effect.
 *
 * Nothing here registers a process-level model provider (unlike `@codent/app`'s `/models`): the run
 * path builds its adapter from the session's OWN config (`managers/run-agent.ts`), so the connection
 * travels in the `model.set` payload. That is required rather than an optimization — one ACP process
 * serves many sessions and the provider registry is process-wide, so registering would let one
 * session's switch change another's connection.
 */

import { RequestError } from "@agentclientprotocol/sdk";
import {
  AGENT_DATA_DIR,
  decodeModelChoice,
  encodeModelChoice,
  offerableReasoningEfforts,
  resolveModelInfoFromModelsDev,
  supportedReasoningEfforts,
} from "@codent/core";

import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import type {
  AgentSessionSnapshot,
  AgentMode,
  AgentSession,
  ModelCatalogRead,
  ModelStyle,
  ReasoningEffort,
} from "@codent/core";

export const MODE_IDS: AgentMode[] = ["normal", "auto", "plan"];

/** The wire value meaning "no explicit effort" — the model's own default. */
export const THOUGHT_LEVEL_DEFAULT = "off";
export const MODE_META: Record<AgentMode, { name: string; description: string }> = {
  normal: { name: "Normal", description: "Ask before risky actions" },
  auto: { name: "Auto", description: "Skip tool approvals (YOLO)" },
  plan: { name: "Plan", description: "Explore read-only, then build a plan" },
};

/**
 * One selectable connection from `.agents/config/models.json`, as ACP needs it.
 *
 * Process-wide (there is one config file) while the *current* model is per-session — the split
 * {@link sessionConfigOptions} reconciles. `index` is the position in `config.models` and is part of
 * the option VALUE, so a client's choice identifies the model *and* the connection it needs.
 */
export interface AcpModelCatalogEntry {
  index: number;
  style: ModelStyle;
  baseURL: string;
  apiKey?: string;
  models: string[];
}

function modeConfigOption(current: AgentMode): SessionConfigOption {
  return {
    id: "mode",
    name: "Mode",
    description: "How the agent handles risky actions",
    category: "mode",
    type: "select",
    currentValue: current,
    options: MODE_IDS.map((id) => ({ value: id, name: MODE_META[id].name, description: MODE_META[id].description })),
  };
}

/**
 * The `category: "thought_level"` select — the model's thinking depth.
 *
 * This is the ACP counterpart of the TUI's second `/models` level, and it exists for the same
 * reason: depth belongs to the model, so both must be reachable from one place. The protocol has a
 * category for exactly this, and clients (Zed among them) render it as a picker beside the model.
 *
 * The wire value is the effort level itself, or `off` (back to the model default — an absent effort,
 * not a level called "off"). The list comes from `offerableReasoningEfforts`, which answers `[]` for
 * a model with no thinking depth: an option with a single fake value would be worse than no option,
 * so the selector is omitted entirely.
 */
function thoughtLevelConfigOption(snapshot: AgentSessionSnapshot): SessionConfigOption | undefined {
  const levels = offerableReasoningEfforts(snapshot.modelInfo);
  if (levels.length === 0) return undefined;
  const current = snapshot.reasoningEffort ?? THOUGHT_LEVEL_DEFAULT;
  return {
    id: "thought_level",
    name: "Thinking",
    description: "Reasoning depth for this model",
    category: "thought_level",
    type: "select",
    currentValue: current,
    options: [
      {
        value: THOUGHT_LEVEL_DEFAULT,
        name: "Model default",
        description: "Let the model decide how much to think",
      },
      ...levels.map((level) => ({
        value: level,
        name: level,
        description: level === snapshot.reasoningEffort ? "current" : `Think with ${level} effort`,
      })),
    ],
  };
}

/**
 * The read → the entry list this module projects. The read is the runtime's (`readModels()`, one
 * `loadModels` result); index = position, which is exactly what `encodeModelChoice` encodes.
 */
function entriesOf(read: ModelCatalogRead | undefined): AcpModelCatalogEntry[] | undefined {
  return read?.entries.map((entry, index) => ({
    index,
    style: entry.style,
    baseURL: entry.baseURL,
    ...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
    models: entry.models,
  }));
}

/**
 * The catalog entry a session's current model's connection belongs to.
 *
 * `selectedEntryIndex` is the entry the connection was actually taken from — recorded by whoever
 * switched it ({@link applyModel}) and seeded at `session/new` from the config's active entry. It is
 * consulted FIRST because a model id is only unique within an entry: with `shared` in two entries,
 * first-match resolution names entry 0 for a session running on entry 1's connection, and
 * re-selecting that advertised value would then dispatch entry 0's credentials.
 *
 * First-match stays as the fallback for a session whose entry was never recorded in this process —
 * a resumed session: its snapshot carries the model id but not the connection, so this is the best
 * available answer rather than a claim.
 */
function resolveCurrentEntry(
  catalog: AcpModelCatalogEntry[],
  current: string,
  selectedEntryIndex?: number
): AcpModelCatalogEntry | undefined {
  if (selectedEntryIndex !== undefined) {
    const recorded = catalog.find((entry) => entry.index === selectedEntryIndex);
    if (recorded?.models.includes(current)) return recorded;
  }
  return catalog.find((entry) => entry.models.includes(current));
}

/** The advertised `thought_level` value for a snapshot — the effort, or the "model default" marker. */
export function effortOf(snapshot: AgentSessionSnapshot): string {
  return snapshot.reasoningEffort ?? THOUGHT_LEVEL_DEFAULT;
}

/**
 * Build the `category: "model"` select from the catalog.
 *
 * `current` is guaranteed to appear in `options`: the protocol requires the agent to provide a
 * default for every option it advertises, and a client cannot render a selection that is not in the
 * list. A current model missing from the catalog (the file was edited under a live session, or a
 * restored session predates it) is therefore inserted, unencoded, rather than dropped.
 */
function modelConfigOption(
  catalog: AcpModelCatalogEntry[],
  current: string,
  selectedEntryIndex?: number
): SessionConfigOption {
  const options: SessionConfigSelectOption[] = catalog.flatMap((entry) =>
    entry.models.map((model) => ({
      value: encodeModelChoice(entry.index, model),
      name: model,
      // No credentials in the advertised payload — `apiKey` never leaves the process.
      description: `entry ${entry.index} · ${entry.style} · ${entry.baseURL}`,
    }))
  );
  const currentEntry = resolveCurrentEntry(catalog, current, selectedEntryIndex);
  if (!currentEntry) {
    options.unshift({ value: current, name: current, description: "current model (not in models.json)" });
  }
  return {
    id: "model",
    name: "Model",
    description: "Model to run this session on (switching may also switch the provider)",
    category: "model",
    type: "select",
    currentValue: currentEntry ? encodeModelChoice(currentEntry.index, current) : current,
    options,
  };
}

/**
 * The entry index the ADVERTISEMENT names for `model` (first match when nothing was recorded).
 *
 * Distinct from the connection's `selectedEntryIndex`: the latter is only known when this process
 * switched the session, while the advertised value always has to name SOME entry. Hosts seed their
 * "last advertised" mirror with this, or re-selecting the value a `load` response just advertised
 * looks like an entry change (`undefined → 0`) and broadcasts a redundant update.
 */
export function resolveAdvertisedEntryIndex(
  read: ModelCatalogRead | undefined,
  model: string | undefined,
  selectedEntryIndex?: number
): number | undefined {
  const catalog = entriesOf(read);
  if (!catalog?.length || !model) return selectedEntryIndex;
  return resolveCurrentEntry(catalog, model, selectedEntryIndex)?.index;
}

/**
 * The session config selects advertised by `session/new` and `session/fork`.
 *
 * `mode` reads the same `mode` channel state as `session/set_mode` / `current_mode_update`, so it is
 * a projection of that truth, not a second source. `model` is present only when a catalog exists:
 * explicit `--model` flags skip `.agents/config/models.json` but bootstrap builds a one-entry catalog,
 * so those planes advertise one fixed value (information, not a fake choice).
 */
export function sessionConfigOptions(
  snapshot: AgentSessionSnapshot,
  read: ModelCatalogRead | undefined,
  selectedEntryIndex?: number
): SessionConfigOption[] {
  const mode = modeConfigOption(snapshot.mode);
  const thought = thoughtLevelConfigOption(snapshot);
  const catalog = entriesOf(read);
  const selectable = catalog?.some((entry) => entry.models.length > 0) ?? false;
  if (!snapshot.model) return [mode, ...(thought ? [thought] : [])];
  // The read always contains the active model (the pipeline's invariant), so a readable list is also a
  // switchable-or-informing selector: one entry means "this is the model", several mean "choose".
  if (!selectable) return [mode, ...(thought ? [thought] : [])];
  // Model first: it is the option users reach for most often, and the spec makes array order the
  // agent's declared priority. Thinking depth follows it because it is a property of that model. The
  // mode option stays either way — it is the `configOptions` counterpart of the legacy `modes` field
  // some clients still read.
  return [
    modelConfigOption(catalog as AcpModelCatalogEntry[], snapshot.model, selectedEntryIndex),
    ...(thought ? [thought] : []),
    mode,
  ];
}

/**
 * The legacy `models` field, for clients that predate `configOptions` (and for the removed
 * `session/set_model`, which they call).
 *
 * The current protocol dropped it — model selection is a `configOptions` entry with
 * `category: "model"` — but Zed's own adapters still ship `models`, and a client that only reads that
 * field showed no picker at all. Both surfaces are built from the SAME catalog and the same
 * `encodeModelChoice` values, so a client reading either one names the identical model.
 */
export interface LegacySessionModelState {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name: string; description?: string }>;
}

export function legacySessionModelState(
  read: ModelCatalogRead | undefined,
  current: string | undefined,
  selectedEntryIndex?: number
): LegacySessionModelState | undefined {
  const catalog = entriesOf(read);
  if (!current) return undefined;
  const selectable = catalog?.some((entry) => entry.models.length > 0) ?? false;
  if (!selectable || !catalog) return undefined;
  const currentEntry = resolveCurrentEntry(catalog, current, selectedEntryIndex);
  return {
    currentModelId: currentEntry ? encodeModelChoice(currentEntry.index, current) : current,
    availableModels: catalog.flatMap((entry) =>
      entry.models.map((model) => ({
        modelId: encodeModelChoice(entry.index, model),
        name: model,
        description: `entry ${entry.index} · ${entry.style}`,
      }))
    ),
  };
}

/** What a write needs from the session it acts on — the bridge's session and its id. */
export interface ConfigOptionTarget {
  session: AgentSession;
  acpId: string;
}

/** The advertised mode ids, for validating `session/set_mode`'s argument. */
export function isModeId(value: string): value is AgentMode {
  return (MODE_IDS as string[]).includes(value);
}

/**
 * Apply a mode — the ONE place a mode change happens.
 *
 * ACP reaches this by two routes (`session/set_mode`, and `session/set_config_option` via the `mode`
 * option it advertises), and they must not grow into two mode systems. The caller owns the emitter;
 * the update must be the WHOLE option set (the protocol's `ConfigOptionUpdate` has no incremental
 * form, so sending only the mode entry would wipe the model entry out of the client's cache).
 */
export async function applyMode(target: ConfigOptionTarget, mode: AgentMode): Promise<AgentSessionSnapshot> {
  if (!isModeId(mode)) throw RequestError.invalidParams(undefined, `Unknown mode: ${mode}`);
  await target.session.dispatch({ type: "mode.set", mode });
  // Re-read rather than echo: the dispatch may be a no-op (already in that mode) or clamp to
  // something else, and the advertised option must describe what the session ACTUALLY is.
  return target.session.getSnapshot();
}

/**
 * Apply a model — the ONE place a model change happens.
 *
 * Accepts either an encoded catalog value (`"<entryIndex>:<model>"`) or a bare model id, because
 * {@link modelConfigOption} inserts the session's current model unencoded when it is missing from
 * the catalog; re-selecting that value is a no-op rather than an error.
 *
 * Returns the entry the new connection came from (`undefined` when nothing was re-resolved). The
 * caller records it: without that, the next advertisement can only guess which entry a
 * duplicated model id belongs to.
 */
export async function applyModel(
  target: ConfigOptionTarget,
  value: string,
  read: ModelCatalogRead | undefined,
  currentEntryIndex?: number
): Promise<ModelSwitchOutcome> {
  const catalog = entriesOf(read);
  // No read = this host was never given a model list; nothing can be validated (or switched).
  if (!catalog?.length)
    throw RequestError.invalidParams(
      undefined,
      `No models are configured (no \`${AGENT_DATA_DIR}/config/models.json\`)`
    );

  const current = target.session.getSnapshot();
  const decoded = decodeModelChoice(value);
  const entry = decoded ? catalog.find((candidate) => candidate.index === decoded.entryIndex) : undefined;
  const model = decoded?.model ?? value;
  if (decoded && !entry) throw RequestError.invalidParams(undefined, `Unknown model entry: ${decoded.entryIndex}`);
  if (!decoded && model !== current.model) throw RequestError.invalidParams(undefined, `Unknown model: ${value}`);
  if (entry && !entry.models.includes(model)) throw RequestError.invalidParams(undefined, `Unknown model: ${model}`);

  // Re-selecting the current model is a no-op: re-sending the whole `configOptions` set for a value
  // the client already holds is noise, and it also re-resolves metadata (a network round-trip) for
  // nothing. A DIFFERENT entry with the same model id is not a no-op — the connection changes.
  // When the session's entry was never recorded, resolve the current entry the same way the
  // advertisement did (first match) and treat THAT as the current connection; an explicit other
  // entry then switches instead of being silently mislabelled.
  const currentEntry = resolveCurrentEntry(catalog, current.model ?? "", currentEntryIndex);
  const sameEntry = !entry || entry.index === currentEntry?.index;
  if (model === current.model && sameEntry) {
    return { snapshot: current, ...(entry ? { entryIndex: entry.index } : {}) };
  }

  // Metadata is best-effort and must NOT be able to fail the switch: `resolveModelInfoFromModelsDev`
  // THROWS when models.dev is unreachable with no cache ("No cached data available"), and a model
  // change needs no metadata — it only labels the model for the UI. Core's own convention is the
  // same ("the lookup is best-effort, so a models.dev failure just leaves modelInfo unset").
  // `undefined` means "unknown" to core, which restores its permissive capability default rather
  // than keeping the previous model's. Never send `null`: the wire has no null modelInfo.
  let modelInfo: Awaited<ReturnType<typeof resolveModelInfoFromModelsDev>>;
  if (entry) {
    try {
      modelInfo = await resolveModelInfoFromModelsDev(model, entry.style);
    } catch {
      modelInfo = undefined;
    }
  }
  const result = await target.session.dispatch({
    type: "model.set",
    model,
    ...(entry && { modelStyle: entry.style, modelBaseURL: entry.baseURL, modelApiKey: entry.apiKey }),
    ...(modelInfo ? { modelInfo } : {}),
  });
  if (!result.ok) throw new Error(result.error ?? `Failed to switch model: ${model}`);

  return { snapshot: target.session.getSnapshot(), ...(entry ? { entryIndex: entry.index } : {}) };
}

/**
 * Apply a thinking depth — the ONE place an effort change happens.
 *
 * Two routes reach it: the `thought_level` config option a client renders, and `/models <model> <effort>`
 * (which calls `effort.set` directly after validating against the new model). The level is validated
 * with the same rule `/models` uses (`supportedReasoningEfforts`) — a model whose metadata does not
 * list levels is "unknown", not "accepts nothing", so refusing there would make the selector stricter
 * than the command for the same operation.
 *
 * `THOUGHT_LEVEL_DEFAULT` clears the effort — the model default is the ABSENCE of a level, and
 * storing a made-up `"off"` effort would forward it to the adapter.
 */
export async function applyThoughtLevel(target: ConfigOptionTarget, value: string): Promise<AgentSessionSnapshot> {
  const current = target.session.getSnapshot();
  const supported = supportedReasoningEfforts(current.modelInfo);
  if (value !== THOUGHT_LEVEL_DEFAULT && !supported.includes(value as ReasoningEffort)) {
    throw RequestError.invalidParams(
      undefined,
      `Model does not support thinking level "${value}". Supported: ${supported.join(", ") || "none"}`
    );
  }
  await target.session.dispatch({
    type: "effort.set",
    effort: value === THOUGHT_LEVEL_DEFAULT ? undefined : (value as ReasoningEffort),
  });
  return target.session.getSnapshot();
}

/** What {@link applyModel} reports back: the session after the change, and the entry it used. */
export interface ModelSwitchOutcome {
  snapshot: AgentSessionSnapshot;
  /** The catalog entry the connection came from — record it, or the next advertisement cannot name it. */
  entryIndex?: number;
}
