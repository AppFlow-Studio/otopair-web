import { describe, expect, it } from "vitest";
import {
  engineQualifierMatches,
  familyForManual,
  normalizeSpecValue,
  numStr,
  parseSpecPayload,
  SPEC_FIELD_KEYS,
  textStr,
} from "../convex/vehicleEnrichment/manualSpecs";

const CAMRY_ENGINE = { code: "A25A-FKS", displacement_l: 2.5 };

describe("numStr — MUST stay byte-identical to amsoil.ts numStr", () => {
  // reconcileClaims clusters on exact string equality. If this module emitted
  // "4.80" where AMSOIL emits "4.8", two agreeing families would be recorded
  // as a conflict and the corroboration this module exists for would silently
  // not happen. These cases pin the shared format.
  it("canonicalizes trailing zeros the same way", () => {
    expect(numStr("4.80")).toBe("4.8");
    expect(numStr(4.8)).toBe("4.8");
    expect(numStr("1,200")).toBe("1200");
  });

  it("rejects non-positive and unparseable values", () => {
    expect(numStr(0)).toBeNull();
    expect(numStr(-1)).toBeNull();
    expect(numStr("abc")).toBeNull();
    expect(numStr(null)).toBeNull();
  });
});

describe("textStr", () => {
  it("uppercases, collapses whitespace, drops trailing punctuation", () => {
    expect(textStr(" 0w-20 ")).toBe("0W-20");
    expect(textStr("DOT 3.")).toBe("DOT 3");
    expect(textStr("Toyota  Super   Long Life")).toBe("TOYOTA SUPER LONG LIFE");
  });

  it("rejects empty and absurdly long values", () => {
    expect(textStr("   ")).toBeNull();
    expect(textStr("x".repeat(200))).toBeNull();
    expect(textStr(42)).toBeNull();
  });
});

describe("normalizeSpecValue — routes by the field's unit", () => {
  it("numeric units go through numStr, text units through textStr", () => {
    expect(normalizeSpecValue("oil_capacity_qts", "4.80")).toBe("4.8");
    expect(normalizeSpecValue("tire_pressure_front_psi", 35)).toBe("35");
    expect(normalizeSpecValue("oil_viscosity", "0w-20")).toBe("0W-20");
  });

  it("refuses a field it does not own", () => {
    expect(normalizeSpecValue("drain_plug_torque_ft_lbs", "30")).toBeNull();
  });
});

describe("engineQualifierMatches", () => {
  it("accepts an absent qualifier (spec stated once for the vehicle)", () => {
    expect(engineQualifierMatches(null, CAMRY_ENGINE)).toBe(true);
    expect(engineQualifierMatches("  ", CAMRY_ENGINE)).toBe(true);
  });

  it("matches on engine code or displacement, in the forms manuals print", () => {
    expect(engineQualifierMatches("A25A-FKS", CAMRY_ENGINE)).toBe(true);
    expect(engineQualifierMatches("2.5L (A25A-FKS)", CAMRY_ENGINE)).toBe(true);
    expect(engineQualifierMatches("2.5 L 4-cylinder", CAMRY_ENGINE)).toBe(true);
  });

  it("rejects the wrong engine's row rather than guessing", () => {
    expect(engineQualifierMatches("3.5L V6", CAMRY_ENGINE)).toBe(false);
    // A qualifier we cannot confirm against ANY engine is a mismatch, not a pass.
    expect(engineQualifierMatches("2.5L", null)).toBe(false);
  });
});

describe("familyForManual — the mirror rule", () => {
  it("gives OEM-hosted manuals the weight-3 owners_manual family", () => {
    expect(familyForManual("https://assets.sia.toyota.com/x.pdf", "Toyota")).toBe("owners_manual");
  });

  it("demotes a mirror of the same document to aggregator", () => {
    // Heard — a mirror is often the only reachable copy — but never with OEM
    // authority. This is manualLibrary's provenance law at the family level.
    expect(familyForManual("https://manualslib.com/x.pdf", "Toyota")).toBe("aggregator");
  });
});

describe("parseSpecPayload — the identity guard", () => {
  it("emits NOTHING when the document is a different vehicle", () => {
    // The 2019 Forester resolved a real Subaru PDF that was the BRZ Quick
    // Guide. A spec table from the wrong model reads as a perfectly good
    // answer, so this guard is the only thing standing between us and
    // confident, wrong, weight-3 evidence.
    const out = parseSpecPayload(
      {
        document_matches_vehicle: false,
        document_vehicle_text: "2019 Subaru BRZ Quick Guide",
        specs: [
          {
            field_key: "oil_capacity_qts",
            value: 5.1,
            unit_as_printed: "US qts",
            engine_qualifier: null,
            quoted_text: "5.1 qts",
            page_number: 12,
          },
        ],
        notes: null,
      },
      CAMRY_ENGINE,
    );
    expect(out.specs).toHaveLength(0);
    expect(out.rejected).toMatch(/^document_vehicle_mismatch/);
  });
});

