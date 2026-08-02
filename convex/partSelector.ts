/**
 * convex/partSelector.ts — Pure 7-layer part selection algorithm.
 *
 * Picks exactly one winner from a pool of fitment candidates per (vehicle, service).
 * Deterministic: same input → same output, always. The trace surfaces *why* a
 * candidate won so the mechanic / director side can audit and override.
 *
 * Layer order is fitment-first: we'd rather quote a confident, OEM-quality
 * part with weaker price data than a well-priced part we're less sure fits.
 *   0 mechanic_verified (short-circuit)
 *   refute demotion (round 9: verifier-refuted-but-kept parts lose to any
 *        unflagged rival)
 *   gate confidence ≥ threshold (drops low-conf; falls back to full pool if
 *        none clear, and flags low_confidence)
 *   1 fitment confidence
 *   2 data quality (oem > dealer > aftermarket > generic)
 *   3 OEM-catalog fitment attestation (round 9: catalog authority outranks
 *        price presence — priced-ness is availability, not fitment truth)
 *   4 price source count
 *   5 price stability (CV)
 *   6 recency
 *   7 median-price proximity
 *   8 lexicographic (always decisive)
 *
 * No Convex imports here. Callers (serviceParts.ts, booking_quotes.ts) hydrate
 * candidates from part_fitments + part_prices and pass them in. Keeps this module
 * unit-testable without spinning up a Convex env.
 */
import type { Id } from "./_generated/dataModel";
import { matchesForeignBrandSignature } from "./vehicleEnrichment/contentSanitization";

export type DataQuality = "oem" | "dealer" | "aftermarket" | "generic";

export const QUALITY_RANK: Record<DataQuality, number> = {
  oem: 0,
  dealer: 1,
  aftermarket: 2,
  generic: 3,
};

const KNOWN_QUALITIES = new Set<DataQuality>(["oem", "dealer", "aftermarket", "generic"]);

export function normalizeDataQuality(raw: string | undefined | null): DataQuality {
  if (!raw) return "generic";
  const lower = raw.toLowerCase().trim();
  if (KNOWN_QUALITIES.has(lower as DataQuality)) return lower as DataQuality;
  if (lower === "high") return "oem";
  if (lower === "medium") return "aftermarket";
  if (lower === "low") return "generic";
  return "generic";
}

/**
 * I1 make guard — does an OEM part belong on a vehicle of this make?
 *
 * A part fits when EITHER it carries no make at all (universal consumables —
 * generic oil filters, engine oil, wiper blades legitimately have
 * `make_id == null`), OR the config's make is unknown (we can't prove a
 * mismatch, so we don't filter), OR the part's make equals the config's make.
 *
 * A part with a SET `make_id` that disagrees with the config's make is a
 * cross-make contaminant — e.g. a Ford brake pad cloned onto an Alfa Romeo
 * config by the chassis/engine sibling-clone path — and must be dropped before
 * it can enter the 7-layer selector (where it could win on confidence or
 * price-source count). Pure + Convex-free so it stays unit-testable; callers in
 * serviceParts.ts apply it at candidate-hydration time.
 */
export function partFitsConfigMake(
  partMakeId: Id<"makes"> | null | undefined,
  configMakeId: Id<"makes"> | null | undefined,
): boolean {
  if (partMakeId == null) return true; // universal consumable — no make to clash
  if (configMakeId == null) return true; // config make unknown — don't filter
  return partMakeId === configMakeId;
}

export type I1GuardInput = {
  partMakeId: Id<"makes"> | null | undefined;
  configMakeId: Id<"makes"> | null | undefined;
  oemPartNumber: string;
  configMakeName: string | null | undefined;
  /**
   * part_fitments.mechanic_verified — a human physically confirmed this part on
   * this vehicle, so it overrides BOTH heuristics below (make-id provenance can
   * be wrong, and corporate families legitimately share foreign-formatted
   * numbers). Mirrors fitmentQuarantine, which never quarantines verified rows;
   * without this exemption the read path dropped what quarantine spared.
   */
  mechanicVerified?: boolean;
};

