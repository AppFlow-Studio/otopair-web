// =============================================================================
// adapter_amsoil.test.ts — pure-parser tests against live-captured fixtures
// (amsoil.com auto/light-truck lookup, captured 2026-07-30).
//
// HTML fixtures are TRIMMED verbatim segments of the real vehicle pages
// (see the provenance comment inside each file); JSON fixtures are verbatim
// api-1.amsoil.com/api/Fitment responses.
//
//   camry-2020-25l.html   2020 Toyota Camry 2.5L A25A-FKS — carries all four
//                         spec rows (viscosity w/ 0W-20 fallback sentence,
//                         capacity, drain-plug torque, coolant capacity) PLUS
//                         the ATF and Brake Fluid tables that must NOT leak.
//   f150-2019-50l.html    2019 Ford F-150 5.0L — viscosity + capacity only
//                         (no Torque row, no coolant capacity table).
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  AMSOIL_FIELDS,
  amsoilAdapter,
  parseAmsoilVehiclePage,
  parseIdValueOptions,
  parseVehicleDetailsUrl,
  pickEngine,
  pickMake,
  pickModel,
} from "../convex/vehicleEnrichment/sourceAdapters/amsoil";
// Vite/vitest raw-text imports — the fixture files ARE the parser input.
// eslint-disable-next-line import/no-unresolved
import camryHtml from "./fixtures/sourceAdapters/amsoil/camry-2020-25l.html?raw";
// eslint-disable-next-line import/no-unresolved
import f150Html from "./fixtures/sourceAdapters/amsoil/f150-2019-50l.html?raw";
import camryEngines from "./fixtures/sourceAdapters/amsoil/fitment-engines-camry-2020.json";
import f150Engines from "./fixtures/sourceAdapters/amsoil/fitment-engines-f150-2019.json";
import camryDetails from "./fixtures/sourceAdapters/amsoil/fitment-details-camry-2020.json";

const OBSERVED_AT = 1_753_900_000_000;
const CAMRY_URL =
  "https://www.amsoil.com/lookup/auto-and-light-truck/2020/toyota/camry/2-5l-4-cyl-engine-code-a25a-fks-b/";

function claimsByKey(html: string) {
  const claims = parseAmsoilVehiclePage(html, {
    source_url: CAMRY_URL,
    observed_at: OBSERVED_AT,
  });
  return { claims, byKey: new Map(claims.map((c) => [c.field_key, c])) };
}

describe("parseAmsoilVehiclePage — 2020 Toyota Camry 2.5L (A25A-FKS)", () => {
  const { claims, byKey } = claimsByKey(camryHtml as string);

  it("emits exactly the four spec claims", () => {
    expect(claims).toHaveLength(4);
    expect([...byKey.keys()].sort()).toEqual([
      "coolant_capacity_qts",
      "drain_plug_torque_ft_lbs",
      "oil_capacity_qts",
      "oil_viscosity",
    ]);
  });

  it("oil_viscosity: primary grade only, fallback sentence kept in value_raw", () => {
    const c = byKey.get("oil_viscosity")!;
    expect(c.value).toBe("0W-16");
    expect(c.value_raw).toContain("All TEMPS");
    // The 0W-20 emergency-fallback sentence must ride along verbatim…
    expect(c.value_raw).toContain("0W-20 oil may be used");
    // …but never become the value.
    expect(c.value).not.toContain("0W-20");
  });

  it("oil_capacity_qts: 4.8 with the with-filter qualifier in value_raw", () => {
    const c = byKey.get("oil_capacity_qts")!;
    expect(c.value).toBe("4.8");
    expect(c.value_raw).toContain("with filter");
  });

  it("drain_plug_torque_ft_lbs: 30, observed_label carries the drain-plug qualifier", () => {
    const c = byKey.get("drain_plug_torque_ft_lbs")!;
    expect(c.value).toBe("30");
    expect(c.observed_label).toContain("Oil Drain Plug");
    expect(c.value_raw).toContain("Replace drain plug gasket");
  });

  it("coolant_capacity_qts: 7.3 from the Coolant section table", () => {
    const c = byKey.get("coolant_capacity_qts")!;
    expect(c.value).toBe("7.3");
    expect(c.value_raw).toBe("7.3 quarts.");
  });

  it("ATF fill figures (7.7 total / 3.4 initial) never leak into any claim", () => {
    for (const c of claims) {
      expect(c.value).not.toBe("7.7");
      expect(c.value).not.toBe("3.4");
    }
  });

  it("brake-fluid note table produces no claim", () => {
    expect([...byKey.keys()].some((k) => k.includes("brake"))).toBe(false);
  });

  it("claims carry the aggregator/deterministic provenance envelope", () => {
    for (const c of claims) {
      expect(c.source_family).toBe("aggregator");
      expect(c.source_domain).toBe("amsoil.com");
      expect(c.source_url).toBe(CAMRY_URL);
      expect(c.method).toBe("deterministic_parse");
      expect(c.observed_at).toBe(OBSERVED_AT);
    }
  });
});

