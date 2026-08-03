/**
 * tests/siblingInheritance.test.ts — P2.4 field-level sibling inheritance.
 *
 * Pure functions only: the audited safe set (types.ts) and the four pure
 * pieces of the pass (selectSiblingDonor / shouldInheritField /
 * buildInheritedField / planSiblingInheritance) plus the front-wiper split
 * that fixes the driver/passenger write asymmetry.
 *
 * The tests below encode the INVARIANTS, not the current implementation:
 * inherited data may never outrank sourced data, a human's word is final, a
 * value this run rejected never comes back, and nothing that varies by
 * trim/drivetrain/package/gearbox may ever enter the safe set.
 */

import { describe, expect, it } from "vitest";
import {
  SIBLING_SAFE_FIELDS,
  SIBLING_UNSAFE_FIELDS,
  SIBLING_INHERIT_RULES,
  V4_FIELD_KEYS,
  emptyField,
  parseFrontWiperSizes,
  type FieldResult,
} from "../convex/vehicleEnrichment/types";
import {
  selectSiblingDonor,
  shouldInheritField,
  buildInheritedField,
  planSiblingInheritance,
  siblingInheritMax,
  siblingInheritEnabled,
  SIBLING_INHERIT_CONFIDENCE_CAP,
  SIBLING_INHERIT_FLAG_SEVERITY,
  type RawSiblingDonor,
  type SiblingDonorCandidate,
} from "../convex/vehicleEnrichment/v3pipeline";

// ─── Fixtures ─────────────────────────────────────────────────────

function donor(over: Partial<SiblingDonorCandidate> = {}): SiblingDonorCandidate {
  return {
    config_id: "cfg1",
    config_key: "2019_vw_jetta_s_ea211",
    value: "belt",
    confidence: 0.9,
    verified: false,
    last_enriched_at: 1_000,
    via: "engine_code",
    ...over,
  };
}

function raw(over: Partial<RawSiblingDonor> = {}): RawSiblingDonor {
  return {
    config_id: "cfg1",
    config_key: "2019_vw_jetta_s_ea211",
    raw_value: "belt",
    confidence: 0.9,
    verified: false,
    last_enriched_at: 1_000,
    via: "engine_code",
    ...over,
  };
}

function filled(value: FieldResult["value"], over: Partial<FieldResult> = {}): FieldResult {
  return { ...emptyField(), value, confidence: 0.9, source_type: "web_search", ...over };
}

// ─── 1. The audited safe set ──────────────────────────────────────

describe("SIBLING_SAFE_FIELDS — the exclusion rule is encoded, not assumed", () => {
  it("admits only engine-intrinsic facts", () => {
    expect([...SIBLING_SAFE_FIELDS].sort()).toEqual([
      "fuel_injection_type",
      "spark_plug_quantity",
      "timing_system",
      "turbo",
    ]);
  });

  it("contains NO field that varies by trim / drivetrain / package / gearbox", () => {
    // Every member of the v7 list that the 2026-07-30 audit rejected, with its
    // documented counter-example. None may leak back in.
    for (const unsafe of Object.keys(SIBLING_UNSAFE_FIELDS)) {
      expect(
        SIBLING_SAFE_FIELDS.has(unsafe),
        `${unsafe} is variant-dependent: ${SIBLING_UNSAFE_FIELDS[unsafe]}`,
      ).toBe(false);
    }
    // The specific axes the pipeline has historically mis-identified.
    for (const banned of [
      "drivetrain",
      "transmission_type",
      "trans_fluid_type",
      "diff_fluid_type",
      "diff_fluid_capacity_qts",
      "transfer_case_fluid_type",
      "transfer_case_fluid_capacity_qts",
      "transmission_fluid_capacity_qts",
      "parking_brake_type",
      "power_steering_type",
      "brake_fluid_capacity_oz",
      "ps_fluid_capacity_oz",
    ]) {
      expect(SIBLING_SAFE_FIELDS.has(banned), `${banned} must never be sibling-inheritable`).toBe(
        false,
      );
    }
  });

  it("every unsafe entry carries a written justification", () => {
    for (const [field, why] of Object.entries(SIBLING_UNSAFE_FIELDS)) {
      expect(why.length, `${field} needs a reason`).toBeGreaterThan(30);
    }
  });

  it("stays in lockstep with the rules table and the real field keys", () => {
    expect([...SIBLING_SAFE_FIELDS].sort()).toEqual(Object.keys(SIBLING_INHERIT_RULES).sort());
    for (const f of SIBLING_SAFE_FIELDS) {
      expect(V4_FIELD_KEYS, `${f} must be a real extraction field`).toContain(f);
      expect(SIBLING_INHERIT_RULES[f].scope).toBe("engine");
      expect(SIBLING_INHERIT_RULES[f].column.length).toBeGreaterThan(0);
    }
  });
});

