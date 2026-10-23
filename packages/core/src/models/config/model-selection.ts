/**
 * Whose model choice wins when a plane (or a provider) already serves one.
 *
 * A model plane can carry two model identities at once: the one a CLIENT asked for (a `/models`
 * pick, a `--model` flag, the model a resumed session was saved with) and the one the plane
 * itself offers (a remote provider's served model, or the fallback a host resolved at bootstrap).
 * This module is the single rule for picking between them, so bootstrap
 * (`resolveModelConfigFromProvider`), the catalog read (`loadModels`) and session resume
 * (`ManagedAgent.applyPersistedModel`) cannot disagree about which model a session is on.
 *
 * The rule:
 * - a request the plane can VERIFY as selectable wins (`allowed.includes(requested)`);
 * - a request the plane cannot verify — no catalog, or a catalog that lists nothing — is
 *   trusted, because "we could not check" is not evidence the client is wrong;
 * - a request the plane positively does not offer falls back instead of being sent to be
 *   rejected (`model_not_allowed` from the provider proxy is diagnosable, but a session that
 *   silently runs a model the user did not pick is not the fallback anyone wants);
 * - with no request, the fallback IS the answer.
 */

// ============================================================================
// Types
// ============================================================================

export interface ModelSelectionRequest {
  /** What the client asked to run (menu pick, flag, persisted session model). */
  requested?: string | null;
  /** What the plane serves when the request is not selectable (a remote provider's model). */
  fallback?: string | null;
  /**
   * Selectable model ids the plane advertises.
   *
   * `undefined` / empty means "the plane cannot be asked", which makes the request trusted
   * rather than dropped — a direct provider has no allowlist at all, and a remote server that
   * advertises no list is not evidence that the requested model is unavailable.
   */
  allowed?: readonly string[] | null;
}

export interface ModelSelection {
  /** The model the session should run — the request when it is selectable, else the fallback. */
  model: string;
  /**
   * Set when a request was DROPPED, so a caller can log it. Never set for a request that was
   * accepted: a silent acceptance needs no report, and reporting it would make every bootstrap
   * log look like something went wrong.
   */
  fallback?: { requested: string; model: string };
}

// ============================================================================
// Selection
// ============================================================================

/** Pick the model a session should run. See the module doc for the rule and its reasons. */
export function selectModel({ requested, fallback, allowed }: ModelSelectionRequest): ModelSelection {
  const request = requested?.trim() ?? "";
  const served = fallback?.trim() ?? "";
  // Blank ids (a hand-written `models.json` with an empty entry) are not selectable candidates:
  // counting one would turn "cannot verify" into "verified as unavailable" and drop a valid pick.
  const selectable = (allowed ?? []).map((id) => id.trim()).filter(Boolean);

  if (request && (selectable.length === 0 || selectable.includes(request))) {
    return { model: request };
  }
  if (served) {
    return request ? { model: served, fallback: { requested: request, model: served } } : { model: served };
  }
  // Nothing to fall back to: the request is the only model we know about.
  return { model: request };
}
