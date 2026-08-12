// =============================================================================
// sourceAdapters/claimLedger.ts — deterministic consensus over Claims.
//
// NOT an LLM. Given every claim collected for a field, this computes the
// winning value and a confidence derived from SOURCE-FAMILY DIVERSITY:
// agreement across independent families ≫ repetition within one family.
//
// WITHIN a family the unit of independence is the OPERATOR, not the hostname.
// Four hostnames run off one catalog backend are one voice however many
// storefronts they publish under; counting them as four would manufacture
// consensus on exactly the fields (fitment) this ledger exists to harden.
//
// The law holds here hardest of anywhere: on a genuine cross-family tie the
// reconciler returns NO consensus (null + conflict) — a gap a human or a
// research pass can close beats a coin-flip that quotes a wrong part.
// =============================================================================

import type { Claim, SourceFamily } from "./types";

// ============================================================================
// Operator resolution
// ============================================================================

/**
 * Two-label public suffixes. Without this a naive "last two labels" rule
 * resolves `a.co.uk` and `b.co.uk` both to the operator "co.uk" and fuses two
 * unrelated sources into one voice — an over-collapse that silently destroys
 * real corroboration, which is as wrong as the under-collapse we are fixing.
 */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "me.uk", "com.au", "net.au", "co.nz", "co.jp",
  "co.kr", "com.br", "com.mx", "com.tr", "co.za", "com.cn", "co.in",
]);

type OperatorRule = {
  operator: string;
  /** Anchored on a label boundary so a lookalike suffix cannot claim it. */
  hostPatterns: readonly RegExp[];
  /** Exact registrable domains — the enumerable tail: the platform's own
   *  domain plus each white-label storefront we have positively confirmed. */
  domains: readonly string[];
};

/**
 * Who actually RUNS a storefront, independent of how many hostnames they
 * publish under. Evidence (verified Jul 30 2026):
 *
 *   - toyotapartsdeal.com, fordpartsgiant.com, nissanpartsdeal.com and
 *     gmpartsgiant.com are ONE operator — the footer reads "by Original Parts
 *     Giant, Inc." and all four serve byte-identical HTML from the identical
 *     undocumented endpoint. The naming spans makes (bmwpartsdeal.com,
 *     hyundaipartsdeal.com, audipartsdeal.com …), so the family is matched by
 *     shape rather than enumerated — the same host gate partIndex.ts uses for
 *     the partsdeal url grammar.
 *
 *   - Every RevolutionParts dealer storefront shares ONE catalog backend:
 *     *.oempartsonline.com plus thousands of dealer-branded domains.
 *
 * LIMIT, stated plainly: a RevolutionParts dealer domain carries no signature
 * in its hostname (the platform's tell is the `/oem-parts/` path, which a
 * hostname does not have), so those can only be enumerated in `domains` as we
 * confirm them. An unconfirmed domain resolves to itself and still counts as
 * its own voice. We do NOT collapse on suspicion: erasing corroboration we
 * genuinely have is its own present-but-wrong. The exposure is bounded —
 * operator count is a tiebreak WITHIN one family and one weight, and that
 * bucket already yields no consensus at all (see reconcileClaims).
 *
 * Adding a confirmed sibling is a one-line edit here.
 */
const OPERATOR_TABLE: readonly OperatorRule[] = [
  {
    operator: "original_parts_giant",
    hostPatterns: [/(^|\.)[a-z0-9-]*parts(giant|deal)\.com$/],
    domains: [],
  },
  {
    // No shared hostname shape to match on, so this operator is enumerated.
    // A registrable-domain entry already covers every subdomain under it, which
    // is what folds all of *.oempartsonline.com into one voice.
    operator: "revolutionparts",
    hostPatterns: [],
    domains: ["oempartsonline.com"],
  },
];

/** A claim carries a hostname, but a mis-shaped one must still resolve to a
 *  stable key rather than throw — this reconciler never fails on input shape. */
