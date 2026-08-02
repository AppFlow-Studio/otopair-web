import { describe, it, expect } from "vitest";
import { mergeLaborSources } from "../convex/vehicleEnrichment/laborResearch";

describe("mergeLaborSources", () => {
  it("emits one weighted observation per (service, source) and skips empties", () => {
    const rows = mergeLaborSources({
      olp:              { oil_change: 0.5, spark_plugs: 2.7 },
      web:              { oil_change: 0.6 },
      estimatorEndpoint:{ oil_change: 0.5 },
    });
    // oil_change: olp 0.5 (w0.7), web 0.6 (w0.6), endpoint 0.5 (w0.9); spark_plugs: olp only
    expect(rows).toEqual(expect.arrayContaining([
      { service: "oil_change", source: "olp_labor", hours: 0.5, weight: 0.7 },
      { service: "oil_change", source: "web_labor", hours: 0.6, weight: 0.6 },
      { service: "oil_change", source: "estimator_endpoint", hours: 0.5, weight: 0.9 },
      { service: "spark_plugs", source: "olp_labor", hours: 2.7, weight: 0.7 },
    ]));
    expect(rows.length).toBe(4);
  });
});
