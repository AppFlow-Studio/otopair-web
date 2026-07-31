// =============================================================================
// adapter_sylvaniaBulbs.test.ts — pure-parser tests against live-captured
// fixtures (BulbFinder-GetDropdownValues JSON, captured 2026-07-30).
//
// The fixtures are VERBATIM server responses:
//   bulbs-f150-2019.json   carId 30121 (2019 Ford F-150) — rich variant mix:
//                          halogen-vs-LED conflicts, "Bulb Option 1/2",
//                          single-answer positions, agreeing-LED positions.
//   bulbs-camry-2020.json  carId 36706 (2020 Toyota Camry) — mostly-LED car
//                          with real trade numbers on interior positions.
//   dropdown-makes-2020.json  makes list trimmed to 6 entries.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  parseBulbChart,
  parseDropdownOptions,
  positionFieldKey,
  sylvaniaBulbsAdapter,
  SYLVANIA_BULB_FIELDS,
} from "../convex/vehicleEnrichment/sourceAdapters/sylvaniaBulbs";
import f150Chart from "./fixtures/sourceAdapters/sylvaniaBulbs/bulbs-f150-2019.json";
import camryChart from "./fixtures/sourceAdapters/sylvaniaBulbs/bulbs-camry-2020.json";
import makes2020 from "./fixtures/sourceAdapters/sylvaniaBulbs/dropdown-makes-2020.json";

const F150 = JSON.stringify(f150Chart);
const CAMRY = JSON.stringify(camryChart);
const OBSERVED_AT = 1_753_800_000_000;

function claimsByKey(json: string) {
  const claims = parseBulbChart(json, {
    source_url: "https://www.sylvania-automotive.com/bulb-finder.html",
    observed_at: OBSERVED_AT,
  });
  return new Map(claims.map((c) => [c.field_key, c]));
}

describe("positionFieldKey", () => {
  it("maps the canonical positions", () => {
    expect(positionFieldKey("Headlight Bulb Low Beam")).toBe("bulb_headlight_low_beam");
    expect(positionFieldKey("Headlight Bulb High Beam")).toBe("bulb_headlight_high_beam");
    expect(positionFieldKey("Turn Signal Light Bulb Front")).toBe("bulb_front_turn_signal");
    expect(positionFieldKey("Brake Light Bulb")).toBe("bulb_brake_light");
    expect(positionFieldKey("Back Up Light Bulb")).toBe("bulb_reverse_light");
    expect(positionFieldKey("License Plate Light Bulb")).toBe("bulb_license_plate");
  });

  it("falls back mechanically for unseen positions (Bulb dropped, Front/Rear promoted)", () => {
    expect(positionFieldKey("Ash Tray Light Bulb")).toBe("bulb_ash_tray_light");
    expect(positionFieldKey("Reading Light Bulb Rear")).toBe("bulb_rear_reading_light");
    expect(positionFieldKey("  Step  Light   Bulb Front ")).toBe("bulb_front_step_light");
  });
});

