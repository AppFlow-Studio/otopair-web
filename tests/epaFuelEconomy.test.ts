/**
 * epaFuelEconomy pure helpers — fueleconomy.gov menu parsing, unambiguous
 * engine matching, record parsing, claim emission (Phase 0.5). Fixtures mirror
 * the live www.fueleconomy.gov/ws/rest responses captured Jul 2026 for the
 * 2020 Toyota Camry and 2019 Ford F150 Pickup 4WD:
 *   menu/options: { menuItem: [{ text, value }] } — a SINGLE option collapses
 *                 to a bare object, an unknown year/make/model returns `null`.
 *   vehicle/{id}: flat record, EVERY field a string ("city08":"29",
 *                 "displ":"2.5", "tCharger":"T"|"", "startStop":"Y"|"N").
 * Pipeline law: fail open — malformed input parses to empty/null, never
 * throws — and present-but-wrong is forbidden: the picker returns null for
 * anything ambiguous rather than guessing.
 */
import { describe, it, expect } from "vitest";
import {
  parseEpaMenuOptions,
  parseEpaOptionEngine,
  parseEpaVehicleRecord,
  pickBestEpaVehicle,
  epaRecordToClaims,
  normalizeEpaFuelType,
  describeCoherenceMismatch,
  epaModelNameCandidates,
  type EpaVehicleRecord,
} from "../convex/vehicleEnrichment/epaFuelEconomy";

// ─── Fixtures (captured live Jul 30 2026) ────────────────────────────────

// GET /ws/rest/vehicle/menu/options?year=2020&make=Toyota&model=Camry
const camryMenuFixture = {
  menuItem: [
    { text: "Auto (S8), 6 cyl, 3.5 L", value: "42011" },
    { text: "Auto (S8), 4 cyl, 2.5 L", value: "42015" },
  ],
};

// GET /ws/rest/vehicle/menu/options?year=2019&make=Ford&model=F150 Pickup 4WD
const f150MenuFixture = {
  menuItem: [
    { text: "Auto (S10), 6 cyl, 2.7 L, Turbo", value: "41028" },
    { text: "Auto (S10), 6 cyl, 3.5 L, Turbo", value: "41034" },
    { text: "Auto (S10), 6 cyl, 3.0 L, Diesel, Turbo", value: "41113" },
  ],
};

// GET …model=F150 Pickup 4WD Limited — one option → menuItem is an OBJECT.
const singleOptionMenuFixture = {
  menuItem: { text: "Auto (S10), 6 cyl, 3.5 L, Turbo", value: "41040" },
};

// GET /ws/rest/vehicle/42015 (2020 Camry 2.5 L I4) — scalar subset of the
// live body; every value a string, tCharger/sCharger EMPTY when absent.
const camryRecordFixture = {
  atvType: "",
  city08: "29",
  city08U: "29.0",
  co2: "264",
  co2TailpipeGpm: "264.0",
  comb08: "34",
  comb08U: "33.9783",
  cylinders: "4",
  displ: "2.5",
  drive: "Front-Wheel Drive",
  eng_dscr: "SIDI & PFI",
  feScore: "8",
  fuelCost08: "1800",
  fuelType: "Regular",
  fuelType1: "Regular Gasoline",
  fuelType2: "",
  highway08: "41",
  highway08U: "41.4291",
  id: "42015",
  make: "Toyota",
  model: "Camry",
  startStop: "N",
  trany: "Automatic (S8)",
  year: "2020",
  baseModel: "Camry",
  sCharger: "",
  tCharger: "",
};

// GET /ws/rest/vehicle/41034 (2019 F150 4WD 3.5 L EcoBoost) — turbo "T",
// start-stop "Y".
const f150RecordFixture = {
  atvType: "",
  city08: "17",
  co2TailpipeGpm: "472.0",
  comb08: "19",
  cylinders: "6",
  displ: "3.5",
  drive: "Part-time 4-Wheel Drive",
  fuelCost08: "3250",
  fuelType1: "Regular Gasoline",
  highway08: "23",
  id: "41034",
  make: "Ford",
  model: "F150 Pickup 4WD",
  startStop: "Y",
  trany: "Automatic (S10)",
  year: "2019",
  baseModel: "F150",
  sCharger: "",
  tCharger: "T",
};

