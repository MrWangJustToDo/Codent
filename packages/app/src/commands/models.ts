import {
  decodeModelChoice,
  encodeModelChoice,
  offerableReasoningEfforts,
  parseModelsCommand,
  resolveModelInfoFromModelsDev,
  supportedReasoningEfforts,
  type AgentSession,
  type LoadedModelsState,
  type ModelInfo,
  type ReasoningEffort,
} from "@codent/core";

import { applyModelSelection, findModelEntry, getLoadedModelsState } from "../utils/apply-model-selection.js";
import { getActiveSession } from "../utils/session-resolve.js";

import { registerBuiltinCommand } from "./utils/registry.js";

import type { CommandOption } from "./utils/types.js";

// ============================================================================
// /models — switch the model and its thinking depth (models.json entries)
// ============================================================================
//
// The menu has two levels: the model list, then — only for a model that advertises thinking depth —
// the level list. Descending is generic (`CommandOption.getOptions`), so this command contributes
// one resolver per level and nothing here knows about menu internals.
//
// **Nothing commits until a leaf is accepted.** Picking a model descends; the switch happens when an
// effort row is chosen (or when the model has no depth list, so its row is the leaf). That is what
// makes `Esc` honest: retreat from the depth list and the session is still on the model it started
// on — the "deferred commit" the two-level menu exists to provide.

function describeEntry(entry: LoadedModelsState["entries"][number]): string {
  if (entry.type === "session") return "session-server";
  if (entry.type === "remote") return "remote-provider";
  return `direct:${entry.style}@${entry.baseURL.replace(/\/+$/, "")}`;
}

function entryLabel(state: LoadedModelsState, index: number, model: string): string {
  const current = state.active.entryIndex === index && state.active.model === model;
  return `${model}${current ? " (current)" : ""}`;
}

/**
 * Metadata for a catalog model, resolved through the connection it would run on.
 *
 * Best-effort: the lookup throws when models.dev is unreachable with no cache, and a menu must not
 * fail because metadata is missing — such a model simply has no depth level.
 */
async function modelInfoFor(
  state: LoadedModelsState,
  entryIndex: number,
  model: string
): Promise<ModelInfo | undefined> {
  const entry = state.entries[entryIndex];
  if (!entry) return undefined;
  try {
    return await resolveModelInfoFromModelsDev(model, entry.style);
  } catch {
    return undefined;
  }
}

/**
 * Level 0: every model of every entry, with its depth list resolved up front.
 *
 * The levels are resolved HERE (one metadata lookup per model, memoised by models.dev) rather than
 * lazily when a row is accepted. The difference is not performance but correctness: a lazy resolver is
 * asynchronous, and the menu cannot "execute instead of opening an empty level" asynchronously — the
 * accept already returned. The first implementation declared the lazy resolver on every row, so
 * picking a model with no thinking depth descended into an empty level, retreated, and left the input
 * naming the model; the model could never be switched from the menu.
 *
 * Resolving up front makes "has a submenu" a fact of the row: a plain model declares no resolver and
 * is an ordinary leaf (one accept = switch), a reasoning model declares a SYNCHRONOUS one built from
 * the same data (no empty level is possible).
 */
async function buildModelOptions(): Promise<CommandOption[]> {
  const state = getLoadedModelsState();
  if (!state) return [];
  const current = getActiveSession()?.getSnapshot().reasoningEffort;

  const rows = await Promise.all(
    state.entries.flatMap((entry, entryIndex) =>
      entry.models.map(async (model) => ({
        entry,
        entryIndex,
        model,
        levels: offerableReasoningEfforts(await modelInfoFor(state, entryIndex, model)),
      }))
    )
  );

  return rows.map(({ entry, entryIndex, model, levels }) => ({
    label: entryLabel(state, entryIndex, model),
    value: encodeModelChoice(entryIndex, model),
    description: describeEntry(entry),
    ...(levels.length > 0 ? { getOptions: () => buildEffortOptions(levels, current) } : {}),
  }));
}

/**
 * Level 1: the depth list — synchronous, from the levels resolved with the model row.
 *
 * `off` comes first: it is the model default rather than a level, and it is the only way back from an
 * explicit value. The rest is what the model advertises (`offerableReasoningEfforts`).
 */
function buildEffortOptions(levels: readonly ReasoningEffort[], current: ReasoningEffort | undefined): CommandOption[] {
  return [
    {
      label: "off",
      value: "off",
      description: current === undefined ? "current (use model default)" : "Use model default thinking depth",
    },
    ...levels.map((level) => ({
      label: level,
      value: level,
      description: level === current ? "current" : `Set thinking depth to ${level}`,
    })),
  ];
}

