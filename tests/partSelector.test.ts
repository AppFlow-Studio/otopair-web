/**
 * partSelector unit tests — pure module, no Convex setup needed.
 *
 * Covers the 7-layer pipeline against handcrafted candidate pools so a future
 * refactor can't silently change which part wins for a given scenario.
 */
import { describe, it, expect } from "vitest";

import {
  selectPart,
  enrichCandidate,
  normalizeDataQuality,
  partFitsConfigMake,
  type CandidateInput,
  QUALITY_RANK,
} from "../convex/partSelector";
import type { Id } from "../convex/_generated/dataModel";

const id = (s: string) => s as Id<"oem_parts">;

function makeCandidate(overrides: Partial<CandidateInput>): CandidateInput {
  return {
    part_id: id("p_base"),
    confidence: 0.8,
    mechanic_verified: false,
    data_quality: "aftermarket",
    prices: [{ price: 50, refreshed_days_ago: 10 }],
    ...overrides,
  };
}

const GATE = { gateEnabled: true, gateThreshold: 0.7 };

describe("normalizeDataQuality", () => {
  it("maps known values directly", () => {
    expect(normalizeDataQuality("oem")).toBe("oem");
    expect(normalizeDataQuality("dealer")).toBe("dealer");
    expect(normalizeDataQuality("aftermarket")).toBe("aftermarket");
    expect(normalizeDataQuality("generic")).toBe("generic");
  });
  it("maps legacy high/medium/low buckets", () => {
    expect(normalizeDataQuality("high")).toBe("oem");
    expect(normalizeDataQuality("medium")).toBe("aftermarket");
    expect(normalizeDataQuality("low")).toBe("generic");
  });
  it("falls back to generic for unknown / null / empty", () => {
    expect(normalizeDataQuality("garbage")).toBe("generic");
    expect(normalizeDataQuality(null)).toBe("generic");
    expect(normalizeDataQuality(undefined)).toBe("generic");
    expect(normalizeDataQuality("")).toBe("generic");
  });
});

describe("enrichCandidate", () => {
  it("handles zero-price candidates without dividing by zero", () => {
    const c = enrichCandidate(makeCandidate({ prices: [] }));
    expect(c.price_count).toBe(0);
    expect(c.price_cv).toBeNull();
    expect(c.price_median).toBeNull();
    expect(c.most_recent_price_days_ago).toBeNull();
  });

  it("computes trimmed median by dropping one from each end when n≥3", () => {
    const c = enrichCandidate(
      makeCandidate({
        prices: [
          { price: 10, refreshed_days_ago: 1 },
          { price: 50, refreshed_days_ago: 1 },
          { price: 60, refreshed_days_ago: 1 },
          { price: 70, refreshed_days_ago: 1 },
          { price: 9999, refreshed_days_ago: 1 },
        ],
      }),
    );
    // After trimming 10 and 9999, the trimmed array is [50, 60, 70] → median 60.
    expect(c.price_trimmed_median).toBe(60);
  });

  it("uses minimum refreshed_days_ago across sources", () => {
    const c = enrichCandidate(
      makeCandidate({
        prices: [
          { price: 10, refreshed_days_ago: 30 },
          { price: 11, refreshed_days_ago: 2 },
          { price: 12, refreshed_days_ago: 15 },
        ],
      }),
    );
    expect(c.most_recent_price_days_ago).toBe(2);
  });
});

