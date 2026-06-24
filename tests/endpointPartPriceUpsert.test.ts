import { describe, it, expect } from "vitest";
import { makeT } from "./helpers";
import { internal } from "../convex/_generated/api";
import { REPAIRPAL_ENDPOINT_PRICE_TYPE } from "../convex/lib/priceTypes";

describe("upsertEndpointPartPrice", () => {
  it("inserts then updates one repairpal_endpoint row per part", async () => {
    const t = makeT();
    const partId = await t.run((ctx) =>
      ctx.db.insert("oem_parts", { oem_part_number: "P1", name: "Spark Plug", subcategory: "spark_plug" } as any),
    );
    await t.mutation(internal.vehicleEnrichment.endpointPartPriceMutations.upsertEndpointPartPrice, {
      part_id: partId, price: 9, source_url: "https://repairpal.com/x", refreshed_at: 1,
    });
    await t.mutation(internal.vehicleEnrichment.endpointPartPriceMutations.upsertEndpointPartPrice, {
      part_id: partId, price: 11, source_url: "https://repairpal.com/x", refreshed_at: 2,
    });
    const rows = await t.run((ctx) =>
      ctx.db.query("part_prices").withIndex("by_part_source", (q) =>
        q.eq("part_id", partId).eq("source_domain", "repairpal_endpoint")).collect());
    expect(rows.length).toBe(1);
    expect(rows[0].price).toBe(11);
    expect(rows[0].price_type).toBe(REPAIRPAL_ENDPOINT_PRICE_TYPE);
    expect(rows[0].created_at).toBe(1); // insert-only: preserved from the first upsert
    expect(rows[0].refreshed_at).toBe(2); // updated by the patch
  });
});