describe("parseAmsoilVehiclePage — 2019 Ford F-150 5.0L", () => {
  const { claims, byKey } = claimsByKey(f150Html as string);

  it("emits viscosity + capacity and nothing else", () => {
    expect(claims).toHaveLength(2);
    expect(byKey.get("oil_viscosity")!.value).toBe("5W-20");
    expect(byKey.get("oil_capacity_qts")!.value).toBe("8.8");
  });

  it("no Torque row on this vehicle → no drain-plug claim", () => {
    expect(byKey.has("drain_plug_torque_ft_lbs")).toBe(false);
  });

  it("no coolant capacity table on this vehicle → no coolant claim", () => {
    expect(byKey.has("coolant_capacity_qts")).toBe(false);
  });
});

describe("parseAmsoilVehiclePage — ambiguity and malformed input (fail open)", () => {
  it("multi-band viscosity with no (All TEMPS) marker → no viscosity claim", () => {
    const html = `
      <h3>Engine Oil</h3>
      <table id="notes_1"><tr>
        <th><small>Viscosity:</small></th>
        <td><small>10W-30 (Above 0&deg;F) 5W-30 (Below 32&deg;F)</small></td>
      </tr></table>`;
    expect(parseAmsoilVehiclePage(html)).toEqual([]);
  });

  it("qualified coolant capacity (variant text) → no coolant claim", () => {
    const html = `
      <h3>Coolant</h3>
      <table id="notes_2"><tr>
        <th><small>Capacity:</small></th>
        <td><small>with rear heat 12.3 quarts.</small></td>
      </tr></table>`;
    expect(parseAmsoilVehiclePage(html)).toEqual([]);
  });

  it("torque without a drain-plug qualifier → no torque claim", () => {
    const html = `
      <h3>Engine Oil</h3>
      <table id="notes_3"><tr>
        <th><small>Torque:</small></th>
        <td><small>76 ft/lbs (Wheel Lug Nuts)</small></td>
      </tr></table>`;
    expect(parseAmsoilVehiclePage(html)).toEqual([]);
  });

  it("spec tables outside Engine Oil / Coolant sections are ignored", () => {
    const html = `
      <h3>Automatic Transmission Fluid</h3>
      <table id="notes_4"><tr>
        <th><small>Capacity:</small></th>
        <td><small>5.1 quarts Initial Fill.</small></td>
      </tr></table>`;
    expect(parseAmsoilVehiclePage(html)).toEqual([]);
  });

  it("malformed / empty / non-HTML input → [] (never throws)", () => {
    expect(parseAmsoilVehiclePage("")).toEqual([]);
    expect(parseAmsoilVehiclePage("<html><body><table><tr><td>junk")).toEqual([]);
    expect(parseAmsoilVehiclePage('{"not":"html"}')).toEqual([]);
    expect(
      parseAmsoilVehiclePage(
        "<h3>Engine Oil</h3><table id=\"notes_9\"><tr><th>Viscosity:</th><td>see manual</td></tr></table>",
      ),
    ).toEqual([]);
    // @ts-expect-error — deliberate wrong-type probe: parser must fail open.
    expect(parseAmsoilVehiclePage(null)).toEqual([]);
  });
});