// ─── parseEpaMenuOptions ─────────────────────────────────────────────────

describe("parseEpaMenuOptions", () => {
  it("parses the live array shape", () => {
    expect(parseEpaMenuOptions(camryMenuFixture)).toEqual([
      { text: "Auto (S8), 6 cyl, 3.5 L", value: "42011" },
      { text: "Auto (S8), 4 cyl, 2.5 L", value: "42015" },
    ]);
  });

  it("handles the single-option object collapse", () => {
    expect(parseEpaMenuOptions(singleOptionMenuFixture)).toEqual([
      { text: "Auto (S10), 6 cyl, 3.5 L, Turbo", value: "41040" },
    ]);
  });

  it("treats the null body (unknown year/make/model) as genuinely zero options", () => {
    expect(parseEpaMenuOptions(null)).toEqual([]);
  });

  it("fails open to [] on malformed bodies and skips unusable entries", () => {
    expect(parseEpaMenuOptions(undefined)).toEqual([]);
    expect(parseEpaMenuOptions({})).toEqual([]);
    expect(parseEpaMenuOptions("garbage")).toEqual([]);
    expect(parseEpaMenuOptions({ menuItem: "nope" })).toEqual([]);
    expect(
      parseEpaMenuOptions({
        menuItem: [null, 42, { text: "no value" }, { value: "no text" }, { text: "", value: "1" }],
      }),
    ).toEqual([]);
  });
});

// ─── parseEpaOptionEngine ────────────────────────────────────────────────

describe("parseEpaOptionEngine", () => {
  it("parses cylinders, displacement, turbo, diesel, transmission from live text", () => {
    expect(parseEpaOptionEngine("Auto (S8), 4 cyl, 2.5 L")).toEqual({
      displacement_l: 2.5,
      cylinders: 4,
      turbo: false,
      diesel: false,
      transmission: "automatic",
    });
    expect(parseEpaOptionEngine("Auto (S10), 6 cyl, 3.0 L, Diesel, Turbo")).toEqual({
      displacement_l: 3.0,
      cylinders: 6,
      turbo: true,
      diesel: true,
      transmission: "automatic",
    });
    expect(parseEpaOptionEngine("Man 6-spd, 4 cyl, 2.0 L")).toEqual({
      displacement_l: 2.0,
      cylinders: 4,
      turbo: false,
      diesel: false,
      transmission: "manual",
    });
  });

  it("fails open to nulls on EV-style text without engine segments", () => {
    expect(parseEpaOptionEngine("Auto (A1)")).toEqual({
      displacement_l: null,
      cylinders: null,
      turbo: false,
      diesel: false,
      transmission: "automatic",
    });
  });
});

// ─── pickBestEpaVehicle ──────────────────────────────────────────────────

