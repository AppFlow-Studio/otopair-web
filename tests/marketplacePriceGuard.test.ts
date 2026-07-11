/**
 * upsertPartPrice write-boundary marketplace guard. Every price writer
 * (Batch-2 finalize, reprice, refresh, diagnoseVin, backfills) funnels
 * through this mutation, so this one rejection covers them all.
 */
import { describe, test, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";

describe("v3mutations.upsertPartPrice marketplace guard", () => {
  test("rejects marketplace rows by domain or URL; accepts OEM stores", async () => {
    const t = makeT();
    const partId = await t.run(async (ctx) =>
      ctx.db.insert("oem_parts", { oem_part_number: "19386946", name: "Rear Brake Pads" }),
    );

    const amazonByDomain = await t.mutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
      part_id: partId,
      price: 31.78,
      price_type: "sale",
      source_domain: "amazon.com",
      source_url: "https://www.amazon.com/Genuine-Front-Brake/dp/B0DJ93X4GR",
    });
    expect(amazonByDomain).toBeNull();

    // Domain field lies but the URL betrays it — still rejected.
    const ebayByUrl = await t.mutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
      part_id: partId,
      price: 20,
      price_type: "sale",
      source_domain: "enrichment",
      source_url: "https://www.ebay.com/shop/10l80-filter",
    });
    expect(ebayByUrl).toBeNull();

    const oemStore = await t.mutation(internal.vehicleEnrichment.v3mutations.upsertPartPrice, {
      part_id: partId,
      price: 147.95,
      price_type: "sale",
      source_domain: "gmpartsdirect.com",
      source_url: "https://www.gmpartsdirect.com/oem-parts/gm-brake-pads-19386946",
    });
    expect(oemStore).not.toBeNull();

    const rows = await t.run(async (ctx) => ctx.db.query("part_prices").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].source_domain).toBe("gmpartsdirect.com");
    expect(rows[0].price).toBe(147.95);
  });
});
