/**
 * serviceMatch.ts — normalisation + fuzzy matching behind the custom-job
 * "match gate" (Off-Catalog Work spec, §2 Leak 2).
 *
 * WHY THIS EXISTS
 * A mechanic who can't find "Transmission Fluid Exchange" in the picker types
 * it as a custom job. Real maintenance then happened, but because custom work
 * can never write a maintenance anchor (see the CUSTOM JOB INVARIANT comments
 * in bookings.ts and jobRecommendations.ts), the driver's health score decays
 * and we eventually remind them to redo a service they already paid for.
 *
 * The gate catches that at ENTRY — before a custom job or freeform rec exists —
 * by matching what was typed against canonical service names, slugs and aliases.
 *
 * Pure functions only: no ctx, no db. Callers do the reads and hand us rows.
 *
 * ── TWO NORMALISERS, DELIBERATELY ────────────────────────────────────────────
 *   normalizeServiceName  Byte-compatible with the normaliser that has been
 *                         writing `pending_service_submissions.normalized_name`
 *                         since that table shipped (lowercase + trim + collapse
 *                         whitespace, nothing else). DO NOT "improve" it —
 *                         existing rows are keyed on its exact output, and
 *                         changing it silently orphans every one of them.
 *
 *   serviceMatchKey       Aggressive, and only ever used for MATCHING: strips
 *                         punctuation, drops noise words, singularises and
 *                         sorts tokens. Never stored as an identity for
 *                         pre-existing rows.
 */

/**
 * Stable normaliser for `pending_service_submissions.normalized_name`.
 * Frozen by compatibility — see the header note.
 */
export function normalizeServiceName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Words that carry no discriminating signal in a service name. "Oil Change"
 * and "Oil Change Service" are the same thing; "Brake Pad Replacement" and
 * "Replace Brake Pads" are too. Dropping these lets the token comparison work
 * on the nouns that actually differ.
 */
const NOISE_TOKENS = new Set([
  "a",
  "an",
  "and",
  "complete",
  "for",
  "full",
  "job",
  "of",
  "on",
  "plus",
  "repair",
  "replace",
  "replacement",
  "service",
  "standard",
  "the",
  "to",
  "w",
  "with",
  "work",
]);

/** Crude singulariser — enough for service nouns ("pads" → "pad"). Left alone
 *  below four characters so "gas" and "abs" survive intact. */
function singularise(token: string): string {
  if (token.length < 4) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ses") || token.endsWith("xes") || token.endsWith("zes")) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/** Tokenise into the comparable content words of a service name. */
export function serviceTokens(name: string): string[] {
  const cleaned = name
    .toLowerCase()
    // Keep alphanumerics; everything else (slashes, hyphens, parens, &) splits.
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!cleaned) return [];
  const out: string[] = [];
  for (const raw of cleaned.split(" ")) {
    if (!raw) continue;
    const token = singularise(raw);
    if (NOISE_TOKENS.has(token) || NOISE_TOKENS.has(raw)) continue;
    out.push(token);
  }
  // Every noise word stripped ("service", "the job") — fall back to the
  // cleaned form so the name still has *some* key rather than matching
  // every other all-noise string.
  if (out.length === 0) return cleaned.split(" ").filter(Boolean);
  return out;
}

/**
 * Order-insensitive matching key. "Replace Brake Pads" and "Brake Pad
 * Replacement" both key to "brake pad".
 */
export function serviceMatchKey(name: string): string {
  return Array.from(new Set(serviceTokens(name))).sort().join(" ");
}

/**
 * Do two tokens refer to the same thing? Exact match, or one is a prefix of the
 * other and the shorter is at least four characters.
 *
 * The prefix rule exists for shop shorthand: a mechanic types "trans fluid
 * change", the catalog says "Transmission Service", and a pure set comparison
 * shares nothing at all — a total miss, which is the one failure mode this gate
 * cannot afford. Four characters is the floor because below it the rule starts
 * folding unrelated short words together.
 */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/**
 * Sørensen–Dice over token sets, with prefix-aware pairing. Chosen over edit
 * distance because service names differ by whole words far more often than by
 * typos, and because it is symmetric — "brake pad" vs "front brake pad rotor"
 * scores the same whichever way the comparison is written.
 *
 * Pairing is greedy and each token can only be consumed once, so a repeated
 * token can't inflate the overlap count.
 */