describe("pickBestEpaVehicle", () => {
  const camryOptions = parseEpaMenuOptions(camryMenuFixture);
  const f150Options = parseEpaMenuOptions(f150MenuFixture);

  it("matches the Camry 2.5 L I4 and the 3.5 L V6 to their menu rows", () => {
    expect(
      pickBestEpaVehicle(camryOptions, {
        displacement_l: 2.5,
        cylinders: 4,
        transmission_type: "automatic",
      })?.value,
    ).toBe("42015");
    expect(
      pickBestEpaVehicle(camryOptions, {
        displacement_l: 3.5,
        cylinders: 6,
        transmission_type: null,
      })?.value,
    ).toBe("42011");
  });

  it("isolates one of three same-cylinder-count F-150 engines by displacement", () => {
    expect(
      pickBestEpaVehicle(f150Options, {
        displacement_l: 3.5,
        cylinders: 6,
        transmission_type: null,
      })?.value,
    ).toBe("41034");
    expect(
      pickBestEpaVehicle(f150Options, {
        displacement_l: 2.7,
        cylinders: null, // cylinders unknown — displacement alone suffices here
        transmission_type: null,
      })?.value,
    ).toBe("41028");
  });

  it("tolerates displacement within 0.1 L (menu text rounds) but no further", () => {
    expect(
      pickBestEpaVehicle(camryOptions, {
        displacement_l: 2.4, // e.g. engines row stores 2.4 for the 2AR-family
        cylinders: 4,
        transmission_type: null,
      })?.value,
    ).toBe("42015");
    expect(
      pickBestEpaVehicle(camryOptions, {
        displacement_l: 2.2,
        cylinders: 4,
        transmission_type: null,
      }),
    ).toBeNull();
  });

  it("returns null when several options fit — cylinders alone cannot split the F-150 menu", () => {
    expect(
      pickBestEpaVehicle(f150Options, {
        displacement_l: null,
        cylinders: 6,
        transmission_type: "automatic", // all three are automatic — tiebreak can't help
      }),
    ).toBeNull();
  });

  it("uses transmission only as a tiebreak between otherwise-identical engines", () => {
    const gtiStyle = [
      { text: "Auto (AM-S7), 4 cyl, 2.0 L, Turbo", value: "100" },
      { text: "Man 6-spd, 4 cyl, 2.0 L, Turbo", value: "101" },
    ];
    expect(
      pickBestEpaVehicle(gtiStyle, {
        displacement_l: 2.0,
        cylinders: 4,
        transmission_type: "Manual",
      })?.value,
    ).toBe("101");
    // Transmission unknown → the two variants have different MPG → ambiguous.
    expect(
      pickBestEpaVehicle(gtiStyle, {
        displacement_l: 2.0,
        cylinders: 4,
        transmission_type: null,
      }),
    ).toBeNull();
  });

  it("with NO engine attrs matches only a single-option menu", () => {
    const single = parseEpaMenuOptions(singleOptionMenuFixture);
    expect(
      pickBestEpaVehicle(single, {
        displacement_l: null,
        cylinders: null,
        transmission_type: null,
      })?.value,
    ).toBe("41040");
    expect(
      pickBestEpaVehicle(camryOptions, {
        displacement_l: null,
        cylinders: null,
        transmission_type: null,
      }),
    ).toBeNull();
  });

  it("excludes options without a parseable displacement when the config has one", () => {
    const withEv = [
      { text: "Auto (A1)", value: "900" }, // EV row — no engine text
      { text: "Auto (S8), 4 cyl, 2.5 L", value: "42015" },
    ];
    expect(
      pickBestEpaVehicle(withEv, {
        displacement_l: 2.5,
        cylinders: 4,
        transmission_type: null,
      })?.value,
    ).toBe("42015");
  });

  it("fails open to null on empty input", () => {
    expect(
      pickBestEpaVehicle([], { displacement_l: 2.5, cylinders: 4, transmission_type: null }),
    ).toBeNull();
  });
});

// ─── parseEpaVehicleRecord ───────────────────────────────────────────────

describe("parseEpaVehicleRecord", () => {
  it("parses the live Camry record — string numerics, empty tCharger → turbo false", () => {
    expect(parseEpaVehicleRecord(camryRecordFixture)).toEqual({
      epa_vehicle_id: "42015",
      mpg_city: 29,
      mpg_highway: 41,
      mpg_combined: 34,
      fuel_cost_per_year_usd: 1800,
      co2_gpm: 264.0,
      fuel_type: "Regular Gasoline",
      displacement_l: 2.5,
      cylinders: 4,
      turbo: false,
      supercharger: false,
      start_stop: false,
      atv_type: null, // "" → null
      drive: "Front-Wheel Drive",
      transmission: "Automatic (S8)",
    });
  });

  it('parses the live F-150 record — tCharger "T" → turbo true, startStop "Y" → true', () => {
    const record = parseEpaVehicleRecord(f150RecordFixture);
    expect(record).not.toBeNull();
    expect(record!.epa_vehicle_id).toBe("41034");
    expect(record!.turbo).toBe(true);
    expect(record!.start_stop).toBe(true);
    expect(record!.mpg_city).toBe(17);
    expect(record!.mpg_highway).toBe(23);
    expect(record!.mpg_combined).toBe(19);
    expect(record!.co2_gpm).toBe(472.0);
    expect(record!.fuel_cost_per_year_usd).toBe(3250);
  });

  it("treats zero/blank numerics as absent (an EV's gasoline MPG is 0, not a figure)", () => {
    const record = parseEpaVehicleRecord({
      id: "777",
      city08: "0",
      highway08: "",
      comb08: "not-a-number",
      cylinders: "-1",
    });
    expect(record).toEqual({
      epa_vehicle_id: "777",
      mpg_city: null,
      mpg_highway: null,
      mpg_combined: null,
      fuel_cost_per_year_usd: null,
      co2_gpm: null,
      fuel_type: null,
      displacement_l: null,
      cylinders: null,
      turbo: null,
      supercharger: null,
      start_stop: null,
      atv_type: null,
      drive: null,
      transmission: null,
    });
  });

  it("fails open to null on malformed bodies (no usable id)", () => {
    expect(parseEpaVehicleRecord(null)).toBeNull();
    expect(parseEpaVehicleRecord(undefined)).toBeNull();
    expect(parseEpaVehicleRecord("garbage")).toBeNull();
    expect(parseEpaVehicleRecord({})).toBeNull();
    expect(parseEpaVehicleRecord({ city08: "29" })).toBeNull();
    expect(parseEpaVehicleRecord({ id: "   " })).toBeNull();
  });
});