describe("rule decoders refuse anything they do not recognise", () => {
  const dec = (f: string, v: unknown) => SIBLING_INHERIT_RULES[f].fromColumn(v);

  it("timing_system: only belt/chain/gear", () => {
    expect(dec("timing_system", "belt")).toBe("belt");
    expect(dec("timing_system", "timing chain")).toBe("timing chain");
    expect(dec("timing_system", "unknown")).toBeNull();
    expect(dec("timing_system", 3)).toBeNull();
  });

  it("turbo: never converts an unmapped aspiration into false", () => {
    expect(dec("turbo", "turbo")).toBe(true);
    expect(dec("turbo", "twin-turbo")).toBe("twin-turbo");
    expect(dec("turbo", "natural")).toBe(false);
    // false would be written back as aspiration "natural" and erase the truth.
    expect(dec("turbo", "supercharged")).toBeNull();
    expect(dec("turbo", "")).toBeNull();
  });

  it("spark_plug_quantity: integers 1..16 only", () => {
    expect(dec("spark_plug_quantity", 4)).toBe(4);
    expect(dec("spark_plug_quantity", 16)).toBe(16);
    expect(dec("spark_plug_quantity", 0)).toBeNull();
    expect(dec("spark_plug_quantity", 24)).toBeNull();
    expect(dec("spark_plug_quantity", 4.5)).toBeNull();
    expect(dec("spark_plug_quantity", "junk")).toBeNull();
  });

  it("fuel_injection_type: known injection families only", () => {
    expect(dec("fuel_injection_type", "direct")).toBe("direct");
    expect(dec("fuel_injection_type", "port + direct")).toBe("port + direct");
    expect(dec("fuel_injection_type", "yes")).toBeNull();
  });
});

// ─── 2. Donor precedence ──────────────────────────────────────────

describe("selectSiblingDonor", () => {
  it("prefers a human-verified donor over a higher-confidence one", () => {
    const picked = selectSiblingDonor(
      [
        donor({ config_key: "loud", confidence: 0.99, verified: false }),
        donor({ config_key: "human", confidence: 0.4, verified: true }),
      ],
      "timing_system",
    );
    expect(picked?.config_key).toBe("human");
  });

  it("then prefers higher confidence", () => {
    const picked = selectSiblingDonor(
      [
        donor({ config_key: "low", confidence: 0.5, last_enriched_at: 9_000 }),
        donor({ config_key: "high", confidence: 0.8, last_enriched_at: 1 }),
      ],
      "timing_system",
    );
    expect(picked?.config_key).toBe("high");
  });

  it("then prefers the more recent enrichment", () => {
    const picked = selectSiblingDonor(
      [
        donor({ config_key: "old", confidence: 0.8, last_enriched_at: 1 }),
        donor({ config_key: "new", confidence: 0.8, last_enriched_at: 9_000 }),
      ],
      "timing_system",
    );
    expect(picked?.config_key).toBe("new");
  });

  it("is deterministic when everything ties", () => {
    const a = donor({ config_key: "bbb" });
    const b = donor({ config_key: "aaa" });
    expect(selectSiblingDonor([a, b], "timing_system")?.config_key).toBe("aaa");
    expect(selectSiblingDonor([b, a], "timing_system")?.config_key).toBe("aaa");
  });

  it("treats a missing confidence as the weakest, not as zero-beats-null", () => {
    const picked = selectSiblingDonor(
      [donor({ config_key: "unknown_conf", confidence: null }), donor({ config_key: "known", confidence: 0.3 })],
      "timing_system",
    );
    expect(picked?.config_key).toBe("known");
  });

  it("returns null for no candidates, valueless candidates, or an unsafe field", () => {
    expect(selectSiblingDonor([], "timing_system")).toBeNull();
    expect(selectSiblingDonor(undefined, "timing_system")).toBeNull();
    expect(selectSiblingDonor([donor({ value: null as any })], "timing_system")).toBeNull();
    expect(selectSiblingDonor([donor()], "drivetrain")).toBeNull();
  });
});