describe("parseSpecPayload — fails closed per field", () => {
  const parsed = parseSpecPayload(
    {
      document_matches_vehicle: true,
      document_vehicle_text: "2019 Camry Owner's Manual",
      specs: [
        {
          field_key: "oil_capacity_qts",
          value: 4.8,
          unit_as_printed: "US qts",
          engine_qualifier: "2.5L (A25A-FKS)",
          quoted_text: "Drain and refill with oil filter change 4.5 liters (4.8 US qts)",
          page_number: 552,
        },
        {
          field_key: "oil_viscosity",
          value: "0W-20",
          unit_as_printed: null,
          engine_qualifier: null,
          quoted_text: "SAE 0W-20",
          page_number: 550,
        },
        {
          field_key: "tire_pressure_front_psi",
          value: 35,
          unit_as_printed: "psi",
          engine_qualifier: null,
          quoted_text: "Front 35 psi",
          page_number: 560,
        },
        // An unquotable value cannot be audited — dropped.
        {
          field_key: "lug_nut_torque_ft_lbs",
          value: 76,
          unit_as_printed: "ft-lbf",
          engine_qualifier: null,
          quoted_text: "",
          page_number: null,
        },
        // Right table, wrong row — dropped.
        {
          field_key: "coolant_capacity_qts",
          value: 9.5,
          unit_as_printed: "qts",
          engine_qualifier: "3.5L V6",
          quoted_text: "9.5 qts",
          page_number: 553,
        },
        // Not a field this pass owns — dropped rather than invented.
        {
          field_key: "drain_plug_torque_ft_lbs",
          value: 30,
          unit_as_printed: null,
          engine_qualifier: null,
          quoted_text: "30 ft-lbf",
          page_number: 1,
        },
        // Second opinion on a field already answered — ambiguous, dropped.
        {
          field_key: "oil_viscosity",
          value: "5W-30",
          unit_as_printed: null,
          engine_qualifier: null,
          quoted_text: "or SAE 5W-30",
          page_number: 551,
        },
      ],
      notes: null,
    },
    CAMRY_ENGINE,
  );

  it("keeps only the well-formed, quotable, engine-matched specs", () => {
    expect(parsed.specs.map((s) => s.field_key)).toEqual([
      "oil_capacity_qts",
      "oil_viscosity",
      "tire_pressure_front_psi",
    ]);
  });

  it("normalizes the value and preserves the printed units for audit", () => {
    expect(parsed.specs[0].value).toBe("4.8");
    expect(parsed.specs[0].value_raw).toBe("4.8 US qts");
    expect(parsed.specs[0].quoted_text).toContain("4.8 US qts");
  });

  it("records why each rejected field was dropped", () => {
    expect(parsed.dropped.map((d) => `${d.field_key}:${d.reason.split(":")[0]}`)).toEqual([
      "lug_nut_torque_ft_lbs:no_quote",
      "coolant_capacity_qts:engine_mismatch",
      "drain_plug_torque_ft_lbs:unknown_field",
      "oil_viscosity:duplicate_in_payload",
    ]);
  });
});

describe("parseSpecPayload — never throws (pipeline law: fail open)", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty object", {}],
    ["specs not an array", { document_matches_vehicle: true, specs: "nope" }],
    ["junk inside specs", { document_matches_vehicle: true, specs: [null, 1, "x"] }],
  ])("survives %s", (_label, payload) => {
    expect(() => parseSpecPayload(payload, CAMRY_ENGINE)).not.toThrow();
    expect(parseSpecPayload(payload, CAMRY_ENGINE).specs).toHaveLength(0);
  });
});

describe("field contract", () => {
  it("declares only V4 keys the ledger can key on, with no duplicates", () => {
    expect(new Set(SPEC_FIELD_KEYS).size).toBe(SPEC_FIELD_KEYS.length);
    expect(SPEC_FIELD_KEYS).toContain("oil_capacity_qts");
    // Overlap with AMSOIL is the point — these are where a manual claim turns
    // a single-family 0.6 into a two-family 0.85.
    expect(SPEC_FIELD_KEYS).toEqual(
      expect.arrayContaining(["oil_viscosity", "oil_capacity_qts", "coolant_capacity_qts"]),
    );
  });
});
