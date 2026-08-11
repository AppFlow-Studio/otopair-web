/**
 * Services rescue rung (fresh-5 round 2, Aug 2026).
 *
 * Regression anchors: 3MVDMBBL9M1234567 (2021 CX-30) and 3GTU9DED2KG234567
 * (2019 Sierra), Aug 8 2026. Both batch-2 turns ended stop_reason=end_turn
 * after 12-13 searches with `{"fields":[],"services":[]}` as the ONLY text
 * output — the model researched (its own queries price-checked part numbers
 * it never reported) and quit before the services write-out. The Jeep
 * (1C4RJFBG8LC234567) and Palisade (KM8R44HE5NU234567) variant returned
 * fields but `services: []`, which is deliberately NOT an r2 error (flagging
 * it would discard the real fields) yet still starves labor, quotability,
 * and role applicability.
 *
 * The rescue is a synchronous services-ONLY re-ask. These tests freeze:
 *   1. the prompt contract (every service listed, the array output shape,
 *      the "fields": [] requirement that routes bare numbers through
 *      normalizeBatchShape's envelope wrap);
 *   2. the parse path the pipeline uses verbatim:
 *      parseBatch2(normalizeBatchShape(data, "2"), []).
 */
import { describe, it, expect } from "vitest";
import {
  SERVICES_RESCUE_SYSTEM,
  buildServicesRescuePrompt,
  SERVICE_LIST,
} from "../convex/vehicleEnrichment/prompts/batch2Prompt";
import { normalizeBatchShape } from "../convex/vehicleEnrichment/utils/batchSchemas";
import { parseBatch2 } from "../convex/vehicleEnrichment/v3pipeline";
import type { VehicleInput } from "../convex/vehicleEnrichment/types";

const VEHICLE: VehicleInput = {
  vehicleId: "veh_test",
  year: 2021,
  make: "Mazda",
  model: "CX-30",
  trim: "Select",
  engineCode: "PY-VPS",
  displacement: 2.5,
};

describe("buildServicesRescuePrompt", () => {
  it("lists every service in SERVICE_LIST — the classification target is total", () => {
    const prompt = buildServicesRescuePrompt(VEHICLE, {});
    for (const s of SERVICE_LIST) {
      expect(prompt).toContain(s);
    }
  });

  it("carries the vehicle identity line", () => {
    const prompt = buildServicesRescuePrompt(VEHICLE, {});
    expect(prompt).toContain("2021 Mazda CX-30 Select — PY-VPS 2.5L");
  });

  it("renders known parts for pricing, and says pricing is optional without them", () => {
    const withParts = buildServicesRescuePrompt(VEHICLE, {
      oil_filter_oem: "PE01-14-302B",
    });
    expect(withParts).toContain('- oil_filter_oem: "PE01-14-302B"');

    const without = buildServicesRescuePrompt(VEHICLE, {});
    expect(without).toContain("pricing is optional this pass");
  });

  it('demands the array shape WITH "fields": [] — the envelope-wrap route', () => {
    const prompt = buildServicesRescuePrompt(VEHICLE, {});
    expect(prompt).toContain('"fields":   []');
    expect(prompt).toContain("an empty array is invalid");
  });

  it("system prompt forbids the empty-services bail-out and interim JSON", () => {
    expect(SERVICES_RESCUE_SYSTEM).toContain('empty "services" array is ALWAYS invalid');
    expect(SERVICES_RESCUE_SYSTEM).toContain("Never emit JSON between searches");
  });
});

describe("rescue parse path — parseBatch2(normalizeBatchShape(data, '2'), [])", () => {
  it("array-shaped services-only payload parses with envelopes restored", () => {
    const data = {
      fields: [],
      services: [
        {
          service_name: "Oil Change",
          is_applicable: true,
          labor_hours: 0.5,
          parts_cost_low: 30,
          parts_cost_high: 60,
          confidence: 0.9,
          tech_notes: "",
          parts_breakdown: [
            {
              oem_part_number: "PE01-14-302B",
              price_low: 8.5,
              price_high: 12,
              source_url: "https://www.mazdapartswarehouse.com/x",
              confidence: 0.9,
            },
          ],
        },
        {
          service_name: "Transfer Case Fluid Service",
          is_applicable: false,
          labor_hours: 0,
          parts_cost_low: 0,
          parts_cost_high: 0,
          confidence: 0.9,
          tech_notes: "FWD — no transfer case",
          parts_breakdown: [],
        },
      ],
    };

    const { gapFields, services } = parseBatch2(normalizeBatchShape(data, "2"), []);

    expect(Object.keys(gapFields)).toHaveLength(0);
    expect(services).toHaveLength(2);

    const oil = services[0];
    expect(oil.service_name).toBe("Oil Change");
    expect(oil.is_applicable).toBe(true);
    // bare 0.5 must arrive as an envelope value, not be dropped
    expect(oil.labor_hours.value).toBe(0.5);
    expect(oil.parts_breakdown).toHaveLength(1);
    expect(oil.parts_breakdown[0].oem_part_number).toBe("PE01-14-302B");
    expect(oil.parts_breakdown[0].price_low).toBe(8.5);

    const tcase = services[1];
    expect(tcase.is_applicable).toBe(false);
  });

  it("the applicable-count gate: an all-empty rescue reads as zero applicable", () => {
    const data = { fields: [], services: [] };
    const { services } = parseBatch2(normalizeBatchShape(data, "2"), []);
    expect(services.filter((s) => s.is_applicable)).toHaveLength(0);
  });

  it("legacy keyed shape (no fields array) still parses — passthrough tolerance", () => {
    const data = {
      services: [
        {
          service_name: "Tire Rotation",
          is_applicable: true,
          labor_hours: { value: 0.5, source_url: null, source_type: "training_data", confidence: 0.75 },
          parts_breakdown: [],
        },
      ],
    };
    const { services } = parseBatch2(normalizeBatchShape(data, "2"), []);
    expect(services).toHaveLength(1);
    expect(services[0].is_applicable).toBe(true);
    expect(services[0].labor_hours.value).toBe(0.5);
  });
});