// ─── 3. The gating rules ──────────────────────────────────────────

describe("shouldInheritField", () => {
  const verified: string[] = [];

  it("fills a null field", () => {
    expect(shouldInheritField("timing_system", emptyField(), donor(), verified)).toEqual({
      inherit: true,
      reason: "inherited",
    });
    expect(shouldInheritField("timing_system", undefined, donor(), verified)).toEqual({
      inherit: true,
      reason: "inherited",
    });
  });

  it("NEVER overwrites a value the run already sourced", () => {
    expect(
      shouldInheritField("timing_system", filled("chain"), donor({ value: "belt" }), verified),
    ).toEqual({ inherit: false, reason: "already_filled" });
  });

  it("NEVER overwrites a human-verified field — by field key or engines column", () => {
    expect(
      shouldInheritField("timing_system", emptyField(), donor(), ["timing_system"]),
    ).toEqual({ inherit: false, reason: "human_verified" });
    // A director stamps the COLUMN name for fuel injection.
    expect(
      shouldInheritField(
        "fuel_injection_type",
        emptyField(),
        donor({ value: "direct" }),
        ["fuel_injection"],
      ),
    ).toEqual({ inherit: false, reason: "human_verified" });
    // Verified beats every other refusal reason — including a filled value.
    expect(
      shouldInheritField("timing_system", filled("chain"), donor(), ["timing_system"]),
    ).toEqual({ inherit: false, reason: "human_verified" });
  });

  it("NEVER inherits onto a field this run REJECTED", () => {
    const rejected: FieldResult = { ...emptyField(), value: null, rejected: true, flagged: true };
    expect(shouldInheritField("timing_system", rejected, donor(), verified)).toEqual({
      inherit: false,
      reason: "rejected_this_run",
    });
  });

  it("NEVER resurrects a not_applicable field", () => {
    const na: FieldResult = { ...emptyField(), flag_reason: "not_applicable" };
    expect(shouldInheritField("timing_system", na, donor(), verified)).toEqual({
      inherit: false,
      reason: "not_applicable",
    });
  });

  it("refuses fields outside the safe set and missing donors", () => {
    expect(shouldInheritField("drivetrain", emptyField(), donor({ value: "AWD" }), verified)).toEqual(
      { inherit: false, reason: "not_sibling_safe" },
    );
    expect(shouldInheritField("timing_system", emptyField(), null, verified)).toEqual({
      inherit: false,
      reason: "no_donor",
    });
  });
});

// ─── 4. The written value ─────────────────────────────────────────

