// =============================================================================
// sourceAdapters/claimLedger.ts — deterministic consensus over Claims.
//
// NOT an LLM. Given every claim collected for a field, this computes the
// winning value and a confidence derived from SOURCE-FAMILY DIVERSITY:
// agreement across independent families ≫ repetition within one family.
//
// The law holds here hardest of anywhere: on a genuine cross-family tie the
// reconciler returns NO consensus (null + conflict) — a gap a human or a
// research pass can close beats a coin-flip that quotes a wrong part.
// =============================================================================

import type { Claim, SourceFamily } from "./types";

/** Family base weights. A single human claim is decided before scoring. */
const FAMILY_WEIGHT: Record<SourceFamily, number> = {
  human: 100, // handled out-of-band; listed for completeness
  gov: 3,
  owners_manual: 3,
  oem_catalog: 2,
  aftermarket_catalog: 2,
  aggregator: 2,
  web_search: 1,
};

/** Confidence by DISTINCT agreeing families (not domains, not claim count). */
function confidenceFor(families: Set<SourceFamily>, totalFamilies: number): number {
  const n = families.size;
  const hasStrong = [...families].some((f) => FAMILY_WEIGHT[f] >= 2);
  let conf: number;
  if (n >= 3) conf = 0.95;
  else if (n === 2) conf = hasStrong ? 0.85 : 0.7;
  else conf = hasStrong ? 0.6 : 0.4; // single family: never quote-grade (0.75 gate)
  // Unopposed agreement is stronger than the same agreement with dissent.
  if (totalFamilies > n) conf = Math.max(0.3, conf - 0.1);
  return conf;
}

export interface ClaimConsensus {
  field_key: string;
  /** Winning normalized value, or null when no consensus is reachable. */
  value: string | null;
  confidence: number | null;
  /** Distinct families backing the winner. */
  families: SourceFamily[];
  /** Distinct domains backing the winner (across families). */
  domains: string[];
  source_urls: string[];
  /** Values that lost, with their family support — kept for audit + rivalry. */
  dissent: Array<{ value: string; families: SourceFamily[]; domains: string[] }>;
  outcome: "consensus" | "single_source" | "conflict_tie" | "no_claims" | "human";
}

type Cluster = {
  value: string;
  families: Set<SourceFamily>;
  domains: Set<string>;
  urls: Set<string>;
};

/**
 * Reconcile all claims for ONE field. Pure and order-independent: claims are
 * clustered by exact normalized value; the winner needs STRICTLY more distinct
 * family support than every rival (a tie is a conflict, not a coin flip).
 */
export function reconcileClaims(
  fieldKey: string,
  claims: readonly Claim[],
): ClaimConsensus {
  const relevant = claims.filter((c) => c.field_key === fieldKey && c.value !== "");
  if (relevant.length === 0) {
    return {
      field_key: fieldKey, value: null, confidence: null, families: [],
      domains: [], source_urls: [], dissent: [], outcome: "no_claims",
    };
  }

  // A human claim decides outright — verified_fields semantics, ledger edition.
  const human = relevant.find((c) => c.source_family === "human");
  if (human) {
    return {
      field_key: fieldKey, value: human.value, confidence: 1.0,
      families: ["human"], domains: [human.source_domain],
      source_urls: [human.source_url], dissent: [], outcome: "human",
    };
  }

  const clusters = new Map<string, Cluster>();
  for (const c of relevant) {
    let cl = clusters.get(c.value);
    if (!cl) {
      cl = { value: c.value, families: new Set(), domains: new Set(), urls: new Set() };
      clusters.set(c.value, cl);
    }
    cl.families.add(c.source_family);
    cl.domains.add(c.source_domain);
    cl.urls.add(c.source_url);
  }

  const scored = [...clusters.values()]
    .map((cl) => ({
      cl,
      // Family diversity first; family weight then domain count only break
      // ties WITHIN the same diversity level; value as the final total order
      // so the result is deterministic for identical evidence.
      score: [
        cl.families.size,
        Math.max(...[...cl.families].map((f) => FAMILY_WEIGHT[f])),
        cl.domains.size,
      ] as const,
    }))
    .sort((a, b) => {
      for (let i = 0; i < 3; i++) {
        if (a.score[i] !== b.score[i]) return b.score[i] - a.score[i];
      }
      return a.cl.value < b.cl.value ? -1 : 1;
    });

  const [winner, runnerUp] = scored;
  const totalFamilies = new Set(relevant.map((c) => c.source_family)).size;
  // Canonical ordering everywhere below — the result must be byte-identical
  // for identical evidence regardless of claim arrival order.
  const sorted = <T,>(s: Set<T>) => [...s].sort();
  const dissent = scored.slice(1).map(({ cl }) => ({
    value: cl.value,
    families: sorted(cl.families),
    domains: sorted(cl.domains),
  }));

  // Strictly-more-families rule: equal diversity AND equal best-weight is a
  // tie — no consensus. (Domain count never settles a cross-family tie:
  // storefront count is not independence.)
  if (
    runnerUp &&
    runnerUp.score[0] === winner.score[0] &&
    runnerUp.score[1] === winner.score[1]
  ) {
    return {
      field_key: fieldKey, value: null, confidence: null, families: [],
      domains: [], source_urls: [], dissent:
        scored.map(({ cl }) => ({
          value: cl.value, families: sorted(cl.families), domains: sorted(cl.domains),
        })),
      outcome: "conflict_tie",
    };
  }

  return {
    field_key: fieldKey,
    value: winner.cl.value,
    confidence: confidenceFor(winner.cl.families, totalFamilies),
    families: sorted(winner.cl.families),
    domains: sorted(winner.cl.domains),
    source_urls: sorted(winner.cl.urls),
    dissent,
    outcome: clusters.size === 1 && winner.cl.families.size === 1
      ? "single_source"
      : "consensus",
  };
}
