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

    // Adopt the connection of the entry that ADVERTISES this model, not the bootstrap one.
    //
    // `selectableModelIds` is the union across entries, so a persisted model can belong to entry B
    // while the live config still holds entry A's baseURL/key: the id was in the catalog, so
    // `selectModel` accepted it, and the request then went to A with a model A never advertised
    // (404, or worse, silently served by a gateway under A's pricing). The TUI relinks the session
    // model after a `/models` pick; a host without that path (ACP) had nothing to repair it.
    // Skipped under a remote provider: there the server owns the connection.
    const adopted = this.connectionOfAdvertisingEntry(selection.model, style);
    // The adopted entry's style wins: a persisted style belongs to the model it was saved with, but
    // the connection that serves that model has its own (a gateway's style is not a preference).
    const finalStyle = adopted?.style ?? style;
    this.host.setModel(
      {
        model: selection.model,
        ...(finalStyle ? { modelStyle: finalStyle } : {}),
        ...(adopted
          ? {
              modelBaseURL: adopted.baseURL,
              ...(adopted.apiKey !== undefined ? { modelApiKey: adopted.apiKey } : {}),
            }
          : {}),
      },
      { emitChange: false }
    );
    if (adopted) {
      this.host.emitDiagnostic("model", "Adopted the connection of the entry that advertises the resumed model", {
        level: "info",
        data: {
          model: selection.model,
          baseURL: adopted.baseURL,
          style: adopted.style,
          ...(adopted.apiKey === "" ? { apiKeyCleared: true } : {}),
        },
      });
    }
    // Report the style that was actually WRITTEN. Returning the requested one made the caller (the
    // restore path) "correct" the session record back to a style the adopted connection does not use,
    // so every later resume re-applied the adoption and rewrote the same wrong value.
    return { changed: true, model: selection.model, ...(finalStyle ? { modelStyle: finalStyle } : {}) };
  }

  /**
   * The catalog entry that advertises `model` with a DIFFERENT connection than the live config.
   *
   * `undefined` means "nothing to change": the model is unknown to the catalog, the current entry
   * already advertises it, the entry is not a direct connection, or the provider is remote (which
   * owns the connection itself).
   */
  private connectionOfAdvertisingEntry(
    model: string,
    persistedStyle?: ModelStyle
  ): { style: ModelStyle; baseURL: string; apiKey?: string; sameHost: boolean } | undefined {
    if (this.host.config.providerMode === "remote") return undefined;
    const entries = this.host.runtime?.models?.entries ?? [];
    const advertisers = entries.filter((entry) => entry.type === "direct" && entry.models.includes(model));
    if (advertisers.length === 0) return undefined;
    const alreadyServed = advertisers.some(
      (entry) => entry.baseURL === this.host.config.modelBaseURL && entry.style === this.host.config.modelStyle
    );
    if (alreadyServed) return undefined;
    // Several entries can advertise one id (two gateways, or the same model under two styles). The
    // persisted style is the only per-session fact that tells them apart, so prefer the advertiser
    // that matches it — otherwise file order would silently override a style the user chose.
    const entry = advertisers.find((candidate) => candidate.style === persistedStyle) ?? advertisers[0]!;
    const sameHost = entry.baseURL === this.host.config.modelBaseURL;
    // A key belongs to the HOST it authenticates. Adopting an entry that carries none while the
    // live config still holds another host's key sent that secret to the new host; on a different
    // host the key is cleared instead (`""` = no auth, which is what a keyless entry means).
    const apiKey = entry.apiKey !== undefined ? entry.apiKey : sameHost ? undefined : "";
    return {
      style: entry.style,
      baseURL: entry.baseURL,
      ...(apiKey !== undefined ? { apiKey } : {}),
      sameHost,
    };
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