/**
 * Combined I1 read guard: the strict make-id check plus the brand-signature
 * backstop, with a mechanic-verified escape hatch. Deliberately NOT
 * family-aware — I1 stays strict for MVP (an Audi-stamped part is dropped from
 * a VW config unless a mechanic verified it).
 */
export function passesI1ReadGuard(input: I1GuardInput): boolean {
  if (input.mechanicVerified === true) return true;
  if (!partFitsConfigMake(input.partMakeId, input.configMakeId)) return false;
  return matchesForeignBrandSignature(input.oemPartNumber, input.configMakeName) === null;
}

export type CandidatePrice = {
  price: number;
  refreshed_days_ago: number;
};

export type CandidateInput = {
  part_id: Id<"oem_parts">;
  confidence: number;
  mechanic_verified: boolean;
  data_quality: DataQuality;
  prices: CandidatePrice[];
  /** part_fitments.refute_flagged — the adversarial fitment verifier refuted
   *  this part but multi-source support blocked the delete. Demoted below any
   *  unflagged rival (round 9, batch-11). */
  refute_flagged?: boolean;
  /** part_fitments.source_domains — distinct domains that attested the
   *  fitment; feeds the OEM-catalog layer (round 9, batch-11). */
  source_domains?: string[];
};

/**
 * Round 9 (batch-11 Forester): does any attesting domain look like an OEM /
 * dealer PARTS CATALOG (parts.subaru.com, autoparts.toyota.com,
 * estore.honda.com, *oemparts*)? Catalog fitment listings are authoritative
 * about WHAT FITS but usually carry no retail price, so before this layer a
 * catalog-attested correct part structurally lost every price-derived
 * tiebreak to a retail-priced wrong-vehicle part.
 */
export function hasOemCatalogDomain(domains: string[] | undefined): boolean {
  if (!domains) return false;
  return domains.some((d) => {
    const host = d.toLowerCase().replace(/^www\./, "");
    return (
      host.startsWith("parts.") ||
      host.startsWith("autoparts.") ||
      host.startsWith("estore.") ||
      host.includes("oemparts")
    );
  });
}

export type EnrichedCandidate = CandidateInput & {
  price_count: number;
  price_cv: number | null;
  price_mean: number | null;
  price_min: number | null;
  price_max: number | null;
  price_median: number | null;
  price_trimmed_median: number | null;
  most_recent_price_days_ago: number | null;
};

export type TraceLayer = number | "gate" | "refute";

export type TraceEntry = {
  layer: TraceLayer;
  name: string;
  decisive: boolean;
  reason: string;
  survivor_part_ids: Id<"oem_parts">[];
  eliminated_part_ids?: Id<"oem_parts">[];
};

export type SelectionResult = {
  winner: EnrichedCandidate | null;
  trace: TraceEntry[];
  eliminatedByGate: EnrichedCandidate[];
  low_confidence: boolean;
};

export type SelectionOptions = {
  gateEnabled: boolean;
  gateThreshold: number;
};

export function enrichCandidate(c: CandidateInput): EnrichedCandidate {
  const prices = c.prices.map((p) => p.price);
  if (prices.length === 0) {
    return {
      ...c,
      price_count: 0,
      price_cv: null,
      price_mean: null,
      price_min: null,
      price_max: null,
      price_median: null,
      price_trimmed_median: null,
      most_recent_price_days_ago: null,
    };
  }
  const sorted = [...prices].sort((a, b) => a - b);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const sd = Math.sqrt(
    prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length,
  );
  const cv = mean > 0 ? sd / mean : 0;
  const med = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  const trimmed = sorted.length >= 3 ? sorted.slice(1, -1) : sorted;
  const tMed = trimmed.length % 2 === 0
    ? (trimmed[trimmed.length / 2 - 1] + trimmed[trimmed.length / 2]) / 2
    : trimmed[Math.floor(trimmed.length / 2)];
  const minRefresh = Math.min(...c.prices.map((p) => p.refreshed_days_ago));
  return {
    ...c,
    price_count: prices.length,
    price_cv: cv,
    price_mean: mean,
    price_min: Math.min(...prices),
    price_max: Math.max(...prices),
    price_median: med,
    price_trimmed_median: tMed,
    most_recent_price_days_ago: minRefresh,
  };
}