/**
 * The depth level for a model named by a menu path (`["<entryIndex>:<model>"]`).
 *
 * The menu never calls this — it uses the row's synchronous resolver — but the command's `getOptions`
 * receives a path when a level is opened directly, and that must still answer correctly.
 */
async function buildEffortOptionsFor(value: string): Promise<CommandOption[]> {
  const state = getLoadedModelsState();
  const decoded = decodeModelChoice(value);
  if (!state || !decoded) return [];
  const levels = offerableReasoningEfforts(await modelInfoFor(state, decoded.entryIndex, decoded.model));
  return levels.length > 0 ? buildEffortOptions(levels, getActiveSession()?.getSnapshot().reasoningEffort) : [];
}

/** Apply a model (+ optional depth) — the one write path. */
async function commitModel(
  session: AgentSession,
  state: LoadedModelsState,
  entryIndex: number,
  model: string,
  depth: ReasoningEffort | "off" | undefined
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const entry = state.entries[entryIndex];
  if (!entry) return { ok: false, error: `Invalid entry index ${entryIndex}` };
  if (!entry.models.includes(model)) {
    return {
      ok: false,
      error:
        `"${model}" is not a known model for entry ${entryIndex} (${describeEntry(entry)}). ` +
        `Known: ${entry.models.join(", ") || "none"}`,
    };
  }

  const applied = await applyModelSelection(session, state, entryIndex, model);
  if (!applied.ok) return { ok: false, error: applied.error };

  if (depth === undefined) return { ok: true, message: `Switched to ${model} (${describeEntry(entry)})` };

  // Validation uses the permissive rule (`supportedReasoningEfforts`) against the metadata the
  // session now carries for the NEW model — the same reading ACP's `/models` uses, so the two hosts
  // cannot disagree about what a level means.
  if (depth !== "off") {
    const supported = supportedReasoningEfforts(session.getSnapshot().modelInfo);
    if (!supported.includes(depth)) {
      return {
        ok: false,
        error: `Model does not support effort "${depth}". Supported: ${supported.join(", ") || "none"}`,
      };
    }
  }
  const result = await session.dispatch({ type: "effort.set", effort: depth === "off" ? undefined : depth });
  if (!result.ok) return { ok: false, error: result.error };

  return {
    ok: true,
    message: `Switched to ${model} (${describeEntry(entry)}, thinking ${depth === "off" ? "off (model default)" : depth})`,
  };
}

registerBuiltinCommand("models", {
  immediate: false,
  allowCustomInput: true,
  getOptions: (_ctx, path) => {
    // Path-aware: `[]` is the model list, one value deep is that model's depth list.
    const parent = path?.[path.length - 1];
    return parent === undefined ? buildModelOptions() : buildEffortOptionsFor(parent);
  },
  execute: async (args) => {
    const session = getActiveSession();
    if (!session) return { ok: false, error: "Agent not initialized" };

    const state = getLoadedModelsState();
    if (!state || state.entries.length === 0) {
      return { ok: false, error: "No models.json loaded — start with a config source." };
    }

    const intent = parseModelsCommand(args);

    if (intent.kind === "invalid") {
      return {
        ok: false,
        error:
          `Unknown /models argument "${intent.value}". Usage: /models [entryIndex:modelId [effort|off]] ` +
          `(no argument lists the entries).`,
      };
    }

    if (intent.kind === "list") {
      const lines = state.entries.map(
        (entry, i) =>
          `${i}: ${describeEntry(entry)}` +
          (entry.models.length
            ? ` — ${entry.models.map((m) => (state.active.entryIndex === i && state.active.model === m ? `[${m}]` : m)).join(", ")}`
            : " (no models)")
      );
      return { ok: true, message: `Models:\n${lines.join("\n")}` };
    }

    // A bare model id names its entry by search; the menu always sends the encoded form.
    let { entryIndex } = intent;
    const { model } = intent;
    if (entryIndex === undefined) {
      // `findModelEntry` prefers the ACTIVE entry when several offer the same id, which is the entry
      // the user means when they type a bare model id.
      const found = findModelEntry(state, model);
      if (found < 0) {
        return {
          ok: false,
          error: `Unknown model "${model}" — not in any models.json entry. Run /models to list them.`,
        };
      }
      entryIndex = found;
    }

    return commitModel(session, state, entryIndex, model, intent.clearEffort ? "off" : intent.effort);
  },
});
