import { describe, it, expect } from "vitest";
import { mergeLaborSources } from "../convex/vehicleEnrichment/laborResearch";

describe("mergeLaborSources", () => {
  it("emits one weighted observation per (service, source) and skips empties", () => {
    const rows = mergeLaborSources({
      olp:       { oil_change: 0.5, spark_plugs: 2.7 },
      web:       { oil_change: 0.6 },
      repairpal: { oil_change: 0.55 },
    });
    // oil_change: olp 0.5 (w0.7), web 0.6 (w0.6), repairpal 0.55 (w0.4); spark_plugs: olp only
    expect(rows).toEqual(expect.arrayContaining([
      { service: "oil_change", source: "olp_labor", hours: 0.5, weight: 0.7 },
      { service: "oil_change", source: "web_labor", hours: 0.6, weight: 0.6 },
      { service: "oil_change", source: "repairpal_labor", hours: 0.55, weight: 0.4 },
      { service: "spark_plugs", source: "olp_labor", hours: 2.7, weight: 0.7 },
    ]));
    expect(rows.length).toBe(4);
  });
});