describe("buildInheritedField", () => {
  it("caps confidence at 0.7 — below the 0.75 quote gate", () => {
    expect(SIBLING_INHERIT_CONFIDENCE_CAP).toBe(0.7);
    expect(buildInheritedField("timing_system", donor({ confidence: 1 })).confidence).toBe(0.7);
    expect(buildInheritedField("timing_system", donor({ confidence: 0.95 })).confidence).toBe(0.7);
    expect(buildInheritedField("timing_system", donor({ confidence: null })).confidence).toBe(0.7);
  });

  it("never raises a weak donor's confidence", () => {
    expect(buildInheritedField("timing_system", donor({ confidence: 0.42 })).confidence).toBe(0.42);
  });

  it("stamps provenance and names the donor config", () => {
    const f = buildInheritedField("timing_system", donor({ config_key: "2018_vw_golf_ea211" }));
    expect(f.source_type).toBe("sibling_engine");
    expect(f.value).toBe("belt");
    expect(f.flagged).toBe(true);
    expect(f.flag_reason).toContain("2018_vw_golf_ea211");
    expect(f.flag_reason).toContain("sibling_inherit");
    expect(f.source_url).toBeNull();
  });
});

// ─── 5. The whole plan, including the cap ─────────────────────────

describe("planSiblingInheritance", () => {
  const allNull = (): Record<string, FieldResult> => ({
    timing_system: emptyField(),
    turbo: emptyField(),
    fuel_injection_type: emptyField(),
    spark_plug_quantity: emptyField(),
  });

  const everyDonor = (): Record<string, RawSiblingDonor[]> => ({
    timing_system: [raw({ raw_value: "belt" })],
    turbo: [raw({ raw_value: "turbo" })],
    fuel_injection_type: [raw({ raw_value: "direct" })],
    spark_plug_quantity: [raw({ raw_value: 4 })],
  });

  it("fills every eligible null field when under the cap", () => {
    const plan = planSiblingInheritance(allNull(), everyDonor(), [], 12);
    expect(plan.map((p) => p.field).sort()).toEqual([
      "fuel_injection_type",
      "spark_plug_quantity",
      "timing_system",
      "turbo",
    ]);
    expect(plan.every((p) => p.result.source_type === "sibling_engine")).toBe(true);
    expect(plan.every((p) => (p.result.confidence ?? 1) <= 0.7)).toBe(true);
  });

  it("enforces the per-run cap", () => {
    expect(planSiblingInheritance(allNull(), everyDonor(), [], 2)).toHaveLength(2);
    expect(planSiblingInheritance(allNull(), everyDonor(), [], 1)).toHaveLength(1);
    expect(planSiblingInheritance(allNull(), everyDonor(), [], 0)).toHaveLength(0);
    expect(planSiblingInheritance(allNull(), everyDonor(), [], -3)).toHaveLength(0);
    expect(planSiblingInheritance(allNull(), everyDonor(), [], NaN)).toHaveLength(0);
  });

  it("skips filled / verified / rejected / N-A fields but keeps going", () => {
    const fields = allNull();
    fields.timing_system = filled("chain");
    fields.turbo = { ...emptyField(), rejected: true };
    fields.spark_plug_quantity = { ...emptyField(), flag_reason: "not_applicable" };
    const plan = planSiblingInheritance(fields, everyDonor(), ["fuel_injection"], 12);
    expect(plan).toHaveLength(0);

    const onlyOne = allNull();
    onlyOne.timing_system = filled("chain");
    expect(planSiblingInheritance(onlyOne, everyDonor(), [], 12).map((p) => p.field).sort()).toEqual(
      ["fuel_injection_type", "spark_plug_quantity", "turbo"],
    );
  });

  it("drops donors whose raw column value fails the rule decoder", () => {
    const donors: Record<string, RawSiblingDonor[]> = {
      turbo: [raw({ raw_value: "supercharged" })],
      timing_system: [raw({ raw_value: "??" })],
      spark_plug_quantity: [raw({ raw_value: 99 })],
      fuel_injection_type: [raw({ raw_value: "maybe" })],
    };
    expect(planSiblingInheritance(allNull(), donors, [], 12)).toHaveLength(0);
  });

  it("does not mutate the field map it is planning over", () => {
    const fields = allNull();
    planSiblingInheritance(fields, everyDonor(), [], 12);
    expect(fields.timing_system.value).toBeNull();
  });

  it("applies donor precedence per field", () => {
    const plan = planSiblingInheritance(
      allNull(),
      {
        timing_system: [
          raw({ config_key: "loud", raw_value: "chain", confidence: 0.99 }),
          raw({ config_key: "human", raw_value: "belt", confidence: 0.2, verified: true }),
        ],
      },
      [],
      12,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].result.value).toBe("belt");
    expect(plan[0].result.flag_reason).toContain("human");
  });

  it("returns nothing when there are no donors at all", () => {
    expect(planSiblingInheritance(allNull(), {}, [], 12)).toHaveLength(0);
  });
});

