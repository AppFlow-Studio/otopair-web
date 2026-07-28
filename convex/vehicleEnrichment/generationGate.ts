/**
 * vehicleEnrichment/generationGate.ts — deterministic chassis-code vs
 * model-year sanity (round 10, batch-11 Tucson).
 *
 * The chassis lookup is a one-shot Haiku web call with no year validation, so
 * launch-overlap years get the WRONG generation stored ("NX4" on a 2021
 * Tucson — the 4th gen launched spring 2021 as MY2022, but the 2021 model
 * year is the TL). A wrong chassis then poisons everything keyed off it
 * (year-band fitment refutes ran on the false premise and killed three
 * correct parts).
 *
 * Generation start/end years are static public facts, so this is a table,
 * not a model call. FAIL-OPEN: a nameplate or code not in the table is
 * accepted as-is — the gate only rejects a code the table POSITIVELY places
 * outside the model year. Ranges use US-market model years, inclusive.
 */

type GenRange = { codes: string[]; from: number; to: number };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** make|model (normalized) → generation ranges. Extend freely; absence = fail-open. */
const GENERATION_TABLE: Record<string, GenRange[]> = {
  "hyundai|tucson": [
    { codes: ["JM"], from: 2005, to: 2009 },
    { codes: ["LM"], from: 2010, to: 2015 },
    { codes: ["TL"], from: 2016, to: 2021 },
    { codes: ["NX4"], from: 2022, to: 2027 },
  ],
  "subaru|crosstrek": [
    { codes: ["GP"], from: 2013, to: 2017 },
    { codes: ["GT"], from: 2018, to: 2023 },
    { codes: ["GU"], from: 2024, to: 2028 },
  ],
  "subaru|forester": [
    { codes: ["SF"], from: 1998, to: 2002 },
    { codes: ["SG"], from: 2003, to: 2008 },
    { codes: ["SH"], from: 2009, to: 2013 },
    { codes: ["SJ"], from: 2014, to: 2018 },
    { codes: ["SK"], from: 2019, to: 2024 },
    { codes: ["SL"], from: 2025, to: 2029 },
  ],
  "toyota|camry": [
    { codes: ["XV40"], from: 2007, to: 2011 },
    { codes: ["XV50"], from: 2012, to: 2017 },
    { codes: ["XV70"], from: 2018, to: 2024 },
    { codes: ["XV80"], from: 2025, to: 2029 },
  ],
  "toyota|rav4": [
    { codes: ["XA20"], from: 2001, to: 2005 },
    { codes: ["XA30"], from: 2006, to: 2012 },
    { codes: ["XA40"], from: 2013, to: 2018 },
    { codes: ["XA50"], from: 2019, to: 2025 },
  ],
  "toyota|corolla": [
    { codes: ["E140", "E150"], from: 2009, to: 2013 },
    { codes: ["E170"], from: 2014, to: 2019 },
    { codes: ["E210"], from: 2020, to: 2025 },
  ],
  "toyota|highlander": [
    { codes: ["XU20"], from: 2001, to: 2007 },
    { codes: ["XU40"], from: 2008, to: 2013 },
    { codes: ["XU50"], from: 2014, to: 2019 },
    { codes: ["XU70"], from: 2020, to: 2025 },
  ],
  "honda|crv": [
    { codes: ["RD"], from: 1997, to: 2006 },
    { codes: ["RE"], from: 2007, to: 2011 },
    { codes: ["RM"], from: 2012, to: 2016 },
    { codes: ["RW", "RT"], from: 2017, to: 2022 },
    { codes: ["RS"], from: 2023, to: 2027 },
  ],
  "honda|accord": [
    { codes: ["CP", "CS"], from: 2008, to: 2012 },
    { codes: ["CR", "CT"], from: 2013, to: 2017 },
    { codes: ["CV"], from: 2018, to: 2022 },
    { codes: ["CY"], from: 2023, to: 2027 },
  ],
  "honda|civic": [
    { codes: ["FB", "FG"], from: 2012, to: 2015 },
    { codes: ["FC", "FK"], from: 2016, to: 2021 },
    { codes: ["FE", "FL"], from: 2022, to: 2026 },
  ],
  "nissan|rogue": [
    { codes: ["S35"], from: 2008, to: 2015 }, // incl. Rogue Select 2014-15
    { codes: ["T32"], from: 2014, to: 2020 },
    { codes: ["T33"], from: 2021, to: 2027 },
  ],
  "ford|f150": [
    { codes: ["P221"], from: 2004, to: 2008 },
    { codes: ["P415"], from: 2009, to: 2014 },
    { codes: ["P552"], from: 2015, to: 2020 },
    { codes: ["P702"], from: 2021, to: 2026 },
  ],
  "bmw|7series": [
    { codes: ["E65", "E66"], from: 2002, to: 2008 },
    { codes: ["F01", "F02"], from: 2009, to: 2015 },
    { codes: ["G11", "G12"], from: 2016, to: 2022 },
    { codes: ["G70"], from: 2023, to: 2028 },
  ],
};

