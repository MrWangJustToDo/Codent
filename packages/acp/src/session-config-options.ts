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

import { resolveModelInfoFromModelsDev } from "@codent/core";

import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import type { AgentSessionSnapshot, AgentMode, AgentSession, ModelStyle } from "@codent/core";

export const MODE_IDS: AgentMode[] = ["normal", "auto", "plan"];
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

/**
 * The option value for one catalog model.
 *
 * It encodes the ENTRY, not just the model, because switching a model can also switch the
 * connection: a model id is only unique within an entry (`entry.models` holds bare names like
 * `deepseek/deepseek-v4-flash-0731`), and `model.set` needs that entry's `style` / `baseURL`.
 *
 * `"<entryIndex>:<model>"` is the same encoding `@codent/app`'s `/models` uses, so the two hosts
 * cannot drift on it. A client only ever echoes it back as an opaque id.
 */
function encodeModelChoice(entryIndex: number, model: string): string {
  return `${entryIndex}:${model}`;
}

/**
 * Split a model option value back into its entry index and model id.
 *
 * Splits on the FIRST colon: the entry index never contains one while a model id may (`a:b`).
 * Returns `undefined` for a value that is not in the encoded form — which is how a current model
 * missing from the catalog is advertised, so the caller treats a bare value as "the session's
 * current model" rather than an error.
 */
export function decodeModelChoice(value: string): { entryIndex: number; model: string } | undefined {
  const separator = value.indexOf(":");
  if (separator <= 0) return undefined;
  const entryIndex = Number(value.slice(0, separator));
  const model = value.slice(separator + 1);
  if (!Number.isInteger(entryIndex) || entryIndex < 0 || !model) return undefined;
  return { entryIndex, model };
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
 * Build the `category: "model"` select from the catalog.
 *
 * `current` is guaranteed to appear in `options`: the protocol requires the agent to provide a
 * default for every option it advertises, and a client cannot render a selection that is not in the
 * list. A current model missing from the catalog (the file was edited under a live session, or a
 * restored session predates it) is therefore inserted, unencoded, rather than dropped.
 */
function modelConfigOption(catalog: AcpModelCatalogEntry[], current: string): SessionConfigOption {
  const options: SessionConfigSelectOption[] = catalog.flatMap((entry) =>
    entry.models.map((model) => ({
      value: encodeModelChoice(entry.index, model),
      name: model,
      // No credentials in the advertised payload — `apiKey` never leaves the process.
      description: `entry ${entry.index} · ${entry.style} · ${entry.baseURL}`,
    }))
  );
  const currentEntry = catalog.find((entry) => entry.models.includes(current));
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
 * The session config selects advertised by `session/new` and `session/fork`.
 *
 * `mode` reads the same `mode` channel state as `session/set_mode` / `current_mode_update`, so it is
 * a projection of that truth, not a second source. `model` is present only when a catalog exists:
 * explicit `--model` flags skip `.agents/config/models.json`, and a selector offering exactly one
 * value would be a fake choice — the protocol lets a client degrade gracefully on a missing option.
 */
export function sessionConfigOptions(
  snapshot: AgentSessionSnapshot,
  catalog: AcpModelCatalogEntry[] | undefined
): SessionConfigOption[] {
  const mode = modeConfigOption(snapshot.mode);
  const selectable = catalog?.some((entry) => entry.models.length > 0) ?? false;
  if (!selectable || !snapshot.model) return [mode];
  // Model first: it is the option users reach for most often, and the spec makes array order the
  // agent's declared priority. The mode option stays either way — it is the `configOptions`
  // counterpart of the legacy `modes` field some clients still read.
  return [modelConfigOption(catalog as AcpModelCatalogEntry[], snapshot.model), mode];
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
 * option it advertises), and they must not grow into two mode systems.
 *
 * `onAdvertised` is called when the value actually changed, with the freshly read snapshot: the
 * caller owns the emitter, and the update must be sent as the WHOLE option set (the protocol's
 * `ConfigOptionUpdate` carries `configOptions` and has no incremental form, so sending only the mode
 * entry would wipe the model entry out of the client's cache).
 */
export async function applyMode(target: ConfigOptionTarget, mode: AgentMode): Promise<AgentSessionSnapshot> {
  if (!isModeId(mode)) throw new Error(`Unknown mode: ${mode}`);
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
 */
export async function applyModel(
  target: ConfigOptionTarget,
  value: string,
  catalog: AcpModelCatalogEntry[] | undefined
): Promise<AgentSessionSnapshot> {
  if (!catalog?.length) throw new Error("No models are configured (no `.agents/config/models.json`)");

  const decoded = decodeModelChoice(value);
  const entry = decoded ? catalog.find((candidate) => candidate.index === decoded.entryIndex) : undefined;
  const model = decoded?.model ?? value;
  if (decoded && !entry) throw new Error(`Unknown model entry: ${decoded.entryIndex}`);
  if (!decoded && model !== target.session.getSnapshot().model) throw new Error(`Unknown model: ${value}`);
  if (entry && !entry.models.includes(model)) throw new Error(`Unknown model: ${model}`);

  // Metadata is best-effort and must NOT be able to fail the switch: `resolveModelInfoFromModelsDev`
  // THROWS when models.dev is unreachable with no cache ("No cached data available"), and a model
  // change needs no metadata — it only labels the model for the UI. Core's own convention is the
  // same ("the lookup is best-effort, so a models.dev failure just leaves modelInfo unset").
  // `undefined` means "unknown" to core, which restores its permissive capability default rather
  // than keeping the previous model's.
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
    modelInfo: modelInfo ?? null,
  });
  if (!result.ok) throw new Error(result.error ?? `Failed to switch model: ${model}`);

  return target.session.getSnapshot();
}