describe("Layer 0 — mechanic_verified short-circuit", () => {
  it("returns the single verified part immediately", () => {
    const result = selectPart(
      [
        makeCandidate({ part_id: id("p_a"), mechanic_verified: false }),
        makeCandidate({ part_id: id("p_b"), mechanic_verified: true }),
        makeCandidate({ part_id: id("p_c"), mechanic_verified: false }),
      ],
      GATE,
    );
    expect(result.winner?.part_id).toBe("p_b");
    expect(result.trace[0].decisive).toBe(true);
    expect(result.trace).toHaveLength(1);
  });

  it("with two verified parts, narrows the pool and continues to lower layers", () => {
    const result = selectPart(
      [
        makeCandidate({
          part_id: id("p_a"),
          mechanic_verified: true,
          confidence: 0.95,
          prices: [
            { price: 50, refreshed_days_ago: 1 },
            { price: 51, refreshed_days_ago: 1 },
          ],
        }),
        makeCandidate({
          part_id: id("p_b"),
          mechanic_verified: true,
          confidence: 0.9,
          prices: [{ price: 50, refreshed_days_ago: 1 }],
        }),
        // Unverified — should never enter the pool.
        makeCandidate({ part_id: id("p_c"), mechanic_verified: false }),
      ],
      GATE,
    );
    expect(["p_a", "p_b"]).toContain(result.winner?.part_id);
    expect(result.trace[0].decisive).toBe(false);
    // p_c was filtered out at L0 since two others were verified.
    expect(result.trace[0].survivor_part_ids).not.toContain("p_c");
  });
});

describe("Confidence gate", () => {
  it("eliminates sub-threshold candidates and records them", () => {
    const result = selectPart(
      [
        makeCandidate({ part_id: id("p_low"), confidence: 0.5 }),
        makeCandidate({ part_id: id("p_high"), confidence: 0.9 }),
      ],
      GATE,
    );
    expect(result.winner?.part_id).toBe("p_high");
    expect(result.eliminatedByGate.map((c) => c.part_id)).toEqual(["p_low"]);
    expect(result.low_confidence).toBe(false);
  });

  it("flags low_confidence when no candidate clears the gate", () => {
    const result = selectPart(
      [
        makeCandidate({
          part_id: id("p_a"),
          confidence: 0.4,
          prices: [{ price: 100, refreshed_days_ago: 5 }],
        }),
        makeCandidate({
          part_id: id("p_b"),
          confidence: 0.3,
          prices: [
            { price: 50, refreshed_days_ago: 5 },
            { price: 60, refreshed_days_ago: 5 },
          ],
        }),
      ],
      GATE,
    );
    expect(result.winner).not.toBeNull();
    expect(result.low_confidence).toBe(true);
    // p_b has more price sources → wins layer 1.
    expect(result.winner?.part_id).toBe("p_b");
  });
});

describe("Tiebreak layers 1–6", () => {
  const baseHigh = (extra: Partial<CandidateInput>): CandidateInput =>
    makeCandidate({ confidence: 0.9, ...extra });

  it("Layer 1: more price sources wins", () => {
    const result = selectPart(
      [
        baseHigh({
          part_id: id("p_few"),
          prices: [{ price: 50, refreshed_days_ago: 1 }],
        }),
        baseHigh({
          part_id: id("p_many"),
          prices: [
            { price: 50, refreshed_days_ago: 1 },
            { price: 51, refreshed_days_ago: 1 },
            { price: 49, refreshed_days_ago: 1 },
          ],
        }),
      ],
      GATE,
    );
    expect(result.winner?.part_id).toBe("p_many");
  });

  it("Layer 2: higher fitment confidence wins when source counts tie", () => {
    const result = selectPart(
      [
        baseHigh({
          part_id: id("p_lo"),
          confidence: 0.75,
          prices: [{ price: 50, refreshed_days_ago: 1 }],
        }),
        baseHigh({
          part_id: id("p_hi"),
          confidence: 0.95,
          prices: [{ price: 50, refreshed_days_ago: 1 }],
        }),
      ],
      GATE,
    );
    expect(result.winner?.part_id).toBe("p_hi");
  });

  it("Layer 3: lower CV (price stability) wins", () => {
    const result = selectPart(
      [
        baseHigh({
          part_id: id("p_stable"),
          prices: [
            { price: 50, refreshed_days_ago: 5 },
            { price: 51, refreshed_days_ago: 5 },
            { price: 49, refreshed_days_ago: 5 },
          ],
        }),
        baseHigh({
          part_id: id("p_volatile"),
          prices: [
            { price: 10, refreshed_days_ago: 5 },
            { price: 80, refreshed_days_ago: 5 },
            { price: 30, refreshed_days_ago: 5 },
          ],
        }),
      ],
      GATE,
    );
    expect(result.winner?.part_id).toBe("p_stable");
  });

  it("Layer 4: fresher pricing wins", () => {
    const result = selectPart(
      [
        baseHigh({
          part_id: id("p_old"),
          prices: [
            { price: 50, refreshed_days_ago: 100 },
            { price: 50, refreshed_days_ago: 110 },
          ],
        }),
        baseHigh({
          part_id: id("p_fresh"),
          prices: [
            { price: 50, refreshed_days_ago: 2 },
            { price: 50, refreshed_days_ago: 5 },
          ],
        }),
      ],
      GATE,
    );
    expect(result.winner?.part_id).toBe("p_fresh");
  });

  it("Layer 6: data_quality breaks remaining ties", () => {
    // Three candidates identical on layers 1–5; only data_quality differs.
    const prices = [
      { price: 50, refreshed_days_ago: 5 },
      { price: 50, refreshed_days_ago: 5 },
    ];
    const result = selectPart(
      [
        baseHigh({ part_id: id("p_gen"), data_quality: "generic", prices }),
        baseHigh({ part_id: id("p_aft"), data_quality: "aftermarket", prices }),
        baseHigh({ part_id: id("p_oem"), data_quality: "oem", prices }),
      ],
      GATE,
    );
    expect(result.winner?.part_id).toBe("p_oem");
    expect(QUALITY_RANK.oem).toBeLessThan(QUALITY_RANK.aftermarket);
  });
});