/**
 * Round 11 (batch-11 Equinox): GM-style short engine codes (RPOs) have hard
 * introduction years, and vPIC can return the NEXT year's RPO for the last
 * year of an outgoing generation ("LSD" on a 2024 VIN). Adversarial search
 * structurally cannot refute such a code — it is genuinely valid one model
 * year later on the same nameplate — so validity is a table fact, not a
 * search question. Conservative US-market ranges; absence = unknown.
 */
const ENGINE_CODE_YEAR_TABLE: Record<string, { from: number; to: number; note: string }> = {
  LSD: { from: 2025, to: 2030, note: "GM 1.5T, 4th-gen Equinox (2025+)" },
  LYX: { from: 2018, to: 2024, note: "GM 1.5T, 3rd-gen Equinox/Terrain" },
  LTG: { from: 2013, to: 2021, note: "GM 2.0T" },
  LFX: { from: 2012, to: 2017, note: "GM 3.6 V6 gen-2" },
  LGX: { from: 2016, to: 2022, note: "GM 3.6 V6 gen-3" },
  LAP: { from: 2008, to: 2010, note: "GM 2.2 Ecotec (Cobalt/HHR)" },
  L84: { from: 2019, to: 2027, note: "GM 5.3 V8 DFM" },
  L87: { from: 2019, to: 2027, note: "GM 6.2 V8 DFM" },
};

export type EngineCodeYearVerdict =
  | { known: false }
  | { known: true; ok: true }
  | { known: true; ok: false; reason: string };

export function validateEngineCodeYear(
  code: string | null | undefined,
  year: number | null | undefined,
): EngineCodeYearVerdict {
  if (!code || !year) return { known: false };
  const row = ENGINE_CODE_YEAR_TABLE[norm(code).toUpperCase() as keyof typeof ENGINE_CODE_YEAR_TABLE]
    ?? ENGINE_CODE_YEAR_TABLE[code.trim().toUpperCase()];
  if (!row) return { known: false };
  if (year >= row.from && year <= row.to) return { known: true, ok: true };
  return {
    known: true,
    ok: false,
    reason: `engine code "${code}" (${row.note}) is valid ${row.from}-${row.to}; MY${year} is outside that range`,
  };
}

export type ChassisYearVerdict =
  | { ok: true }
  | { ok: false; reason: string; expectedForYear: string | null };

/**
 * Validate a chassis/generation code against the model year. Returns ok:false
 * ONLY when the table positively places the code outside the year — unknown
 * nameplates and unknown codes fail open.
 */
export function validateChassisCodeYear(
  make: string | null | undefined,
  model: string | null | undefined,
  chassisCode: string | null | undefined,
  year: number | null | undefined,
): ChassisYearVerdict {
  if (!make || !model || !chassisCode || !year) return { ok: true };
  const rows = GENERATION_TABLE[`${norm(make)}|${norm(model)}`];
  if (!rows) return { ok: true };
  const code = norm(chassisCode);
  const matched = rows.find((r) => r.codes.some((c) => norm(c) === code));
  const expected = rows.find((r) => year >= r.from && year <= r.to);
  if (!matched) {
    // Round 11 (batch-11 wave-3 Tucson "LET"): for a nameplate whose full
    // generation set IS in the table, an unrecognized code is garbage, not a
    // market variant — substitute the year's known code instead of failing
    // open (fail-open remains for nameplates the table doesn't cover).
    return {
      ok: false,
      reason: `chassis "${chassisCode}" is not a known generation code for this nameplate`,
      expectedForYear: expected ? expected.codes[0] : null,
    };
  }
  if (year >= matched.from && year <= matched.to) return { ok: true };
  return {
    ok: false,
    reason: `chassis "${chassisCode}" is the ${matched.from}-${matched.to} generation; MY${year} is ${expected ? expected.codes.join("/") : "a different generation"}`,
    expectedForYear: expected ? expected.codes[0] : null,
  };
}
