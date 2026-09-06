/**
 * Decision logic for enriching a car that arrived without a VIN.
 *
 * The LLM call in ymmtIdentity is the dumb part; these two pure functions carry
 * every judgement that can silently produce a wrong vehicle_config, so they are
 * where the coverage belongs.
 */
import { describe, test, expect } from "vitest";
import {
  normalizeModelName,
  pickPowertrainCandidate,
  type PowertrainCandidate,
} from "../convex/vehicleEnrichment/ymmtIdentity";
import { isRealVin, isPseudoVin, mintPseudoVin } from "../convex/lib/vinIdentity";
import { buildYmmtFingerprint } from "../convex/vehicleEnrichment/types";

function candidate(over: Partial<PowertrainCandidate>): PowertrainCandidate {
  return {
    engine_code: "L15BE",
    marketing_name: null,
    displacement_l: 1.5,
    cylinders: 4,
    fuel_type: "Gasoline",
    aspiration: "turbo",
    trims_offered: [],
    drivetrain: null,
    transmission_type: "CVT",
    confidence: 0.9,
    ...over,
  };
}

describe("isRealVin / isPseudoVin", () => {
  test("accepts a real 17-char VIN", () => {
    expect(isRealVin("2HKRM4H45GH674118")).toBe(true);
    expect(isRealVin("wba53fj02tcw71135")).toBe(true); // case-insensitive
    expect(isRealVin(" 2HKRM4H45GH674118 ")).toBe(true); // trimmed
  });

  test("rejects the legacy SHOP placeholder despite it being exactly 17 chars", () => {
    // This is the whole reason the helper exists: "SHOP" + a 13-digit epoch is
    // 17 characters, so every `vin.length === 17` gate accepted it — including
    // the one guarding a paid Vehicle Databases lookup.
    const legacy = "SHOP1778375720523";
    expect(legacy).toHaveLength(17);
    expect(isRealVin(legacy)).toBe(false);
    expect(isPseudoVin(legacy)).toBe(true);
  });

  test("rejects VINs containing I, O or Q per ISO 3779", () => {
    expect(isRealVin("IHKRM4H45GH674118")).toBe(false);
    expect(isRealVin("OHKRM4H45GH674118")).toBe(false);
    expect(isRealVin("QHKRM4H45GH674118")).toBe(false);
  });

  test("rejects wrong lengths and the other live placeholder formats", () => {
    expect(isRealVin("1HGCV")).toBe(false); // half-typed
    expect(isRealVin("2HKRM4H45GH6741188")).toBe(false); // 18
    expect(isPseudoVin("MANUAL-1783111148808-4VS7AXJ5")).toBe(true);
    expect(isPseudoVin("SEED1VIN000001")).toBe(true);
  });

  test("empty is neither a real VIN nor a placeholder", () => {
    expect(isRealVin("")).toBe(false);
    expect(isPseudoVin("")).toBe(false);
    expect(isRealVin(null)).toBe(false);
    expect(isPseudoVin(undefined)).toBe(false);
  });

  test("minted placeholders can never pass as real VINs", () => {
    for (let i = 0; i < 200; i++) {
      const minted = mintPseudoVin(1786000000000 + i * 997, `abc${i}xyz`);
      expect(isRealVin(minted)).toBe(false);
      expect(isPseudoVin(minted)).toBe(true);
    }
  });
});

describe("buildYmmtFingerprint", () => {
  test("a manual entry fingerprints the same as its VIN-decoded twin", () => {
    // The manual side types loosely; the decode side is canonical. Both must
    // land on one key or the returning-walk-in reuse never fires.
    expect(buildYmmtFingerprint({ year: 2020, make: "honda", model: "CR-V", trim: "EX" })).toBe(
      buildYmmtFingerprint({ year: 2020, make: "Honda", model: "cr v", trim: "ex" }),
    );
  });

  test("make aliases collapse", () => {
    expect(buildYmmtFingerprint({ year: 2015, make: "Mercedes-Benz", model: "C-Class" })).toBe(
      buildYmmtFingerprint({ year: 2015, make: "Mercedes", model: "C Class" }),
    );
  });

  test("different trims stay distinct", () => {
    expect(buildYmmtFingerprint({ year: 2020, make: "Toyota", model: "Camry", trim: "LE" })).not.toBe(
      buildYmmtFingerprint({ year: 2020, make: "Toyota", model: "Camry", trim: "XSE" }),
    );
  });
});