// ─── 6. Env guardrails ────────────────────────────────────────────

describe("env guardrails (read at call time)", () => {
  it("defaults the cap to 12 and rejects garbage", () => {
    expect(siblingInheritMax({})).toBe(12);
    expect(siblingInheritMax({ ENRICHMENT_SIBLING_INHERIT_MAX: "" })).toBe(12);
    expect(siblingInheritMax({ ENRICHMENT_SIBLING_INHERIT_MAX: "abc" })).toBe(12);
    expect(siblingInheritMax({ ENRICHMENT_SIBLING_INHERIT_MAX: "-1" })).toBe(12);
    expect(siblingInheritMax({ ENRICHMENT_SIBLING_INHERIT_MAX: "3" })).toBe(3);
    expect(siblingInheritMax({ ENRICHMENT_SIBLING_INHERIT_MAX: "0" })).toBe(0);
  });

  it("is ON by default and only 'off' disables it", () => {
    expect(siblingInheritEnabled({})).toBe(true);
    expect(siblingInheritEnabled({ ENRICHMENT_SIBLING_INHERIT: "on" })).toBe(true);
    expect(siblingInheritEnabled({ ENRICHMENT_SIBLING_INHERIT: "off" })).toBe(false);
  });

  it("audits at 'info' severity so routine inheritance never floods the review queue", () => {
    // manual_review_queue.list admits any run carrying a non-"info" sanity
    // flag; inheritance is an observability record, not a caught defect.
    expect(SIBLING_INHERIT_FLAG_SEVERITY).toBe("info");
  });
});

// ─── 7. Front wiper driver/passenger split ────────────────────────

describe("parseFrontWiperSizes — the driver/passenger write asymmetry", () => {
  it("splits a stated pair, driver first", () => {
    expect(parseFrontWiperSizes("26/18")).toEqual({ driver: 26, passenger: 18 });
    expect(parseFrontWiperSizes('26"/18"')).toEqual({ driver: 26, passenger: 18 });
    expect(parseFrontWiperSizes("26 and 18")).toEqual({ driver: 26, passenger: 18 });
    expect(parseFrontWiperSizes("26in / 18in")).toEqual({ driver: 26, passenger: 18 });
    expect(parseFrontWiperSizes("22/22")).toEqual({ driver: 22, passenger: 22 });
  });

  it("NEVER copies driver→passenger when only one size is known", () => {
    expect(parseFrontWiperSizes("26")).toEqual({ driver: 26 });
    expect(parseFrontWiperSizes("26 inches")).toEqual({ driver: 26 });
    expect(parseFrontWiperSizes(26)).toEqual({ driver: 26 });
    expect(parseFrontWiperSizes("26").passenger).toBeUndefined();
  });

  it("rejects values that are not plausible inch sizes", () => {
    expect(parseFrontWiperSizes("650mm/450mm")).toEqual({});
    expect(parseFrontWiperSizes("")).toEqual({});
    expect(parseFrontWiperSizes(null)).toEqual({});
    expect(parseFrontWiperSizes(undefined)).toEqual({});
    expect(parseFrontWiperSizes("n/a")).toEqual({});
  });

  it("keeps the first two plausible numbers only", () => {
    expect(parseFrontWiperSizes("26/18/16")).toEqual({ driver: 26, passenger: 18 });
  });
});