function normalizeHost(domain: string): string {
  let host = (domain ?? "").trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split(/[/?#]/)[0];
  host = host.split("@").pop() ?? host;
  host = host.replace(/:\d+$/, "");
  return host.replace(/^\.+|\.+$/g, "");
}

function registrableDomain(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_LABEL_SUFFIXES.has(lastTwo)
    ? labels.slice(-3).join(".")
    : lastTwo;
}

/**
 * Hostname → OPERATOR id. Pure, total, and never throws. Unmapped hosts get
 * their own registrable domain, so an ordinary independent source is its own
 * operator and nothing about existing behaviour changes for it.
 */
export function resolveOperator(domain: string): string {
  const host = normalizeHost(domain);
  if (!host) return "";
  const registrable = registrableDomain(host);
  for (const rule of OPERATOR_TABLE) {
    if (rule.domains.includes(registrable)) return rule.operator;
    if (rule.hostPatterns.some((p) => p.test(host))) return rule.operator;
  }
  return registrable;
}

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
  /** Distinct OPERATORS backing the winner — the within-family voice count. */
  operators: string[];
  /** Distinct domains backing the winner (across families). Audit only: a
   *  storefront count never scores, but the record must show what was read. */
  domains: string[];
  source_urls: string[];
  /** Values that lost, with their family support — kept for audit + rivalry. */
  dissent: Array<{
    value: string;
    families: SourceFamily[];
    operators: string[];
    domains: string[];
  }>;
  outcome: "consensus" | "single_source" | "conflict_tie" | "no_claims" | "human";
}

type Cluster = {
  value: string;
  families: Set<SourceFamily>;
  operators: Set<string>;
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
      operators: [], domains: [], source_urls: [], dissent: [],
      outcome: "no_claims",
    };
  }

  // A human claim decides outright — verified_fields semantics, ledger edition.
  const human = relevant.find((c) => c.source_family === "human");
  if (human) {
    return {
      field_key: fieldKey, value: human.value, confidence: 1.0,
      families: ["human"], operators: [resolveOperator(human.source_domain)],
      domains: [human.source_domain],
      source_urls: [human.source_url], dissent: [], outcome: "human",
    };
  }

  const clusters = new Map<string, Cluster>();
  for (const c of relevant) {
    let cl = clusters.get(c.value);
    if (!cl) {
      cl = {
        value: c.value, families: new Set(), operators: new Set(),
        domains: new Set(), urls: new Set(),
      };
      clusters.set(c.value, cl);
    }
    cl.families.add(c.source_family);
    cl.operators.add(resolveOperator(c.source_domain));
    cl.domains.add(c.source_domain);
    cl.urls.add(c.source_url);
  }

  const scored = [...clusters.values()]
    .map((cl) => ({
      cl,
      // Family diversity first; family weight then OPERATOR count only break
      // ties WITHIN the same diversity level; value as the final total order
      // so the result is deterministic for identical evidence.
      //
      // Operators are counted across the whole cluster, not per family: one
      // operator reaching us through two families is still one operator, and
      // counting it once is the conservative direction. Family counting itself
      // is deliberately untouched — cross-family behaviour is frozen.
      score: [
        cl.families.size,
        Math.max(...[...cl.families].map((f) => FAMILY_WEIGHT[f])),
        cl.operators.size,
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
    operators: sorted(cl.operators),
    domains: sorted(cl.domains),
  }));

  // Strictly-more-families rule: equal diversity AND equal best-weight is a
  // tie — no consensus. UNCHANGED, and note what it means for score[2]: the
  // top ([0],[1]) bucket either holds one cluster, which wins outright, or
  // several, which is a tie. So operator count orders the audit record and
  // never elects a winner — the same guarantee domain count had, now with
  // sibling storefronts no longer inflating the count they feed.
  if (
    runnerUp &&
    runnerUp.score[0] === winner.score[0] &&
    runnerUp.score[1] === winner.score[1]
  ) {
    return {
      field_key: fieldKey, value: null, confidence: null, families: [],
      operators: [], domains: [], source_urls: [], dissent:
        scored.map(({ cl }) => ({
          value: cl.value, families: sorted(cl.families),
          operators: sorted(cl.operators), domains: sorted(cl.domains),
        })),
      outcome: "conflict_tie",
    };
  }

  return {
    field_key: fieldKey,
    value: winner.cl.value,
    confidence: confidenceFor(winner.cl.families, totalFamilies),
    families: sorted(winner.cl.families),
    operators: sorted(winner.cl.operators),
    domains: sorted(winner.cl.domains),
    source_urls: sorted(winner.cl.urls),
    dissent,
    outcome: clusters.size === 1 && winner.cl.families.size === 1
      ? "single_source"
      : "consensus",
  };
}
