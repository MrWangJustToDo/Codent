/**
 * The `configOptions` selectors this host advertises (mode / model / thinking depth) and the three
 * requests that write them.
 *
 * Declaration and write path are one contract: advertising a select and then answering "Method not
 * found" the moment a client touches it is a broken picker. Two rules follow from the protocol
 * shape and are enforced here rather than at every call site:
 *
 * - `ConfigOptionUpdate` has **no incremental form**, so any change re-sends the WHOLE option set
 *   (sending one entry would wipe the others out of the client's cache);
 * - a re-set of an unchanged value stays **silent** — the client's cache is already correct, and
 *   re-broadcasting is noise the user cannot act on. That is what the three `lastAdvertisedConfig*`
 *   mirrors on the bridge are for.
 */

import { methods, RequestError } from "@agentclientprotocol/sdk";

import {
  applyMode,
  applyModel,
  applyThoughtLevel,
  effortOf,
  legacySessionModelState,
  resolveAdvertisedEntryIndex,
  sessionConfigOptions,
} from "../session/session-config-options.js";

import type { AcpAgentContext } from "./context.js";
import type { AcpAgentOptions } from "./options.js";
import type { SessionBridge } from "./session-bridge.js";
import type { ConfigOptionTarget } from "../session/session-config-options.js";
import type { SessionUpdate } from "../wire/types.js";
import type { AgentMode } from "@codent/core";

/** The four values a `configOptions` advertisement carries, as the client was last told them. */
export interface ConfigMirrors {
  mode: AgentMode;
  model?: string;
  entryIndex?: number;
  effort?: string;
}

export interface ConfigSelectors {
  /**
   * Re-advertise the WHOLE option set, but only when a value actually changed.
   *
   * The entry index is compared too: switching between two entries that offer the SAME model id
   * (`0:shared` → `1:shared`) changes the connection while the model string stands still, and a
   * client whose cache said `0:shared` must be told. The thinking depth is a separate
   * `configOptions` entry and moves independently of both.
   */
  advertise: (bridge: SessionBridge, before: ConfigMirrors) => void;
  /** Record what the client's config cache now holds after a response that carried the selectors. */
  seed: (bridge: SessionBridge) => void;
  /** What the client was last told, for {@link advertise}'s comparison. */
  mirrors: (bridge: SessionBridge) => ConfigMirrors;
}

export interface ConfigSelectorsDeps {
  options: AcpAgentOptions;
  emit: (acpId: string, update: SessionUpdate) => void;
}

export function createConfigSelectors(deps: ConfigSelectorsDeps): ConfigSelectors {
  const { options, emit } = deps;

  const seed = (bridge: SessionBridge): void => {
    const snapshot = bridge.session.getSnapshot();
    bridge.lastAdvertisedConfigMode = snapshot.mode;
    bridge.lastAdvertisedConfigModel = snapshot.model;
    // The ADVERTISED entry (first match when the connection entry is unknown), not the raw record:
    // the response names an entry, and re-selecting it must not look like a change.
    bridge.lastAdvertisedConfigEntryIndex = resolveAdvertisedEntryIndex(
      options.models,
      snapshot.model,
      bridge.selectedModelEntryIndex
    );
    bridge.lastAdvertisedConfigEffort = effortOf(snapshot);
  };

  return {
    seed,
    mirrors: (bridge) => ({
      mode: bridge.lastAdvertisedConfigMode ?? bridge.session.getSnapshot().mode,
      model: bridge.lastAdvertisedConfigModel,
      entryIndex: bridge.lastAdvertisedConfigEntryIndex,
      effort: bridge.lastAdvertisedConfigEffort,
    }),
    advertise: (bridge, previous) => {
      const snapshot = bridge.session.getSnapshot();
      if (
        snapshot.mode === previous.mode &&
        snapshot.model === previous.model &&
        bridge.selectedModelEntryIndex === previous.entryIndex &&
        effortOf(snapshot) === previous.effort
      ) {
        return;
      }
      bridge.lastAdvertisedConfigMode = snapshot.mode;
      bridge.lastAdvertisedConfigModel = snapshot.model;
      bridge.lastAdvertisedConfigEntryIndex = resolveAdvertisedEntryIndex(
        options.models,
        snapshot.model,
        bridge.selectedModelEntryIndex
      );
      bridge.lastAdvertisedConfigEffort = effortOf(snapshot);
      emit(bridge.acpId, {
        sessionUpdate: "config_option_update",
        configOptions: sessionConfigOptions(snapshot, options.models, bridge.selectedModelEntryIndex),
      });
    },
  };
}

/** The {@link ConfigOptionTarget} shape the shared write helpers act on. */
function toTarget(bridge: SessionBridge): ConfigOptionTarget {
  return { session: bridge.session, acpId: bridge.acpId };
}

/**
 * Register the write side of the selectors we advertise: `session/set_mode`,
 * `session/set_config_option`, and the legacy `session/set_model` older pickers still call.
 *
 * `session/set_config_option` dispatches on the option's CATEGORY, looked up in the set we
 * advertise — never on a literal id, and never assuming "the only option is mode" (which sent a
 * model id through `mode.set`, reporting success for a change that never took effect).
 */