// ─── epaRecordToClaims ───────────────────────────────────────────────────

describe("epaRecordToClaims", () => {
  const OBSERVED_AT = 1_753_900_000_000;

  it("emits gov/api claims for engine corroboration + the new economy fields", () => {
    const record = parseEpaVehicleRecord(camryRecordFixture)!;
    const claims = epaRecordToClaims(record, OBSERVED_AT);

    // Every claim carries the fixed EPA provenance.
    for (const claim of claims) {
      expect(claim.source_family).toBe("gov");
      expect(claim.method).toBe("api");
      expect(claim.source_domain).toBe("fueleconomy.gov");
      expect(claim.source_url).toBe("https://www.fueleconomy.gov/ws/rest/vehicle/42015");
      expect(claim.observed_at).toBe(OBSERVED_AT);
    }

    const byField = new Map(claims.map((c) => [c.field_key, c]));
    expect([...byField.keys()].sort()).toEqual([
      "co2_gpm",
      "cylinders",
      "displacement_l",
      "fuel_cost_per_year_usd",
      "fuel_type",
      "mpg_city",
      "mpg_combined",
      "mpg_highway",
      "turbo",
    ]);
    expect(byField.get("displacement_l")!.value).toBe("2.5");
    expect(byField.get("cylinders")!.value).toBe("4");
    expect(byField.get("turbo")!.value).toBe("false");
    expect(byField.get("fuel_type")!.value).toBe("gasoline");
    expect(byField.get("fuel_type")!.value_raw).toBe("Regular Gasoline");
    expect(byField.get("mpg_city")!.value).toBe("29");
    expect(byField.get("mpg_highway")!.value).toBe("41");
    expect(byField.get("mpg_combined")!.value).toBe("34");
    expect(byField.get("fuel_cost_per_year_usd")!.value).toBe("1800");
    expect(byField.get("co2_gpm")!.value).toBe("264");
  });

  it('claims turbo "true" for the F-150 EcoBoost', () => {
    const record = parseEpaVehicleRecord(f150RecordFixture)!;
    const turbo = epaRecordToClaims(record, OBSERVED_AT).find((c) => c.field_key === "turbo");
    expect(turbo?.value).toBe("true");
  });

  it("emits NO claim for null fields — a gap is never a guess", () => {
    const sparse: EpaVehicleRecord = {
      epa_vehicle_id: "777",
      mpg_city: null,
      mpg_highway: null,
      mpg_combined: 30,
      fuel_cost_per_year_usd: null,
      co2_gpm: null,
      fuel_type: null,
      displacement_l: null,
      cylinders: null,
      turbo: null,
      supercharger: null,
      start_stop: null,
      atv_type: null,
      drive: null,
      transmission: null,
    };
    const claims = epaRecordToClaims(sparse, OBSERVED_AT);
    expect(claims.map((c) => c.field_key)).toEqual(["mpg_combined"]);
  });
});

// ─── normalizeEpaFuelType ────────────────────────────────────────────────

