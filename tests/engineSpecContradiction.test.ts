/**
 * Deterministic engine-code ↔ decoded-engine cross-check (round 3, Aug 2026).
 *
 * Live defect: VIN WP1AA2A59NLB00450, a 2022 Porsche Macan that vPIC decodes
 * as 2.0L / 4-cyl / 261 hp (the EA888), was stored under config key
 * `2022_porsche_macan_type_95b_ea839`. EA839 is the 2.9L V6 biturbo of the
 * Macan S/GTS/Turbo — VDB had decoded the trim as "S". It survived every
 * guard because it is a real Porsche code in real code format, so
 * isSyntheticEngineCode cannot see it and adversarial web search cannot
 * refute it (EA839 genuinely exists on a 2022 Macan).
 */
import { describe, test, expect } from "vitest";
import {
  contradictsDecodedEngine,
  lookupKnownEngineCode,
} from "../convex/vehicleEnrichment/utils/engineLookup";

describe("contradictsDecodedEngine — the live Macan defect", () => {
  test("EA839 (2.9 V6) is rejected against the decoded 2.0L 4-cyl", () => {
    const verdict = contradictsDecodedEngine("EA839", {
      displacementL: "2.0",
      cylinders: 4,
    });
    expect(verdict.known).toBe(true);
    expect(verdict.known && verdict.contradicts).toBe(true);
    expect(verdict.known && verdict.contradicts && verdict.reason).toMatch(/2\.9/);
  });

  test("EA888 — the engine this VIN actually has — passes", () => {
    const verdict = contradictsDecodedEngine("EA888", {
      displacementL: "2.0",
      cylinders: 4,
    });
    expect(verdict).toEqual({ known: true, contradicts: false });
  });

  test("DMTD — the code the fixed pipeline actually resolved — passes", () => {
    // VAG's per-application letter code for the 95B Macan's 2.0 TFSI.
    expect(
      contradictsDecodedEngine("DMTD", { displacementL: "2", cylinders: 4 }),
    ).toEqual({ known: true, contradicts: false });
    // ...and is itself now checkable: it is not a 2.9 V6.
    expect(
      contradictsDecodedEngine("DMTD", { displacementL: "2.9", cylinders: 6 }),
    ).toMatchObject({ known: true, contradicts: true });
  });

  test("EA839 on the Macan S it belongs to (2.9L V6) passes", () => {
    const verdict = contradictsDecodedEngine("EA839", {
      displacementL: "2.9",
      cylinders: 6,
    });
    expect(verdict).toEqual({ known: true, contradicts: false });
  });
});

describe("contradictsDecodedEngine — fails open, never on absence", () => {
  test("unknown code returns no opinion", () => {
    expect(
      contradictsDecodedEngine("ZZ999XYZ", { displacementL: "2.0", cylinders: 4 }),
    ).toEqual({ known: false });
  });

  test("known code with a fully undecoded engine returns no opinion", () => {
    expect(contradictsDecodedEngine("EA839", {})).toEqual({ known: false });
    expect(
      contradictsDecodedEngine("EA839", { displacementL: null, cylinders: null }),
    ).toEqual({ known: false });
    expect(
      contradictsDecodedEngine("EA839", { displacementL: "", cylinders: 0 }),
    ).toEqual({ known: false });
  });

  test("empty / too-short codes return no opinion", () => {
    for (const code of ["", null, undefined, "B4"]) {
      expect(contradictsDecodedEngine(code, { displacementL: 2.0, cylinders: 4 })).toEqual({
        known: false,
      });
    }
  });

  test("one decoded signal is enough — displacement alone, cylinders alone", () => {
    expect(
      contradictsDecodedEngine("EA839", { displacementL: "2.0" }),
    ).toMatchObject({ known: true, contradicts: true });
    expect(
      contradictsDecodedEngine("EA839", { cylinders: 4 }),
    ).toMatchObject({ known: true, contradicts: true });
  });

  test("a family that genuinely spans cylinder counts makes no cylinder claim", () => {
    // VW EA211 ships as both a 1.0 three-cylinder and a 1.5 four.
    expect(
      contradictsDecodedEngine("EA211", { displacementL: "1.0", cylinders: 3 }),
    ).toEqual({ known: true, contradicts: false });
    expect(
      contradictsDecodedEngine("EA211", { displacementL: "1.5", cylinders: 4 }),
    ).toEqual({ known: true, contradicts: false });
  });
});

