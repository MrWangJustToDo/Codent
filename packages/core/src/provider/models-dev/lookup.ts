/**
 * models.dev lookup — resolve one model id against the catalog and rank competing vendor entries.
 *
 * Pure ranking plus one cached fetch. The tie-break tiers (metadata richness → named depth levels
 * → vendor identity) are documented on their functions; they are ordering rules, never filters.
 */

import { fetchModelsDev } from "./cache.js";
import { namedEffortValues, parseModelsDevModel } from "./parse.js";

import type { ModelsDevModel } from "./types.js";
import type { ModelInfo, ModelStyle } from "../../models/types.js";

/**
 * Look up a single model by ID from the models.dev dataset.
 *
 * Lookup strategies (first match wins):
 * 1. Prefixed: `"anthropic/claude-opus-4-8"` → search provider `anthropic`
 *    for model `claude-opus-4-8`.
 * 2. Hint-based: if `styleHint` is `"anthropic"`, search the anthropic vendor only.
 * 3. Bare: search all vendors by the bare model id (prefix stripped).
 *
 * @param modelId The model identifier to look up (may be prefixed).
 * @param styleHint Optional {@link ModelStyle} to narrow the search.
 * @returns The resolved {@link ModelInfo}, or `undefined` if not found.
 */
export async function lookupModelFromModelsDev(
  modelId: string,
  styleHint?: ModelStyle
): Promise<ModelInfo | undefined> {
  const data = await fetchModelsDev();

  // Split "provider/model" once so all strategies can reuse the bare id.
  // e.g. "zhipu/glm-5.2" → provPart="zhipu", bareId="glm-5.2"
  const slashIdx = modelId.indexOf("/");
  const provPart = slashIdx >= 0 ? modelId.slice(0, slashIdx) : undefined;
  const bareId = slashIdx >= 0 ? modelId.slice(slashIdx + 1) : modelId;

  // 1. Prefixed lookup: "provider/model" — exact provider match.
  if (provPart) {
    const provData = data[provPart];
    const modelData = provData?.models?.[bareId] ?? provData?.models?.[modelId];
    if (modelData) {
      return parseModelsDevModel(provPart, bareId, modelData);
    }
  }

  // 2. Hint-based lookup — anthropic style maps to the anthropic vendor on models.dev.
  if (styleHint === "anthropic") {
    const provData = data.anthropic;
    const modelData = provData?.models?.[bareId] ?? provData?.models?.[modelId];
    if (modelData) {
      return parseModelsDevModel("anthropic", bareId, modelData);
    }
  }

  // 3. Bare lookup — search all providers by the bare model id.
  //    This catches cases where the user's provider prefix differs from
  //    models.dev (e.g. "zhipu/glm-5.2" → models.dev has it under "zai").
  //    Multiple providers may carry the same model id; pick the one with the
  //    richest metadata so contextWindow / pricing / capabilities are accurate.
  //    Ties go to the entry that can actually describe the model's thinking depths
  //    (`compareModelEntries`) instead of to whichever key came first.
  const bareMatches: Array<{ provId: string; modelData: ModelsDevModel; score: number }> = [];
  for (const [provId, provData] of Object.entries(data)) {
    const modelData = provData.models?.[bareId] ?? provData.models?.[modelId];
    if (!modelData) continue;
    bareMatches.push({ provId, modelData, score: scoreModelEntry(modelData) });
  }
  if (bareMatches.length > 0) {
    bareMatches.sort(compareModelEntries);
    const best = bareMatches[0]!;
    return parseModelsDevModel(best.provId, bareId, best.modelData);
  }

  return undefined;
}

/**
 * Score a models.dev model entry by metadata richness. Higher is better.
 *
 * Used to pick the best match when the same model id appears under multiple
 * providers (e.g. `glm-5.2` is listed under `zai`, `zhipuai`, `siliconflow`,
 * …). We prefer entries that have:
 *   - non-zero pricing (real paid providers tend to have complete metadata)
 *   - a context window
 *   - an output limit
 *   - capability flags (reasoning, tool_call, …)
 *
 * Entries with zero pricing (free / coding-plan tiers) rank below paid ones
 * because their metadata is sometimes incomplete.
 *
 * Deliberately does NOT score advertised effort levels — see {@link compareModelEntries} for why that
 * belongs in the tie-break instead.
 */
function scoreModelEntry(data: ModelsDevModel): number {
  let score = 0;
  // Pricing — non-zero pricing signals a real paid listing with full metadata.
  if (data.cost) {
    const hasInput = data.cost.input !== undefined && data.cost.input > 0;
    const hasOutput = data.cost.output !== undefined && data.cost.output > 0;
    if (hasInput && hasOutput) score += 100;
    else if (hasInput || hasOutput)
      score += 50; // zero-price but present
    else score += 10; // cost object exists but all zero/missing
  }
  if (data.limit?.context) score += 20;
  if (data.limit?.output) score += 10;
  if (data.reasoning !== undefined) score += 5;
  if (data.tool_call !== undefined) score += 5;
  if (data.attachment !== undefined) score += 5;
  if (data.structured_output !== undefined) score += 5;
  if (data.modalities) score += 5;
  if (data.knowledge) score += 2;
  if (data.release_date) score += 2;
  return score;
}

