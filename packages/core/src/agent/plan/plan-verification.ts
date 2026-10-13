/**
 * Plan Verification checklist parsing and complete_plan gating.
 */

export interface VerificationResultItem {
  item: string;
  passed: boolean;
  evidence: string;
}

export type GateCompletePlanResult = { ok: true } | { ok: false; error: string };

const VERIFICATION_HEADING = /^\*\*Verification:\*\*\s*$/i;
const LIST_ITEM = /^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/;

/**
 * Minimum length for a NORMALIZED verification item to be usable as a key.
 *
 * `normalizeVerificationItem(" ")` is `""`, and `String.prototype.includes("")` is
 * always true — so an unbounded match lets a single `{ item: " " }` satisfy every
 * checklist line. Requiring real text on both sides closes that door.
 */
const MIN_VERIFICATION_ITEM_LENGTH = 3;

/**
 * Token-overlap (Jaccard) threshold for accepting wording drift between a result item
 * and a checklist item. Bounded on purpose: the old `k.includes(key) || key.includes(k)`
 * rule treated any one-character key as a match for everything.
 */
const VERIFICATION_TOKEN_OVERLAP = 0.5;

/**
 * Normalize a verification line for matching (trim, collapse space, strip list markers).
 */
export function normalizeVerificationItem(text: string): string {
  let t = text.trim();
  t = t.replace(/^[-*]\s+/, "");
  t = t.replace(/^\d+[.)]\s+/, "");
  t = t.replace(/^\[[ xX]\]\s+/, "");
  return t.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Whether an item names a real checklist line after normalization.
 *
 * Blank and sub-{@link MIN_VERIFICATION_ITEM_LENGTH} strings are unusable — as result
 * keys (they would match by emptiness) and as expected items (they identify nothing).
 */
function isUsableVerificationItem(text: string): boolean {
  return normalizeVerificationItem(text).length >= MIN_VERIFICATION_ITEM_LENGTH;
}

/**
 * Parse checklist items from a raw verification string (tool input).
 * Accepts markdown list lines or non-empty newline-separated lines.
 */
export function parseVerificationItemsFromText(verification: string): string[] {
  const lines = verification.split(/\r?\n/);
  const items: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const listMatch = trimmed.match(LIST_ITEM);
    if (listMatch) {
      const body = listMatch[1].trim();
      if (isUsableVerificationItem(body)) items.push(body);
      continue;
    }
    // Plain paragraph line (single-block verification without bullets)
    if (isUsableVerificationItem(trimmed) && !trimmed.startsWith("#") && !trimmed.startsWith("```")) {
      items.push(trimmed);
    }
  }
  return items;
}

/**
 * Extract Verification section body from plan markdown, then parse items.
 */
export function parseVerificationItemsFromPlanMarkdown(planMarkdown: string | null | undefined): string[] {
  if (!planMarkdown?.trim()) return [];

  const lines = planMarkdown.split(/\r?\n/);
  let inSection = false;
  const body: string[] = [];

  for (const line of lines) {
    if (VERIFICATION_HEADING.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection) {
      // Next bold section or top-level heading ends Verification
      if (/^\*\*[^*]+:\*\*\s*$/.test(line.trim()) || /^#{1,3}\s/.test(line.trim())) {
        break;
      }
      if (line.trim().startsWith("```")) {
        break;
      }
      body.push(line);
    }
  }

  return parseVerificationItemsFromText(body.join("\n"));
}

/**
 * Whether a verification string is usable for create/update_plan.
 */
export function isUsableVerification(verification: string | undefined | null): boolean {
  if (!verification?.trim()) return false;
  return parseVerificationItemsFromText(verification).length > 0;
}

/**
 * Tokenize a normalized verification item for bounded drift matching.
 *
 * Latin / alphanumeric runs stay whole (min two characters). Unspaced scripts — CJK
 * and friends — are split per character so a rewording still overlaps. A lone letter is
 * dropped: it can never identify a checklist line, so it must not be a match key.
 */
function tokenizeVerificationItem(normalized: string): string[] {
  const tokens: string[] = [];
  const re = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]{2,}/gu;
  for (const match of normalized.matchAll(re)) tokens.push(match[0]);
  return tokens;
}

/**
 * Bounded match between a normalized checklist item and a normalized result item.
 *
 * Exact, or token overlap at/above {@link VERIFICATION_TOKEN_OVERLAP}. There is no
 * unbounded substring test, so no short key can "match" by being contained in every
 * string (`String.prototype.includes("")` is always true).
 */
function verificationItemsMatch(aNorm: string, bNorm: string): boolean {
  if (aNorm === bNorm) return true;
  const a = new Set(tokenizeVerificationItem(aNorm));
  const b = new Set(tokenizeVerificationItem(bNorm));
  if (a.size === 0 || b.size === 0) return false;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union > 0 && intersection / union >= VERIFICATION_TOKEN_OVERLAP;
}

/**
 * Gate complete_plan verificationResults against the current plan markdown.
 */
export function gateCompletePlanVerification(
  planMarkdown: string | null | undefined,
  results: VerificationResultItem[] | undefined
): GateCompletePlanResult {
  if (!results || results.length === 0) {
    return { ok: false, error: "complete_plan requires verificationResults (item, passed, evidence)" };
  }

  for (const r of results) {
    if (!r.evidence?.trim()) {
      return { ok: false, error: "Each verificationResult must include non-empty evidence" };
    }
    // Reject a blank/too-short item before it can become a match key. `String.includes("")`
    // is always true, so `{ item: " " }` would otherwise satisfy the entire checklist.
    if (!isUsableVerificationItem(r.item)) {
      return {
        ok: false,
        error: `Each verificationResult.item must be at least ${MIN_VERIFICATION_ITEM_LENGTH} characters of text; got "${r.item}"`,
      };
    }
  }

  const expected = parseVerificationItemsFromPlanMarkdown(planMarkdown).filter(isUsableVerificationItem);

  // Legacy plans with no Verification section: require one passing smoke/N/A result.
  if (expected.length === 0) {
    if (results.length !== 1) {
      return {
        ok: false,
        error:
          "Plan has no Verification checklist — provide exactly one verificationResult describing smoke checks run (N/A path)",
      };
    }
    if (!results[0].passed) {
      return { ok: false, error: "Legacy N/A verificationResult must have passed: true" };
    }
    return { ok: true };
  }

  if (results.some((r) => !r.passed)) {
    return { ok: false, error: "Cannot complete_plan while any verificationResult has passed: false" };
  }

  const resultNorms = results.map((r) => normalizeVerificationItem(r.item));

  for (const exp of expected) {
    // Bounded wording-drift tolerance: exact normalized match, or token overlap at or
    // above the threshold — never an unbounded substring test.
    const key = normalizeVerificationItem(exp);
    const found = resultNorms.some((k) => verificationItemsMatch(key, k));
    if (!found) {
      return {
        ok: false,
        error: `Missing verificationResult for checklist item: "${exp}"`,
      };
    }
  }

  return { ok: true };
}