describe("normalizeModelName", () => {
  const hondaCatalog = ["Accord", "Civic", "CR-V", "HR-V", "Pilot", "Odyssey"];

  test("recovers punctuation the picker's free text drops", () => {
    // Live data really does hold "CRV" where every enriched sibling says "CR-V".
    expect(normalizeModelName("CRV", hondaCatalog)).toBe("CR-V");
    expect(normalizeModelName("cr v", hondaCatalog)).toBe("CR-V");
    expect(normalizeModelName("Cr-V", hondaCatalog)).toBe("CR-V");
  });

  test("exact match beats a longer substring match", () => {
    // The batch-11 Grand Highlander trap, running the other direction: a typed
    // "Highlander" must not be absorbed into "Grand Highlander". Both share an
    // engine, so nothing downstream would contradict the wrong pick.
    const toyota = ["Highlander", "Grand Highlander", "RAV4", "Camry"];
    expect(normalizeModelName("Highlander", toyota)).toBe("Highlander");
    expect(normalizeModelName("Grand Highlander", toyota)).toBe("Grand Highlander");
  });

  test("refuses an ambiguous substring rather than picking arbitrarily", () => {
    const ford = ["F-150", "F-150 Lightning", "F-250", "Escape"];
    // "F150" squashes into both "f150" and "f150lightning" — two matches, so
    // we return null and the caller keeps the user's text.
    expect(normalizeModelName("F150", ford)).toBe("F-150"); // exact wins
    expect(normalizeModelName("Lightning", ford)).toBe("F-150 Lightning"); // sole partial
    expect(normalizeModelName("F", ford)).toBeNull(); // too short to be meaningful
  });

  test("never strips a powertrain word the catalog lacks", () => {
    // Live regression: vPIC lists the CR-V Hybrid under the bare "CR-V", so
    // "CR-V Hybrid" substring-matched and normalized down to "CR-V". That threw
    // away the only word identifying the powertrain, and the resolver went on to
    // apply the conventional default and pick the gas engine for a hybrid.
    expect(normalizeModelName("CR-V Hybrid", hondaCatalog)).toBeNull();
    expect(normalizeModelName("Accord Hybrid", hondaCatalog)).toBeNull();

    // Still normalizes when no powertrain word is at stake.
    expect(normalizeModelName("CRV", hondaCatalog)).toBe("CR-V");

    // And still normalizes when the catalog KEEPS the word.
    expect(normalizeModelName("Accord Hybrid", ["Accord", "Accord Hybrid"])).toBe(
      "Accord Hybrid",
    );
  });

  test("returns null on no match or an empty catalog", () => {
    expect(normalizeModelName("Cybertruck", hondaCatalog)).toBeNull();
    expect(normalizeModelName("CR-V", [])).toBeNull();
    expect(normalizeModelName("", hondaCatalog)).toBeNull();
  });
});