describe("normalizeEpaFuelType", () => {
  it("maps EPA fuelType1 vocabulary onto the engines-table vocabulary", () => {
    expect(normalizeEpaFuelType("Regular Gasoline")).toBe("gasoline");
    expect(normalizeEpaFuelType("Premium Gasoline")).toBe("gasoline");
    expect(normalizeEpaFuelType("Diesel")).toBe("diesel");
    expect(normalizeEpaFuelType("Gasoline or E85")).toBe("flex-fuel");
    expect(normalizeEpaFuelType("Electricity")).toBe("electric");
  });

  it("passes unrecognized values through lowercased, never invents a bucket", () => {
    expect(normalizeEpaFuelType("Hydrogen")).toBe("hydrogen");
  });
});

// ─── describeCoherenceMismatch ───────────────────────────────────────────

describe("describeCoherenceMismatch", () => {
  const camryRecord = parseEpaVehicleRecord(camryRecordFixture)!;

  it("is null when the engines row agrees (within the 0.1 L band)", () => {
    expect(
      describeCoherenceMismatch({ cylinders: 4, displacement_l: 2.5 }, camryRecord),
    ).toBeNull();
    expect(
      describeCoherenceMismatch({ cylinders: 4, displacement_l: 2.4 }, camryRecord),
    ).toBeNull();
  });

  it("describes cylinder and displacement disagreements", () => {
    expect(describeCoherenceMismatch({ cylinders: 6, displacement_l: 2.5 }, camryRecord)).toBe(
      "cylinders: engines row 6 vs EPA 4",
    );
    expect(describeCoherenceMismatch({ cylinders: 4, displacement_l: 3.5 }, camryRecord)).toBe(
      "displacement_l: engines row 3.5 vs EPA 2.5",
    );
    expect(describeCoherenceMismatch({ cylinders: 6, displacement_l: 3.5 }, camryRecord)).toBe(
      "cylinders: engines row 6 vs EPA 4; displacement_l: engines row 3.5 vs EPA 2.5",
    );
  });

  it("cannot fire on fields unknown on either side", () => {
    expect(
      describeCoherenceMismatch({ cylinders: null, displacement_l: null }, camryRecord),
    ).toBeNull();
    const sparse = { ...camryRecord, cylinders: null, displacement_l: null };
    expect(describeCoherenceMismatch({ cylinders: 6, displacement_l: 3.5 }, sparse)).toBeNull();
  });
});

// ─── epaModelNameCandidates ──────────────────────────────────────────────

describe("epaModelNameCandidates", () => {
  it("without a drivetrain tries the exact name, then the hyphen-stripped variant", () => {
    expect(epaModelNameCandidates("F-150")).toEqual(["F-150", "F150"]);
    expect(epaModelNameCandidates("CX-5")).toEqual(["CX-5", "CX5"]);
    expect(epaModelNameCandidates("Camry")).toEqual(["Camry"]);
  });

  it("tries drive-suffixed names FIRST — the bare name can be the other drivetrain's ratings", () => {
    // EPA lists "Crosstrek AWD" (verified live Jul 2026); "Camry" + "Camry AWD"
    // coexist for AWD-optional years, so an AWD config must not take "Camry".
    expect(epaModelNameCandidates("Crosstrek", "AWD")).toEqual(["Crosstrek AWD", "Crosstrek"]);
    expect(epaModelNameCandidates("F-150", "4WD")).toEqual([
      "F-150 4WD",
      "F150 4WD",
      "F-150",
      "F150",
    ]);
  });

  it("maps FWD/RWD to the truck-style 2WD fallback and normalizes 4x4", () => {
    expect(epaModelNameCandidates("Colorado", "RWD")).toEqual([
      "Colorado RWD",
      "Colorado 2WD",
      "Colorado",
    ]);
    expect(epaModelNameCandidates("Escape", "FWD")).toEqual([
      "Escape FWD",
      "Escape 2WD",
      "Escape",
    ]);
    expect(epaModelNameCandidates("Tacoma", "4x4")).toEqual(["Tacoma 4WD", "Tacoma"]);
  });

  it("ignores unrecognized drivetrain strings rather than inventing a suffix", () => {
    expect(epaModelNameCandidates("Camry", "front-biased")).toEqual(["Camry"]);
  });

  it("fails open to no candidates on blank input", () => {
    expect(epaModelNameCandidates("")).toEqual([]);
    expect(epaModelNameCandidates("   ")).toEqual([]);
  });
});