describe("Layer 7 — lexicographic deterministic tiebreaker", () => {
  it("always picks the alphabetically-first part_id when all signals tie", () => {
    const prices = [
      { price: 50, refreshed_days_ago: 5 },
      { price: 50, refreshed_days_ago: 5 },
    ];
    const make = (pid: string): CandidateInput =>
      makeCandidate({
        part_id: id(pid),
        confidence: 0.9,
        data_quality: "oem",
        prices,
      });
    const result = selectPart([make("p_zebra"), make("p_alpha"), make("p_mid")], GATE);
    expect(result.winner?.part_id).toBe("p_alpha");
    expect(result.trace[result.trace.length - 1].layer).toBe(7);
  });
});

describe("Empty pool", () => {
  it("returns null winner with no trace", () => {
    const result = selectPart([], GATE);
    expect(result.winner).toBeNull();
    expect(result.trace).toHaveLength(0);
  });
});

// ── I1 make guard ──────────────────────────────────────────────────────────
// Cross-make contaminants (a Ford/Audi brake pad cloned onto an Alfa config)
// must be dropped at hydration time BEFORE the 7-layer selector runs, while
// universal consumables (make_id == null) must survive. Mirrors the real
// serviceParts.ts flow: filter candidates by partFitsConfigMake, then selectPart.
describe("I1 make guard — partFitsConfigMake", () => {
  const mid = (s: string) => s as Id<"makes">;
  const ALFA = mid("m_alfa");
  const FORD = mid("m_ford");
  const AUDI = mid("m_audi");

  it("keeps same-make + null-make parts, drops set-make mismatches", () => {
    expect(partFitsConfigMake(ALFA, ALFA)).toBe(true); // matching make
    expect(partFitsConfigMake(FORD, ALFA)).toBe(false); // cross-make contaminant
    expect(partFitsConfigMake(AUDI, ALFA)).toBe(false);
    expect(partFitsConfigMake(null, ALFA)).toBe(true); // universal consumable
    expect(partFitsConfigMake(undefined, ALFA)).toBe(true);
    expect(partFitsConfigMake(FORD, null)).toBe(true); // config make unknown → no filter
  });

  // Real candidate shape from the live 2024 Alfa Romeo Stelvio Ti config
  // w578qc0czknp00j29h1f1v0axh8728k5 (front_brake_pad role group).
  type Hydrated = {
    part_id: Id<"oem_parts">;
    make_id: Id<"makes"> | null;
    confidence: number;
    data_quality: CandidateInput["data_quality"];
    prices: CandidateInput["prices"];
  };
  const toInputs = (
    cands: Hydrated[],
    configMake: Id<"makes"> | null,
  ): CandidateInput[] =>
    cands
      .filter((c) => partFitsConfigMake(c.make_id, configMake))
      .map((c) => ({
        part_id: c.part_id,
        confidence: c.confidence,
        mechanic_verified: false,
        data_quality: c.data_quality,
        prices: c.prices,
      }));

  it("front_brake_pad on the Alfa Stelvio: Alfa part wins, Ford & Audi excluded by the guard", () => {
    const candidates: Hydrated[] = [
      {
        part_id: id("alfa_68400577AA"),
        make_id: ALFA,
        confidence: 0.95,
        data_quality: "oem",
        prices: [
          { price: 85, refreshed_days_ago: 5 },
          { price: 88, refreshed_days_ago: 7 },
        ],
      },
      {
        // Ford KB3Z-2001-A — cloned onto the Alfa config, 9 cheap price sources.
        part_id: id("ford_KB3Z-2001-A"),
        make_id: FORD,
        confidence: 0.87,
        data_quality: "oem",
        prices: Array.from({ length: 9 }, (_, i) => ({
          price: 11 + i * 0.1,
          refreshed_days_ago: 3,
        })),
      },
      {
        part_id: id("audi_8R0698151L"),
        make_id: AUDI,
        confidence: 0.87,
        data_quality: "oem",
        prices: [
          { price: 70, refreshed_days_ago: 4 },
          { price: 72, refreshed_days_ago: 6 },
        ],
      },
    ];

    const survivors = candidates.filter((c) =>
      partFitsConfigMake(c.make_id, ALFA),
    );
    expect(survivors.map((c) => String(c.part_id))).toEqual([
      "alfa_68400577AA",
    ]);
    expect(survivors.some((c) => c.part_id === id("ford_KB3Z-2001-A"))).toBe(
      false,
    );
    expect(survivors.some((c) => c.part_id === id("audi_8R0698151L"))).toBe(
      false,
    );

    const result = selectPart(toInputs(candidates, ALFA), GATE);
    expect(result.winner?.part_id).toBe("alfa_68400577AA");
  });

  it("guard is decisive: without it the wrong-make part would win, with it the Alfa part wins", () => {
    // Adversarial: the Ford pad has HIGHER confidence (0.95) and many price
    // sources, so WITHOUT the guard it wins Layer 1; WITH the guard it never
    // enters the pool. This proves the guard changes the outcome (not just that
    // the Alfa part happened to have the highest confidence today).
    const candidates: Hydrated[] = [
      {
        part_id: id("ford_hi_conf"),
        make_id: FORD,
        confidence: 0.95,
        data_quality: "oem",
        prices: Array.from({ length: 9 }, () => ({
          price: 11,
          refreshed_days_ago: 2,
        })),
      },
      {
        part_id: id("alfa_lo_conf"),
        make_id: ALFA,
        confidence: 0.85,
        data_quality: "oem",
        prices: [{ price: 85, refreshed_days_ago: 9 }],
      },
    ];

    // Sanity: without the guard, the Ford part wins outright at Layer 1.
    const noGuard = selectPart(
      candidates.map((c) => ({
        part_id: c.part_id,
        confidence: c.confidence,
        mechanic_verified: false,
        data_quality: c.data_quality,
        prices: c.prices,
      })),
      GATE,
    );
    expect(noGuard.winner?.part_id).toBe("ford_hi_conf");

    // With the guard, the Ford part is excluded and the Alfa part wins.
    const guarded = selectPart(toInputs(candidates, ALFA), GATE);
    expect(guarded.winner?.part_id).toBe("alfa_lo_conf");
  });

  it("universal consumable (make_id null) survives the guard and can still win", () => {
    const candidates: Hydrated[] = [
      {
        part_id: id("generic_oil_filter"),
        make_id: null, // universal consumable — no make
        confidence: 0.9,
        data_quality: "generic",
        prices: [{ price: 8, refreshed_days_ago: 3 }],
      },
    ];
    const survivors = candidates.filter((c) =>
      partFitsConfigMake(c.make_id, ALFA),
    );
    expect(survivors.map((c) => String(c.part_id))).toEqual([
      "generic_oil_filter",
    ]);

    const result = selectPart(toInputs(candidates, ALFA), GATE);
    expect(result.winner?.part_id).toBe("generic_oil_filter");
  });
});