export function registerConfigOptionRequests(ctx: AcpAgentContext): void {
  const { app, options, bridges, config } = ctx;

  app.onRequest(methods.agent.session.setMode, async (request) => {
    const bridge = bridges.find(request.params.sessionId);
    // Reject, like every other handler that must CHANGE something: reporting success for a session
    // we never touched is a lie the client cannot detect. (`close` is allowed to tolerate absence —
    // there the desired state is already true, so "ok" is honest. Here it is not.)
    if (!bridge) throw RequestError.invalidParams(undefined, `Unknown session: ${request.params.sessionId}`);
    const before = config.mirrors(bridge);
    await applyMode(toTarget(bridge), request.params.modeId as AgentMode);
    config.advertise(bridge, before);
    return {};
  });

  app.onRequest(methods.agent.session.setConfigOption, async (request) => {
    const bridge = bridges.find(request.params.sessionId);
    if (!bridge) throw RequestError.invalidParams(undefined, `Unknown session: ${request.params.sessionId}`);

    // Look the id up in the SET WE ADVERTISE rather than comparing against a literal: adding an
    // option later must not leave this check behind (a hardcoded id would reject the new one).
    const option = sessionConfigOptions(
      bridge.session.getSnapshot(),
      options.models,
      bridge.selectedModelEntryIndex
    ).find((entry) => entry.id === request.params.configId);
    if (!option) {
      throw RequestError.invalidParams(undefined, `Unknown configuration option: ${request.params.configId}`);
    }

    const before = config.mirrors(bridge);
    switch (option.category) {
      case "mode":
        await applyMode(toTarget(bridge), request.params.value as AgentMode);
        break;
      case "model": {
        const applied = await applyModel(
          toTarget(bridge),
          request.params.value as string,
          options.models,
          bridge.selectedModelEntryIndex
        );
        // Record the entry the connection came from, so every later advertisement names it instead
        // of first-matching a model id that several entries may share. A bare re-selection of the
        // current model reports no entry and leaves the recorded one alone.
        if (applied.entryIndex !== undefined) bridge.selectedModelEntryIndex = applied.entryIndex;
        break;
      }
      case "thought_level":
        await applyThoughtLevel(toTarget(bridge), request.params.value as string);
        break;
      default:
        // No third option is advertised, so an unhandled category is a real gap. Swallow it and the
        // client's selector silently stops meaning anything.
        throw RequestError.invalidRequest(
          undefined,
          `Configuration option "${option.id}" has no write path (category: ${option.category})`
        );
    }
    config.advertise(bridge, before);

    // Protocol requires the FULL set back (there is no incremental form), read after the change.
    return {
      configOptions: sessionConfigOptions(bridge.session.getSnapshot(), options.models, bridge.selectedModelEntryIndex),
    };
  });

  // Legacy model selection. The current protocol dropped `session/set_model` in favour of a
  // `configOptions` entry with `category: "model"`, but clients that still speak the older API call
  // it — and one that only reads `models` had no picker at all. Same `applyModel` as
  // `session/set_config_option`, so neither surface can drift from the other.
  //
  // Cast: this protocol version removed the method from its handler map, so there is no keyed entry
  // to type against — but the SDK accepts a custom method with its own params parser, and the wire
  // has no restriction at all. The clients that call it are exactly the ones this exists for.
  const onLegacyRequest = app.onRequest.bind(app) as unknown as (
    method: string,
    parser: (params: unknown) => { sessionId: string; modelId: string },
    handler: (request: { params: { sessionId: string; modelId: string } }) => Promise<Record<string, unknown>>
  ) => void;
  onLegacyRequest(
    "session/set_model",
    (params) => {
      const record = params as { sessionId?: unknown; modelId?: unknown };
      if (typeof record?.sessionId !== "string" || typeof record?.modelId !== "string") {
        throw RequestError.invalidParams(undefined, "session/set_model requires sessionId and modelId");
      }
      return { sessionId: record.sessionId, modelId: record.modelId };
    },
    async (request) => {
      const bridge = bridges.find(request.params.sessionId);
      if (!bridge) throw RequestError.invalidParams(undefined, `Unknown session: ${request.params.sessionId}`);
      const before = config.mirrors(bridge);
      const applied = await applyModel(
        toTarget(bridge),
        request.params.modelId,
        options.models,
        bridge.selectedModelEntryIndex
      );
      if (applied.entryIndex !== undefined) bridge.selectedModelEntryIndex = applied.entryIndex;
      // Older clients only read `models` / call `session/set_model`; they still need the
      // `configOptions` cache refreshed, or a client rendering both surfaces shows the old value.
      config.advertise(bridge, before);
      const snapshot = bridge.session.getSnapshot();
      const models = legacySessionModelState(options.models, snapshot.model, bridge.selectedModelEntryIndex);
      // The legacy response carries the updated state itself: a client whose picker is driven by
      // `models` updates from THIS frame, and an empty `{}` left it showing the previous model.
      return {
        configOptions: sessionConfigOptions(snapshot, options.models, bridge.selectedModelEntryIndex),
        ...(models ? { models } : {}),
      };
    }
  );
}