// ─── epaModelNameCandidates: TRIM-aware resolution (2026-08-01) ───────────
//
// Measured live that day: bare-model lookups resolved 0 of 6 audited vehicles,
// because EPA bakes the trim into the model name ("X5 xDrive40i" exists,
// "X5" returns null). Every expectation below was checked against
// /ws/rest/vehicle/menu/model for that year+make before being written here.

describe("epaModelNameCandidates — trim-aware (live-verified names)", () => {
  const firstMatch = (cands: string[], epaModels: string[]): string | null =>
    cands.find((c) => epaModels.includes(c)) ?? null;

  it("resolves a trim-in-model name: EPA has 'X5 xDrive40i', not 'X5'", () => {
    // Live 2019 BMW menu: ['X5 xDrive40i', 'X5 xDrive50i'] — no bare 'X5'.
    const cands = epaModelNameCandidates("X5", "AWD", "xDrive40i", "BMW");
    expect(firstMatch(cands, ["X5 xDrive40i", "X5 xDrive50i"])).toBe("X5 xDrive40i");
  });

  it("resolves a family model from its trim: 'GLC-Class' -> 'GLC300 4matic'", () => {
    const cands = epaModelNameCandidates("GLC-Class", "AWD", "GLC300-4M", "Mercedes-Benz");
    expect(firstMatch(cands, ["GLC300", "GLC300 4matic", "GLC300 4matic Coupe"])).toBe(
      "GLC300 4matic",
    );
  });

  it("prefers the AWD variant over the FWD one: 'RX 350 AWD', not 'RX 350'", () => {
    const cands = epaModelNameCandidates("RX", "4WD", "350 Standard", "Lexus");
    expect(firstMatch(cands, ["RX 350", "RX 350 AWD", "RX 350 L"])).toBe("RX 350 AWD");
  });

  it("uses the brand AWD word EPA actually prints: 'Atlas 4motion'", () => {
    const cands = epaModelNameCandidates("Atlas", "AWD", "V6 SE", "Volkswagen");
    expect(firstMatch(cands, ["Atlas", "Atlas 4motion"])).toBe("Atlas 4motion");
  });

  // ── The regression this ordering exists to prevent. ──
  // A truncated base plus a drive token can spell a DIFFERENT REAL CAR.
  // "911 Carrera" + "4" = "911 Carrera 4" (379 hp) when the vehicle is a
  // Carrera 4S (443 hp) — an exact-match lookup cannot catch that, because the
  // wrong candidate is a valid model. Full trim must be exhausted first, and
  // Porsche must contribute no AWD token.
  it("never downgrades a Carrera 4S to a Carrera 4", () => {
    const epa = ["911 Carrera", "911 Carrera 4", "911 Carrera 4S", "911 Carrera S"];
    const cands = epaModelNameCandidates("911", "AWD", "Carrera 4S", "Porsche");
    expect(firstMatch(cands, epa)).toBe("911 Carrera 4S");
    expect(cands).not.toContain("911 Carrera 4");
  });

  it("resolves a bare-trim supercar name: '911 GT3 RS'", () => {
    const cands = epaModelNameCandidates("911", "RWD", "GT3 RS", "Porsche");
    expect(firstMatch(cands, ["911 GT3", "911 GT3 RS", "911 Carrera"])).toBe("911 GT3 RS");
  });

  it("still resolves a plain model whose EPA name carries no trim", () => {
    // 2019 Toyota lists a bare 'Camry'; a FWD config must reach it.
    const cands = epaModelNameCandidates("Camry", "4x2", "L/LE/SE/XLE", "Toyota");
    expect(firstMatch(cands, ["Camry", "Camry Hybrid", "Camry AWD"])).toBe("Camry");
  });

  it("keeps the pre-existing drive-suffix-before-bare order within one base", () => {
    // Unchanged behaviour: hyphen spellings are one rung, suffix first.
    expect(epaModelNameCandidates("F-150", "4WD")).toEqual([
      "F-150 4WD",
      "F150 4WD",
      "F-150",
      "F150",
    ]);
    expect(epaModelNameCandidates("Crosstrek", "AWD")).toEqual(["Crosstrek AWD", "Crosstrek"]);
  });
});