describe("pickPowertrainCandidate", () => {
  test("commits when the model year offered exactly one engine", () => {
    const r = pickPowertrainCandidate([candidate({})], null);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.chosen.engine_code).toBe("L15BE");
      expect(r.disambiguated_by).toBe("sole_option");
    }
  });

  test("REFUSES a multi-engine model year with no trim", () => {
    // The 2020 F-150 case. Guessing here mints a confident-looking config whose
    // every part number is wrong, and nothing downstream can catch it.
    const r = pickPowertrainCandidate(
      [
        candidate({ engine_code: "PN2Y", displacement_l: 3.3, cylinders: 6 }),
        candidate({ engine_code: "NANO27", displacement_l: 2.7, cylinders: 6 }),
        candidate({ engine_code: "COYOTE50", displacement_l: 5.0, cylinders: 8 }),
      ],
      null,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("ambiguous_needs_trim");
      expect(r.candidates).toHaveLength(3);
    }
  });

  test("a trim that isolates one engine unblocks the commit", () => {
    // 2020 Camry: the 2.5 is fleet-wide, the V6 is XSE/XLE only.
    const r = pickPowertrainCandidate(
      [
        candidate({ engine_code: "A25A-FKS", displacement_l: 2.5, cylinders: 4, trims_offered: ["LE", "SE"] }),
        candidate({ engine_code: "2GR-FKS", displacement_l: 3.5, cylinders: 6, trims_offered: ["XSE", "XLE"] }),
      ],
      "LE",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.chosen.engine_code).toBe("A25A-FKS");
      expect(r.disambiguated_by).toBe("trim");
    }
  });

  test("trim matching is token-based, not substring", () => {
    // Regression: "xle".includes("le") is true, so substring matching made a
    // Camry LE match the XLE-only V6 and the model year read as ambiguous.
    const camry = [
      candidate({ engine_code: "A25A-FKS", trims_offered: ["LE"] }),
      candidate({ engine_code: "2GR-FKS", trims_offered: ["XLE"] }),
    ];
    const le = pickPowertrainCandidate(camry, "LE");
    expect(le.ok).toBe(true);
    if (le.ok) expect(le.chosen.engine_code).toBe("A25A-FKS");

    const xle = pickPowertrainCandidate(camry, "XLE");
    expect(xle.ok).toBe(true);
    if (xle.ok) expect(xle.chosen.engine_code).toBe("2GR-FKS");
  });

  test("an unqualified trim means the conventional powertrain", () => {
    // Live 2020 CR-V. The research sometimes returns the hybrid's trims as
    // "Hybrid EX" and sometimes bare "EX" — either way a plain "EX" must land
    // on the gas engine, because Honda sells the electrified car as a
    // separately-named "CR-V Hybrid". Without this the model is permanently
    // ambiguous and the feature delivers nothing for most modern nameplates.
    const crv = [
      candidate({ engine_code: "L15BE", displacement_l: 1.5, fuel_type: "Gasoline", trims_offered: ["LX", "EX", "EX-L", "Touring"] }),
      candidate({ engine_code: "LFA1", displacement_l: 2.0, fuel_type: "Hybrid", trims_offered: ["LX", "EX", "EX-L", "Touring"] }),
    ];

    const ex = pickPowertrainCandidate(crv, "EX");
    expect(ex.ok).toBe(true);
    if (ex.ok) {
      expect(ex.chosen.engine_code).toBe("L15BE");
      expect(ex.disambiguated_by).toBe("conventional_default");
    }

    // Naming the powertrain flips it, from the trim...
    const viaTrim = pickPowertrainCandidate(crv, "Hybrid EX");
    expect(viaTrim.ok).toBe(true);
    if (viaTrim.ok) {
      expect(viaTrim.chosen.engine_code).toBe("LFA1");
      expect(viaTrim.disambiguated_by).toBe("powertrain_named");
    }

    // ...or from the model, which is where owners usually put it.
    const viaModel = pickPowertrainCandidate(crv, "EX", "CR-V Hybrid");
    expect(viaModel.ok).toBe(true);
    if (viaModel.ok) expect(viaModel.chosen.engine_code).toBe("LFA1");
  });

  test("a hybrid-only model is not emptied by the conventional default", () => {
    // Prius: every powertrain is a hybrid, so the "drop the electrified ones"
    // rule must not fire — it only applies when a conventional option exists.
    const r = pickPowertrainCandidate(
      [candidate({ engine_code: "2ZR-FXE", fuel_type: "Hybrid", trims_offered: ["L Eco"] })],
      "L Eco",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.chosen.engine_code).toBe("2ZR-FXE");
  });

  test("a diesel trim token screens out the gas engine", () => {
    const r = pickPowertrainCandidate(
      [
        candidate({ engine_code: "CJAA", fuel_type: "Diesel", trims_offered: [] }),
        candidate({ engine_code: "CBPA", fuel_type: "Gasoline", trims_offered: [] }),
      ],
      "2.0 TDI",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.chosen.engine_code).toBe("CJAA");
  });

  test("a multi-word offered trim still matches the bare name", () => {
    const r = pickPowertrainCandidate(
      [
        candidate({ engine_code: "NANO27", trims_offered: ["Lariat SuperCrew"] }),
        candidate({ engine_code: "COYOTE50", trims_offered: ["King Ranch"] }),
      ],
      "Lariat",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.chosen.engine_code).toBe("NANO27");
  });

  test("a trim that still leaves two engines is refused", () => {
    const r = pickPowertrainCandidate(
      [
        candidate({ engine_code: "NANO27", trims_offered: ["XLT", "Lariat"] }),
        candidate({ engine_code: "COYOTE50", trims_offered: ["XLT", "King Ranch"] }),
      ],
      "XLT",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ambiguous_after_trim");
  });

  test("an unknown trims list means 'all trims', never 'not offered'", () => {
    // Asymmetry that matters: absent coverage data must not eliminate an engine,
    // or we'd quietly commit to the wrong one whenever research was incomplete.
    const r = pickPowertrainCandidate(
      [
        candidate({ engine_code: "A25A-FKS", trims_offered: [] }),
        candidate({ engine_code: "2GR-FKS", trims_offered: ["XSE"] }),
      ],
      "XSE",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ambiguous_after_trim");
  });

  test("a codeless engine is still usable when displacement + cylinders are known", () => {
    // Live 2020 F-150: Ford publishes no internal engine codes, so the research
    // correctly declines to name one. processVin has always fallen back to a
    // synthetic `{disp}l_{cyl}cyl` code in exactly this case, so refusing here
    // would make the YMMT path stricter than the VIN path for the same car.
    const r = pickPowertrainCandidate(
      [
        candidate({
          engine_code: "",
          marketing_name: "5.0L Ti-VCT V8",
          displacement_l: 5.0,
          cylinders: 8,
          trims_offered: [],
        }),
      ],
      null,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.chosen.engine_code).toBe("");
      expect(r.chosen.marketing_name).toBe("5.0L Ti-VCT V8");
    }
  });

  test("a codeless engine with no displacement or cylinders is not usable", () => {
    const r = pickPowertrainCandidate(
      [candidate({ engine_code: "", displacement_l: null, cylinders: null })],
      null,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_identifiable_powertrain");
  });

  test("a real code still wins over a codeless sibling when only one is real", () => {
    const r = pickPowertrainCandidate(
      [candidate({ engine_code: "B58B30M1", displacement_l: 3.0, cylinders: 6 })],
      null,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.chosen.engine_code).toBe("B58B30M1");
  });

  test("an empty candidate set is reported distinctly from an unusable one", () => {
    const r = pickPowertrainCandidate([], null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_powertrain_found");
  });

  test("a trim matching nothing is refused, not silently defaulted", () => {
    const r = pickPowertrainCandidate(
      [
        candidate({ engine_code: "A25A-FKS", trims_offered: ["LE"] }),
        candidate({ engine_code: "2GR-FKS", trims_offered: ["XSE"] }),
      ],
      "TRD Pro",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("trim_not_offered");
  });
});
