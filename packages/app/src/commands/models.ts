import { type LoadedModelsState } from "@codent/core";

import { applyModelSelection, getLoadedModelsState } from "../utils/apply-model-selection.js";
import { getActiveSession } from "../utils/session-resolve.js";

import { registerBuiltinCommand } from "./utils/registry.js";

// ============================================================================
// /models — switch the model for the current session (models.json entries)
// ============================================================================

function describeEntry(entry: LoadedModelsState["entries"][number]): string {
  if (entry.type === "session") return "session-server";
  if (entry.type === "remote") return "remote-provider";
  return `direct:${entry.style}@${entry.baseURL.replace(/\/+$/, "")}`;
}

function entryLabel(state: LoadedModelsState, index: number, model: string): string {
  const current = state.active.entryIndex === index && state.active.model === model;
  return `${model}${current ? " (current)" : ""}`;
}

function buildOptions(): { label: string; value: string; description: string }[] {
  const state = getLoadedModelsState();
  if (!state) return [];
  const options: { label: string; value: string; description: string }[] = [];
  for (let i = 0; i < state.entries.length; i += 1) {
    const entry = state.entries[i];
    for (const model of entry.models) {
      options.push({
        label: entryLabel(state, i, model),
        value: `${i}:${model}`,
        description: describeEntry(entry),
      });
    }
  }
  return options;
}

registerBuiltinCommand("models", {
  immediate: false,
  allowCustomInput: true,
  getOptions: buildOptions,
  execute: async (args) => {
    const session = getActiveSession();
    if (!session) {
      return { ok: false, error: "Agent not initialized" };
    }

    const state = getLoadedModelsState();
    if (!state || state.entries.length === 0) {
      return { ok: false, error: "No models.json loaded — start with a config source." };
    }

    const trimmed = args.trim();
    if (!trimmed) {
      const lines = state.entries.map(
        (entry, i) =>
          `${i}: ${describeEntry(entry)}` +
          (entry.models.length
            ? ` — ${entry.models.map((m) => (state.active.entryIndex === i && state.active.model === m ? `[${m}]` : m)).join(", ")}`
            : " (no models)")
      );
      return { ok: true, message: `Models:\n${lines.join("\n")}` };
    }

    const colon = trimmed.indexOf(":");
    const entryIndex = colon >= 0 ? Number(trimmed.slice(0, colon)) : 0;
    const model = colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
    if (!Number.isInteger(entryIndex) || entryIndex < 0 || entryIndex >= state.entries.length) {
      return { ok: false, error: `Invalid entry index "${trimmed}"` };
    }
    const entry = state.entries[entryIndex];
    if (!entry.models.includes(model)) {
      return {
        ok: false,
        error: `"${model}" is not a known model for entry ${entryIndex} (${describeEntry(entry)}). Known: ${entry.models.join(", ") || "none"}`,
      };
    }

    // Apply the selection: register the provider, resolve model info, dispatch
    // `model.set` with the entry's connection, and sync the active entry/config.
    const applied = await applyModelSelection(session, state, entryIndex, model);
    if (!applied.ok) {
      return { ok: false, error: applied.error };
    }
    return { ok: true, message: `Switched to ${model} (${describeEntry(entry)})` };
  },
});