/**
 * Rank two provider entries for the SAME model id: metadata richness first, then whether the entry can
 * describe thinking depths at all.
 *
 * Ties used to fall through to `Object.entries` order, which is payload key order — so which entry a
 * bare model id resolved to was effectively arbitrary. That was invisible while every reasoning model
 * got a depth menu, and became visible once `/models` started offering depths strictly (positive
 * evidence: `reasoning` AND a non-empty `effortValues`, see `offerableReasoningEfforts`): a
 * toggle-only entry now means NO depth submenu, while its equally-scored sibling advertises
 * `["low","high","max"]` for the same model. Measured over the cached catalog: **230** model ids
 * resolved to a level-less winner while an equally-scored sibling had levels, and this tie-break
 * recovers **206** of them.
 *
 * The tie-break is a BOOLEAN (has named levels / has none), never a comparison of how many or which —
 * that distinction is load-bearing and was caught by measurement. Ranking by level COUNT also moved
 * models that already had a menu, e.g. `deepseek/deepseek-v4.1-flash` went from `["low","high"]`
 * (aimlapi) to the full seven (llmgateway): both tied on metadata, so "more levels wins" rewrote a
 * working menu into one claiming `medium`/`xhigh`/`max` that the model may reject upstream. Two
 * catalogs disagreeing about a level set is not evidence that the larger set is right, and the only
 * defect worth fixing here is a model losing its menu entirely — so entries that both advertise levels
 * stay tied, and the existing order decides. That keeps the change strictly additive: no model's
 * available depths become a different SET than before, only empty ones (206) gain the set their sibling
 * already documented.
 *
 * Not a weight, either: `scoreModelEntry` must keep ranking metadata richness on its own, or a bare
 * entry that merely advertises levels would outrank a fully-described paid listing.
 *
 * Third tier — {@link makerRank}: equal score + equal level evidence still leaves up to two dozen
 * vendor entries, and they disagree about PRICE (not about the model). The maker's own listing wins;
 * everything else stays in payload order.
 */
function compareModelEntries(
  a: { provId: string; modelData: ModelsDevModel; score: number },
  b: { provId: string; modelData: ModelsDevModel; score: number }
): number {
  if (a.score !== b.score) return b.score - a.score;
  const aHasLevels = namedEffortValues(a.modelData).length > 0;
  const bHasLevels = namedEffortValues(b.modelData).length > 0;
  if (aHasLevels !== bHasLevels) return bHasLevels ? 1 : -1;
  // Ties beyond this point stay in payload order on purpose: re-ordering them would also move which
  // entry's DEPTH LIST wins, and a working menu must not change just because vendors are compared
  // differently (the corpus check in `validate:models-dev-lookup` pins that).
  return makerRank(a.provId, a.modelData) - makerRank(b.provId, b.modelData);
}

/**
 * Rank a provider entry by whether its vendor IS the model's maker (`0`) or a reseller (`1`).
 *
 * The same model id is listed by the maker and by up to two dozen resellers, and PRICE is the one
 * field where they legitimately disagree: `deepseek-v4.1-flash` is listed at cache-read `$0.0027`
 * by one gateway and `$0.15` by another — a 55× spread on identical tokens, measured against this
 * repo's own usage ledger, which had already priced one session at 13 different vendors' rates.
 * Richness cannot separate them (they carry the same fields, so 22 of 25 tied at one score), so
 * before this tier the winner was whatever the payload listed first and a session's displayed cost
 * moved by ~10× across restarts.
 *
 * models.dev publishes model LINES in `family` (`deepseek-flash`, `claude-sonnet`, `glm-flash`), not
 * vendors, so the brand is the leading token: `deepseek-flash` → `deepseek`. When it names a vendor,
 * that vendor publishes the model itself and its price is the author's price. When nothing matches
 * (e.g. `claude-sonnet` vs vendor `anthropic`) every candidate ranks `1` — no opinion — because this
 * is a tie-break, not a filter, and "an unknown maker means no price at all" is a pricing-source
 * decision, not a ranking one.
 *
 * The bare-id prefix is deliberately NOT repeated here: strategy 1 already resolves `vendor/model`
 * against that vendor before this comparator runs, so a prefix preference here could never fire.
 */
function makerRank(provId: string, modelData: ModelsDevModel): number {
  const family = modelData.family?.trim().toLowerCase();
  if (!family) return 1;
  const brand = family.split(/[-_:]/)[0];
  const vendor = provId.toLowerCase();
  return vendor === family || vendor === brand ? 0 : 1;
}