describe("parseBulbChart — 2019 Ford F-150 (carId 30121)", () => {
  const byKey = claimsByKey(F150);

  it("emits single-answer positions with the verbatim trade number", () => {
    const plate = byKey.get("bulb_license_plate");
    expect(plate).toBeDefined();
    expect(plate!.value).toBe("168");
    expect(plate!.value_raw).toBe("168");
    expect(plate!.observed_label).toBe("License Plate Light Bulb");

    const fog = byKey.get("bulb_front_fog_light");
    expect(fog).toBeDefined();
    expect(fog!.value).toBe("9140");
  });

  it("suppresses positions whose variants conflict (halogen vs LED, option 1/2)", () => {
    // H11 (halogen) vs LED — trim-dependent, unresolvable from Y/M/M.
    expect(byKey.has("bulb_headlight_low_beam")).toBe(false);
    expect(byKey.has("bulb_headlight_high_beam")).toBe(false);
    // 3156 "Bulb Option 1" vs 7440 "Bulb Option 2" vs LED.
    expect(byKey.has("bulb_reverse_light")).toBe(false);
    // 7444NA vs 4257NA — two REAL numbers in conflict.
    expect(byKey.has("bulb_front_turn_signal")).toBe(false);
    expect(byKey.has("bulb_brake_light")).toBe(false);
    expect(byKey.has("bulb_tail_light")).toBe(false);
  });

  it("emits LED when every variant agrees the position is a factory LED unit", () => {
    // Map Light: two variant rows, both "LED" → one agreed claim.
    const map = byKey.get("bulb_map_light");
    expect(map).toBeDefined();
    expect(map!.value).toBe("LED");
    // Dome Light: single "LED" row.
    expect(byKey.get("bulb_dome_light")!.value).toBe("LED");
  });

  it("stamps claim provenance correctly", () => {
    for (const claim of byKey.values()) {
      expect(claim.source_family).toBe("aftermarket_catalog");
      expect(claim.source_domain).toBe("sylvania-automotive.com");
      expect(claim.method).toBe("deterministic_parse");
      expect(claim.observed_at).toBe(OBSERVED_AT);
      expect(claim.field_key.startsWith("bulb_")).toBe(true);
      expect(claim.value).not.toBe("");
    }
  });

  it("emits at most one claim per position", () => {
    const claims = parseBulbChart(F150);
    const keys = claims.map((c) => c.field_key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("parseBulbChart — 2020 Toyota Camry (carId 36706)", () => {
  const byKey = claimsByKey(CAMRY);

  it("reads the factory-LED forward lighting and real interior trade numbers", () => {
    expect(byKey.get("bulb_headlight_low_beam")!.value).toBe("LED");
    expect(byKey.get("bulb_headlight_high_beam")!.value).toBe("LED");
    expect(byKey.get("bulb_brake_light")!.value).toBe("LED");
    expect(byKey.get("bulb_dome_light")!.value).toBe("DE3175");
    expect(byKey.get("bulb_trunk_light")!.value).toBe("168");
    expect(byKey.get("bulb_interior_door_light")!.value).toBe("168");
  });

  it("suppresses the Camry's trim-dependent variants too", () => {
    // LED "with LED Headlights" vs 7444NA "with Bi-LED Headlights".
    expect(byKey.has("bulb_front_turn_signal")).toBe(false);
    // LED vs 921 backup light.
    expect(byKey.has("bulb_reverse_light")).toBe(false);
    // LED vs 168 side markers.
    expect(byKey.has("bulb_front_side_marker")).toBe(false);
  });
});

describe("parseBulbChart — malformed input fails open", () => {
  it("returns [] on non-JSON", () => {
    expect(parseBulbChart("<html>Access Denied</html>")).toEqual([]);
    expect(parseBulbChart("")).toEqual([]);
    expect(parseBulbChart("null")).toEqual([]);
  });

  it("returns [] on server error envelopes", () => {
    expect(
      parseBulbChart(
        JSON.stringify({ success: false, errorMessage: "no car id to get bulb list" }),
      ),
    ).toEqual([]);
  });

  it("returns [] when response is not an array or rows are junk", () => {
    expect(parseBulbChart(JSON.stringify({ response: "nope" }))).toEqual([]);
    expect(
      parseBulbChart(JSON.stringify({ response: [null, 42, { use_name: 7, oepn: [] }] })),
    ).toEqual([]);
  });

  it("skips rows whose oepn is empty or N.A.", () => {
    const claims = parseBulbChart(
      JSON.stringify({
        response: [
          { use_name: "Dome Light Bulb", oepn: "", note: "" },
          { use_name: "Map Light Bulb", oepn: "N.A.", note: "" },
          { use_name: "Trunk Light Bulb", oepn: "168", note: "" },
        ],
      }),
    );
    expect(claims.map((c) => c.field_key)).toEqual(["bulb_trunk_light"]);
  });
});

describe("parseDropdownOptions", () => {
  it("parses the makes list fixture", () => {
    const makes = parseDropdownOptions(JSON.stringify(makes2020));
    expect(makes.length).toBe(6);
    expect(makes).toContainEqual({ id: "109", name: "Toyota" });
    expect(makes).toContainEqual({ id: "45", name: "Ford" });
  });

  it("fails open on malformed input", () => {
    expect(parseDropdownOptions("not json")).toEqual([]);
    expect(parseDropdownOptions(JSON.stringify({ success: false }))).toEqual([]);
    expect(parseDropdownOptions(JSON.stringify({ response: {} }))).toEqual([]);
  });
});

describe("adapter contract", () => {
  it("declares the aftermarket_catalog family and bulb_ fields", () => {
    expect(sylvaniaBulbsAdapter.name).toBe("sylvania_bulbs");
    expect(sylvaniaBulbsAdapter.family).toBe("aftermarket_catalog");
    expect(sylvaniaBulbsAdapter.fields.length).toBeGreaterThan(0);
    expect(sylvaniaBulbsAdapter.fields).toContain("bulb_headlight_low_beam");
    expect(sylvaniaBulbsAdapter.fields).toContain("bulb_license_plate");
    expect(SYLVANIA_BULB_FIELDS.every((f) => f.startsWith("bulb_"))).toBe(true);
  });
});