describe("contradictsDecodedEngine — family prefix matching", () => {
  test("full variant codes resolve to their family", () => {
    const cases: Array<[string, number, number]> = [
      ["B48B20M1", 2.0, 4], // BMW 2.0 I4
      ["2GR-FE", 3.5, 6], // Toyota 3.5 V6
      ["M256E30DEHLG", 3.0, 6], // Mercedes 3.0 I6
      ["PR25DD", 2.5, 4], // Nissan/Mitsubishi 2.5 I4
      ["PY-VPS", 2.5, 4], // Mazda Skyactiv-G 2.5
    ];
    for (const [code, disp, cyl] of cases) {
      expect(
        contradictsDecodedEngine(code, { displacementL: disp, cylinders: cyl }),
        code,
      ).toEqual({ known: true, contradicts: false });
    }
  });

  test("a real code on the wrong engine is caught across makes", () => {
    // BMW B58 is the 3.0 I6 — not a 2.0 four.
    expect(
      contradictsDecodedEngine("B58B30M1", { displacementL: 2.0, cylinders: 4 }),
    ).toMatchObject({ known: true, contradicts: true });
    // Toyota 2GR is the 3.5 V6 — not a 2.5 four.
    expect(
      contradictsDecodedEngine("2GR-FKS", { displacementL: 2.5, cylinders: 4 }),
    ).toMatchObject({ known: true, contradicts: true });
    // The pre-2019 Nissan 2.5 is still a 2.5 — same displacement, so this
    // table has no opinion (generation is generationGate.ts's job, not ours).
    expect(
      contradictsDecodedEngine("QR25DE", { displacementL: 2.5, cylinders: 4 }),
    ).toEqual({ known: true, contradicts: false });
  });

  test("Toyota M20A is not swallowed by a shorter unrelated prefix", () => {
    expect(
      contradictsDecodedEngine("M20A-FKS", { displacementL: 2.0, cylinders: 4 }),
    ).toEqual({ known: true, contradicts: false });
  });

  test("displacement tolerance absorbs rounding, not a different engine", () => {
    // 2.9 TFSI is badged 2.9 but measures 2894cc.
    expect(
      contradictsDecodedEngine("EA839", { displacementL: 2.89, cylinders: 6 }),
    ).toEqual({ known: true, contradicts: false });
    // A 2.5 is not a 2.9 by any rounding.
    expect(
      contradictsDecodedEngine("EA839", { displacementL: 2.5, cylinders: 6 }),
    ).toMatchObject({ known: true, contradicts: true });
  });

  test("the displacement-in-cylinders corruption does not read as agreement", () => {
    // Historical corruption class: cylinders holding the displacement float.
    // A 4.4L V8 code with cylinders=4.4 must not pass as "4 cylinders".
    expect(
      contradictsDecodedEngine("N63B44O2", { displacementL: 4.4, cylinders: 4.4 }),
    ).toMatchObject({ known: true, contradicts: true });
  });
});

describe("lookupKnownEngineCode — year-pinned forward fallback", () => {
  test("2022 Mitsubishi Outlander 2.5 resolves to the Nissan-shared PR25DD", () => {
    const hit = lookupKnownEngineCode("Mitsubishi", "Outlander", 2022, {
      displacementL: "2.5",
      cylinders: 4,
    });
    expect(hit?.code).toBe("PR25DD");
  });

  test("the Altima generation split the search prompt only described in prose", () => {
    expect(
      lookupKnownEngineCode("Nissan", "Altima", 2020, { displacementL: 2.5, cylinders: 4 })?.code,
    ).toBe("PR25DD");
    expect(
      lookupKnownEngineCode("Nissan", "Altima", 2015, { displacementL: 2.5, cylinders: 4 })?.code,
    ).toBe("QR25DE");
  });

  test("Outlander Sport is a different nameplate with different engines", () => {
    expect(
      lookupKnownEngineCode("Mitsubishi", "Outlander Sport", 2022, {
        displacementL: 2.0,
        cylinders: 4,
      })?.code,
    ).toBe("4B11");
    // The Outlander's 2.5 matches no Outlander Sport row — a corrupted model
    // yields no code rather than a confidently wrong one.
    expect(
      lookupKnownEngineCode("Mitsubishi", "Outlander Sport", 2022, {
        displacementL: 2.5,
        cylinders: 4,
      }),
    ).toBeNull();
  });

  test("returns null rather than guessing", () => {
    // Year outside the generation.
    expect(
      lookupKnownEngineCode("Mitsubishi", "Outlander", 2018, { displacementL: 2.5, cylinders: 4 }),
    ).toBeNull();
    // Displacement the row doesn't describe (Outlander PHEV 2.4).
    expect(
      lookupKnownEngineCode("Mitsubishi", "Outlander", 2023, { displacementL: 2.4, cylinders: 4 }),
    ).toBeNull();
    // Cylinder count disagrees.
    expect(
      lookupKnownEngineCode("Mitsubishi", "Outlander", 2022, { displacementL: 2.5, cylinders: 6 }),
    ).toBeNull();
    // No engine evidence at all.
    expect(lookupKnownEngineCode("Mitsubishi", "Outlander", 2022, {})).toBeNull();
    // Nameplate not in the table.
    expect(
      lookupKnownEngineCode("Porsche", "Macan", 2022, { displacementL: 2.0, cylinders: 4 }),
    ).toBeNull();
    // Missing identity.
    expect(
      lookupKnownEngineCode(null, "Outlander", 2022, { displacementL: 2.5 }),
    ).toBeNull();
  });

  test("every code the forward table returns agrees with its own facts", () => {
    // The two tables must never disagree, or the pipeline would reject the
    // code it just resolved.
    const rows: Array<[string, string, number, number, number]> = [
      ["Mitsubishi", "Outlander", 2022, 2.5, 4],
      ["Mitsubishi", "Outlander Sport", 2020, 2.0, 4],
      ["Mitsubishi", "Outlander Sport", 2020, 2.4, 4],
      ["Nissan", "Altima", 2020, 2.5, 4],
      ["Nissan", "Altima", 2015, 2.5, 4],
      ["Nissan", "Rogue", 2018, 2.5, 4],
    ];
    for (const [make, model, year, displacementL, cylinders] of rows) {
      const hit = lookupKnownEngineCode(make, model, year, { displacementL, cylinders });
      expect(hit, `${year} ${make} ${model}`).not.toBeNull();
      expect(
        contradictsDecodedEngine(hit!.code, { displacementL, cylinders }),
        `${hit!.code} vs ${displacementL}L/${cylinders}cyl`,
      ).toEqual({ known: true, contradicts: false });
    }
  });
});
