/**
 * Model facet: persisted-model adoption, metadata refresh and the compaction budget.
 *
 * These three operations share one invariant — the model, its metadata and the token budget are
 * one decision. Keeping them in a facet means `ManagedAgent` delegates instead of owning another
 * cluster, and the rules can be exercised without constructing an agent.
 */

import { selectModel } from "../models/config/model-selection.js";
import { resolveModelInfoFromModelsDev, selectableModelIds } from "../models/config/models-config.js";
import { errorMessage } from "../utils/errors.js";

import { AgentConfigSchema } from "./agent-config.js";

import type { AgentConfig } from "./agent-config.js";
import type { UsageTracker } from "./telemetry/usage-tracker.js";
import type { CompactionConfig } from "../agent/compaction/types.js";
import type { ModelStyle } from "../models/config/model-connection.js";
import type { ModelInfo } from "../models/types.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";

export interface ModelFacetHost {
  readonly config: AgentConfig;
  readonly usage: UsageTracker;
  readonly runtime?: AgentRuntime;
  getModelInfo(): ModelInfo | null;
  /** Write the metadata field only (the facet owns the budget sync). */
  applyModelInfo(info: ModelInfo | null): void;
  setModel(
    next: {
      model?: string;
      modelStyle?: ModelStyle;
      modelBaseURL?: string;
      modelApiKey?: string;
      modelInfo?: ModelInfo | null;
    },
    options?: { emitChange?: boolean }
  ): void;
  getCompactionConfig(): CompactionConfig | null;
  emitEvent(type: "model:change", payload: Record<string, unknown>): void;
  emitDiagnostic(
    area: "model",
    message: string,
    options: { level?: "debug" | "info" | "warn"; data?: Record<string, unknown>; error?: string }
  ): void;
}

export class ModelFacet {
  constructor(private readonly host: ModelFacetHost) {}

  /**
   * Adopt a persisted model on resume.
   *
   * A persisted style belongs to the model it was saved with, so it is not carried onto a model
   * the runtime kept. A no-op when the effective model already matches the live config.
   */
  applyPersistedModel(next: { model: string; modelStyle?: ModelStyle }): {
    changed: boolean;
    model: string;
    modelStyle?: ModelStyle;
  } {
    const remote = this.host.config.providerMode === "remote";
    const selection = selectModel({
      requested: next.model,
      fallback: this.host.config.model,
      allowed: selectableModelIds(this.host.runtime?.models),
    });

    if (selection.fallback) {
      this.host.emitEvent("model:change", {
        from: selection.fallback.requested,
        to: selection.model,
        fallback: true,
        reason: "resume",
        ...(this.host.config.modelStyle ? { style: this.host.config.modelStyle } : {}),
      });
    }

    const style = remote || selection.fallback ? this.host.config.modelStyle : next.modelStyle;
    const sameModel = selection.model === this.host.config.model;
    const sameStyle = !style || style === this.host.config.modelStyle;
    if (sameModel && sameStyle) return this.effectivePersistedModel(false);

    if (!selection.fallback && !sameModel) {
      this.host.emitEvent("model:change", {
        from: this.host.config.model,
        to: selection.model,
        reason: "resume",
        ...(style ? { style } : {}),
      });
    }

    // Preflight the same schema `updateConfig` will run: a session written by another build can
    // name a style this build no longer accepts, and `setModel` would throw out of the restore.
    try {
      AgentConfigSchema.parse({
        ...this.host.config,
        model: selection.model,
        ...(style ? { modelStyle: style } : {}),
      });
    } catch (error) {
      this.host.emitDiagnostic("model", "Persisted model could not be applied; keeping the current model", {
        level: "warn",
        error: errorMessage(error),
        data: { model: selection.model, ...(style ? { modelStyle: style } : {}) },
      });
      return this.effectivePersistedModel(false);
    }

    this.host.setModel({ model: selection.model, ...(style ? { modelStyle: style } : {}) }, { emitChange: false });
    return { changed: true, model: selection.model, ...(style ? { modelStyle: style } : {}) };
  }

  /**
   * Resolve metadata (capabilities, context window, pricing) for the configured model.
   *
   * Best-effort: an offline lookup keeps bootstrap metadata when it already describes this model,
   * and clears it only when it describes a different one.
   */
  async refreshModelMetadata(): Promise<void> {
    const model = this.host.config.model;
    if (!model) return;

    const info = await resolveModelInfoFromModelsDev(model, this.host.config.modelStyle).catch(() => undefined);
    if (info) {
      this.setModelInfo(info);
      this.host.usage.setPricing(info.pricing ?? null);
      this.host.usage.setCapabilities(info.capabilities);
      return;
    }

    const current = this.currentModelInfo();
    if (current && current.id !== model) {
      this.setModelInfo(null);
      this.host.usage.setPricing(null);
      this.host.usage.setCapabilities(undefined);
    }
  }

  /** Replace the model metadata. Pass `null` to clear it (unknown model). */
  setModelInfo(info: ModelInfo | null): void {
    this.host.applyModelInfo(info);
    if (info) {
      this.host.emitDiagnostic("model", "Setting model info", {
        level: "debug",
        data: {
          id: info.id,
          ...(info.style ? { style: info.style } : {}),
          ...(info.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}),
        },
      });
    }
    this.syncCompactionBudget();
  }

  /** Clamp the persisted compaction budget to the model actually configured. */
  syncCompactionBudget(): void {
    const config = this.host.getCompactionConfig();
    if (!config) return;
    const window = this.currentModelInfo()?.contextWindow;
    this.host.usage.setTokenLimit(window ? Math.min(config.tokenThreshold, window) : config.tokenThreshold);
  }

  private effectivePersistedModel(changed: boolean): { changed: boolean; model: string; modelStyle?: ModelStyle } {
    return {
      changed,
      model: this.host.config.model,
      ...(this.host.config.modelStyle ? { modelStyle: this.host.config.modelStyle } : {}),
    };
  }

  private currentModelInfo(): ModelInfo | null {
    return this.host.getModelInfo();
  }
}