export function tokenSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = Array.from(new Set(a));
  const setB = Array.from(new Set(b));
  const taken = new Array<boolean>(setB.length).fill(false);

  let shared = 0;
  for (const token of setA) {
    // Prefer an exact partner before falling back to a prefix one, so
    // "brake"/"brakes" doesn't get consumed by "brake_pad" first.
    let hit = setB.findIndex((other, i) => !taken[i] && other === token);
    if (hit === -1) {
      hit = setB.findIndex((other, i) => !taken[i] && tokensMatch(token, other));
    }
    if (hit !== -1) {
      taken[hit] = true;
      shared += 1;
    }
  }
  return (2 * shared) / (setA.length + setB.length);
}

export type MatchConfidence = "exact" | "high" | "medium" | "none";

/**
 * Thresholds. `HIGH` is where we pre-select the canonical service and make the
 * mechanic opt OUT; `MEDIUM` is where we ask. Both are deliberately generous —
 * the cost of an unnecessary question is one tap, and the cost of a miss is a
 * driver quietly penalised for months.
 */
export const MATCH_HIGH = 0.8;
export const MATCH_MEDIUM = 0.5;

export type MatchCandidateInput = {
  serviceId: string;
  name: string;
  slug?: string | null;
  /** Alias strings already resolved to this service, if any. */
  aliases?: string[];
};

export type MatchCandidate = {
  serviceId: string;
  name: string;
  score: number;
  /** Which comparison produced the score — surfaced so the UI can say
   *  "you've linked this name before" rather than a bare percentage. */
  via: "alias" | "name" | "slug";
};

export type MatchVerdict = {
  confidence: MatchConfidence;
  /** Best candidate, or null when nothing cleared MATCH_MEDIUM. */
  best: MatchCandidate | null;
  /** Best-first, already filtered to >= MATCH_MEDIUM and capped by the caller. */
  candidates: MatchCandidate[];
};

/**
 * Score a typed name against the canonical catalog.
 *
 * An alias hit is always `exact`: somebody has already made this exact judgement
 * by hand, and second-guessing it would undo the cleanup work that the alias
 * represents.
 */
export function matchServiceName(
  typed: string,
  catalog: MatchCandidateInput[],
): MatchVerdict {
  const typedTokens = serviceTokens(typed);
  const typedKey = serviceMatchKey(typed);

  if (typedTokens.length === 0) {
    return { confidence: "none", best: null, candidates: [] };
  }

  const scored: MatchCandidate[] = [];

  for (const entry of catalog) {
    let best: MatchCandidate | null = null;

    const consider = (score: number, via: MatchCandidate["via"]) => {
      if (best && best.score >= score) return;
      best = { serviceId: entry.serviceId, name: entry.name, score, via };
    };

    for (const alias of entry.aliases ?? []) {
      if (serviceMatchKey(alias) === typedKey) {
        consider(1, "alias");
        break;
      }
      consider(tokenSimilarity(typedTokens, serviceTokens(alias)), "alias");
    }

    if (serviceMatchKey(entry.name) === typedKey) {
      consider(1, "name");
    } else {
      consider(tokenSimilarity(typedTokens, serviceTokens(entry.name)), "name");
    }

    // Slugs are snake_case ("brake_pad_replacement") — tokenising handles the
    // underscore, so this catches a mechanic typing the slug itself.
    if (entry.slug) {
      if (serviceMatchKey(entry.slug) === typedKey) {
        consider(1, "slug");
      } else {
        consider(tokenSimilarity(typedTokens, serviceTokens(entry.slug)), "slug");
      }
    }

    if (best) scored.push(best);
  }

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.filter((c) => c.score >= MATCH_MEDIUM);
  const best = candidates[0] ?? null;

  let confidence: MatchConfidence = "none";
  if (best) {
    if (best.score >= 1) confidence = "exact";
    else if (best.score >= MATCH_HIGH) confidence = "high";
    else if (best.score >= MATCH_MEDIUM) confidence = "medium";
  }

  return { confidence, best, candidates };
}
