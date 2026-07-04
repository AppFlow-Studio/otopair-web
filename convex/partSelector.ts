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
 *   gate confidence ≥ threshold (drops low-conf; falls back to full pool if
 *        none clear, and flags low_confidence)
 *   1 fitment confidence
 *   2 data quality (oem > dealer > aftermarket > generic)
 *   3 price source count
 *   4 price stability (CV)
 *   5 recency
 *   6 median-price proximity
 *   7 lexicographic (always decisive)
 *
 * No Convex imports here. Callers (serviceParts.ts, booking_quotes.ts) hydrate
 * candidates from part_fitments + part_prices and pass them in. Keeps this module
 * unit-testable without spinning up a Convex env.
 */
import type { Id } from "./_generated/dataModel";

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
};

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

export type TraceLayer = number | "gate";

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
  if (runLayer(3, "Price Source Count", (c) => c.price_count, (v) => `${v} sources`)) {
    return { winner: pool[0], trace, eliminatedByGate, low_confidence };
  }
  if (runLayer(4, "Price Stability (CV)", (c) => c.price_cv ?? 999, (v) => `CV ${v.toFixed(3)}`, true)) {
    return { winner: pool[0], trace, eliminatedByGate, low_confidence };
  }
  if (
    runLayer(
      5,
      "Recency (price freshness)",
      (c) => c.most_recent_price_days_ago ?? 9999,
      (v) => `${v}d ago`,
      true,
    )
  ) {
    return { winner: pool[0], trace, eliminatedByGate, low_confidence };
  }

  // Layer 6: distance from category median of trimmed medians.
  const catMed = pool.reduce((s, c) => s + (c.price_trimmed_median ?? 0), 0) / pool.length;
  if (
    runLayer(
      6,
      `Median-Price Proximity (cat $${catMed.toFixed(2)})`,
      (c) => Math.abs((c.price_trimmed_median ?? 0) - catMed),
      (v) => `$${v.toFixed(2)} away`,
      true,
    )
  ) {
    return { winner: pool[0], trace, eliminatedByGate, low_confidence };
  }

  // Layer 7: lexicographic — always decisive.
  const sorted = [...pool].sort((a, b) => a.part_id.localeCompare(b.part_id));
  trace.push({
    layer: 7,
    name: "Lexicographic (deterministic)",
    decisive: true,
    survivor_part_ids: [sorted[0].part_id],
    reason: `${sorted[0].part_id} wins on alphabetical order — pure deterministic tiebreaker.`,
  });
  return { winner: sorted[0], trace, eliminatedByGate, low_confidence };
}