const formatQualityRank = (v: number): string => {
  const found = Object.entries(QUALITY_RANK).find(([, r]) => r === v);
  return found ? found[0] : "—";
};

export function selectPart(
  candidates: CandidateInput[],
  opts: SelectionOptions,
): SelectionResult {
  const trace: TraceEntry[] = [];
  if (candidates.length === 0) {
    return { winner: null, trace, eliminatedByGate: [], low_confidence: false };
  }

  const pool0 = candidates.map(enrichCandidate);

  // Layer 0: mechanic_verified short-circuit
  const verified = pool0.filter((c) => c.mechanic_verified);
  if (verified.length === 1) {
    trace.push({
      layer: 0,
      name: "Mechanic Verified",
      decisive: true,
      survivor_part_ids: verified.map((c) => c.part_id),
      reason: "Single mechanic-verified part — wins outright.",
    });
    return { winner: verified[0], trace, eliminatedByGate: [], low_confidence: false };
  }
  let pool: EnrichedCandidate[] = verified.length > 1 ? verified : pool0;
  trace.push({
    layer: 0,
    name: "Mechanic Verified",
    decisive: false,
    survivor_part_ids: pool.map((c) => c.part_id),
    reason: verified.length > 1
      ? `${verified.length} mechanic-verified parts — continuing tiebreak among them.`
      : `No mechanic-verified parts — all ${pool.length} candidates continue.`,
  });

  // Refute demotion (round 9, batch-11): a fitment the adversarial verifier
  // REFUTED — kept only because multi-source support blocked the delete —
  // must not beat an unflagged rival. Drop flagged candidates while at least
  // one unflagged candidate remains; if everything is flagged, keep the pool
  // (a flagged sole candidate still quotes, flagged low-confidence upstream).
  const unflagged = pool.filter((c) => c.refute_flagged !== true);
  if (unflagged.length > 0 && unflagged.length < pool.length) {
    const dropped = pool.filter((c) => c.refute_flagged === true);
    trace.push({
      layer: "refute",
      name: "Fitment Refute Demotion",
      decisive: unflagged.length === 1,
      survivor_part_ids: unflagged.map((c) => c.part_id),
      eliminated_part_ids: dropped.map((c) => c.part_id),
      reason: `${dropped.length} refute-flagged candidate(s) demoted below ${unflagged.length} unflagged.`,
    });
    pool = unflagged;
    if (pool.length === 1) {
      return { winner: pool[0], trace, eliminatedByGate: [], low_confidence: false };
    }
  }

  // Confidence gate
  let eliminatedByGate: EnrichedCandidate[] = [];
  let low_confidence = false;
  if (opts.gateEnabled) {
    const passing = pool.filter((c) => c.confidence >= opts.gateThreshold);
    if (passing.length > 0) {
      eliminatedByGate = pool.filter((c) => c.confidence < opts.gateThreshold);
      pool = passing;
      const decisive = pool.length === 1;
      trace.push({
        layer: "gate",
        name: `Confidence Gate (≥ ${opts.gateThreshold.toFixed(2)})`,
        decisive,
        survivor_part_ids: pool.map((c) => c.part_id),
        eliminated_part_ids: eliminatedByGate.map((c) => c.part_id),
        reason: decisive
          ? `${pool[0].part_id} is the only candidate clearing the gate — wins by elimination.`
          : `${pool.length} clear the gate · ${eliminatedByGate.length} eliminated.`,
      });
      if (decisive) {
        return { winner: pool[0], trace, eliminatedByGate, low_confidence };
      }
    } else {
      low_confidence = true;
      trace.push({
        layer: "gate",
        name: `Confidence Gate (≥ ${opts.gateThreshold.toFixed(2)})`,
        decisive: false,
        survivor_part_ids: pool.map((c) => c.part_id),
        reason:
          "No candidates clear the gate — falling back to full pool. Booking flagged low_confidence_parts=true.",
      });
    }
  }

  // Generic layer runner — mutates `pool` in place. Caller supplies a
  // formatter so the layer ordering is independent of presentation.
  const runLayer = (
    n: number,
    name: string,
    score: (c: EnrichedCandidate) => number,
    format: (v: number) => string,
    asc = false,
  ): boolean => {
    const scores = pool.map(score);
    const target = asc ? Math.min(...scores) : Math.max(...scores);
    const survivors = pool.filter((_, i) => scores[i] === target);
    const decisive = survivors.length === 1;
    trace.push({
      layer: n,
      name,
      decisive,
      survivor_part_ids: survivors.map((c) => c.part_id),
      reason: decisive
        ? `${survivors[0].part_id} wins. ${name} value: ${format(target)}`
        : `${survivors.length} candidates tied at ${format(target)}.`,
    });
    pool = survivors;
    return decisive;
  };

  // Fitment-first ordering: we'd rather show a confident, OEM-quality part
  // with sparse pricing than a well-priced part we're less sure fits this
  // car. Price-derived tiebreaks only kick in once fitment certainty is tied.
  if (runLayer(1, "Fitment Confidence", (c) => c.confidence, (v) => v.toFixed(2))) {
    return { winner: pool[0], trace, eliminatedByGate, low_confidence };
  }
  if (
    runLayer(
      2,
      "Data Quality",
      (c) => QUALITY_RANK[c.data_quality] ?? 99,
      formatQualityRank,
      true,
    )
  ) {
    return { winner: pool[0], trace, eliminatedByGate, low_confidence };
  }
  // Layer 3 (round 9, batch-11): OEM-catalog fitment authority BEFORE any
  // price signal. Pricing attaches by whatever retailers happen to sell, so
  // "has prices" is availability, not fitment authority — on the batch-11
  // Forester every wrong-generation part was retail-priced and won, while the
  // correct part sat attested by parts.subaru.com with no price. A candidate
  // attested by an OEM/dealer parts catalog outranks one that isn't; ties
  // (both or neither) fall through to the price layers.
  if (
    runLayer(
      3,
      "OEM Catalog Fitment",
      (c) => (hasOemCatalogDomain(c.source_domains) ? 1 : 0),
      (v) => (v ? "catalog-attested" : "no catalog attestation"),
    )
  ) {
    return { winner: pool[0], trace, eliminatedByGate, low_confidence };
  }
  if (runLayer(4, "Price Source Count", (c) => c.price_count, (v) => `${v} sources`)) {
    return { winner: pool[0], trace, eliminatedByGate, low_confidence };
  }
  if (runLayer(5, "Price Stability (CV)", (c) => c.price_cv ?? 999, (v) => `CV ${v.toFixed(3)}`, true)) {
    return { winner: pool[0], trace, eliminatedByGate, low_confidence };
  }
  if (
    runLayer(
      6,
      "Recency (price freshness)",
      (c) => c.most_recent_price_days_ago ?? 9999,
      (v) => `${v}d ago`,
      true,
    )
  ) {
    return { winner: pool[0], trace, eliminatedByGate, low_confidence };
  }

  // Layer 7: distance from category median of trimmed medians.
  const catMed = pool.reduce((s, c) => s + (c.price_trimmed_median ?? 0), 0) / pool.length;
  if (
    runLayer(
      7,
      `Median-Price Proximity (cat $${catMed.toFixed(2)})`,
      (c) => Math.abs((c.price_trimmed_median ?? 0) - catMed),
      (v) => `$${v.toFixed(2)} away`,
      true,
    )
  ) {
    return { winner: pool[0], trace, eliminatedByGate, low_confidence };
  }

  // Layer 8: lexicographic — always decisive.
  const sorted = [...pool].sort((a, b) => a.part_id.localeCompare(b.part_id));
  trace.push({
    layer: 8,
    name: "Lexicographic (deterministic)",
    decisive: true,
    survivor_part_ids: [sorted[0].part_id],
    reason: `${sorted[0].part_id} wins on alphabetical order — pure deterministic tiebreaker.`,
  });
  return { winner: sorted[0], trace, eliminatedByGate, low_confidence };
}