describe("Fitment cascade helpers (verbatim API fixtures)", () => {
  const camryOpts = parseIdValueOptions(JSON.stringify(camryEngines));
  const f150Opts = parseIdValueOptions(JSON.stringify(f150Engines));

  it("parseIdValueOptions reads {id,value} rows and fails open on junk", () => {
    expect(camryOpts).toHaveLength(3);
    expect(camryOpts[0]).toEqual({
      id: "36118740",
      value: "2.5L 4 -cyl Engine Code A25A-FKS B",
    });
    expect(parseIdValueOptions("not json")).toEqual([]);
    expect(parseIdValueOptions('{"an":"object"}')).toEqual([]);
    expect(parseIdValueOptions('[{"id":1},{"nope":true},null]')).toEqual([]);
  });

  it("pickEngine: engine_code pins the Camry 2.5L gas engine over its hybrid sibling", () => {
    const picked = pickEngine(camryOpts, {
      engine_code: "A25A-FKS",
      displacement_l: 2.5,
      cylinders: 4,
    });
    expect(picked?.id).toBe("36118740");
  });

  it("pickEngine: two 2.5L candidates and no engine_code → null (no guessing)", () => {
    const picked = pickEngine(camryOpts, {
      engine_code: null,
      displacement_l: 2.5,
      cylinders: 4,
    });
    expect(picked).toBeNull();
  });

  it("pickEngine: displacement alone resolves the F-150 5.0L uniquely", () => {
    const picked = pickEngine(f150Opts, {
      engine_code: null,
      displacement_l: 5.0,
      cylinders: 8,
    });
    expect(picked?.id).toBe("49973875");
    expect(picked?.value).toContain("5.0L 8 -cyl");
  });

  it('pickModel: "F-150" resolves to "F150 PICKUP", not the Raptor', () => {
    const models = [
      { id: "6898777", value: "F150 PICKUP" },
      { id: "6898778", value: "F150 RAPTOR" },
      { id: "346", value: "FIESTA" },
    ];
    expect(pickModel(models, "F-150")?.id).toBe("6898777");
    expect(pickModel(models, "Camry")).toBeNull();
  });

  it('pickMake: exact and unique-containment ("Nissan" → "Nissan/Datsun")', () => {
    const makes = [
      { id: "59", value: "Toyota" },
      { id: "43", value: "Nissan/Datsun" },
      { id: "36", value: "Mercedes Benz" },
    ];
    expect(pickMake(makes, "Toyota")?.id).toBe("59");
    expect(pickMake(makes, "Nissan")?.id).toBe("43");
    expect(pickMake(makes, "Mercedes-Benz")?.id).toBe("36");
    expect(pickMake(makes, "Ferrari")).toBeNull();
  });

  it("parseVehicleDetailsUrl reads the verbatim Camry details response", () => {
    expect(parseVehicleDetailsUrl(JSON.stringify(camryDetails))).toBe(
      "2020/toyota/camry/2-5l-4-cyl-engine-code-a25a-fks-b/",
    );
    expect(parseVehicleDetailsUrl('{"lookupCode":"atv","url":"x/"}')).toBeNull();
    expect(parseVehicleDetailsUrl("garbage")).toBeNull();
  });
});

describe("adapter surface", () => {
  it("exports the aggregator-family contract with the probed field set", () => {
    expect(amsoilAdapter.name).toBe("amsoil");
    expect(amsoilAdapter.family).toBe("aggregator");
    expect([...amsoilAdapter.fields].sort()).toEqual([
      "coolant_capacity_qts",
      "drain_plug_torque_ft_lbs",
      "oil_capacity_qts",
      "oil_viscosity",
    ]);
    expect(AMSOIL_FIELDS).toContain("drain_plug_torque_ft_lbs");
    expect(typeof amsoilAdapter.lookup).toBe("function");
  });
});
