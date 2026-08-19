/**
 * The discovery-verdict split (Aug 2026).
 *
 * "Found nothing" and "found something unreadable" are opposite situations
 * with opposite fixes, and they used to be one state — in fact the second was
 * no state at all. A part whose discovery surfaced sellers but whose pages
 * yielded no price recorded NOTHING, so every sweep re-selected it, re-searched
 * it and re-fetched the same unparseable pages, spending backfill budget on a
 * known-losing part forever while winnable parts queued behind it.
 *
 * They now back off on their own clocks: no_listing on the market's cadence
 * (only a new seller fixes it), unparsed on ours (our next deploy might).
 */
import { describe, test, expect, afterEach } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  delete process.env.PARTS_PRICE_NO_LISTING_RETRY_DAYS;
  delete process.env.PARTS_PRICE_UNPARSED_RETRY_DAYS;
});

/** One zero-price part with a fitment, carrying the given verdict. */
async function seed(
  t: ReturnType<typeof makeT>,
  parts: Array<{ oem: string; outcome?: string; ageDays?: number }>,
) {
  await t.run(async (ctx) => {
    const makeId = await ctx.db.insert("makes", { name: "GMC" });
    const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Acadia" });
    const configId = await ctx.db.insert("vehicle_configs", {
      config_key: "2021_gmc_acadia_verdicts",
      year: 2021,
      make_id: makeId,
      model_id: modelId,
      enrichment_status: "complete",
    });
    for (const p of parts) {
      const id = await ctx.db.insert("oem_parts", {
        oem_part_number: p.oem,
        name: p.oem,
        make_id: makeId,
        ...(p.outcome
          ? {
              price_discovery_outcome: p.outcome,
              price_discovery_at: Date.now() - (p.ageDays ?? 0) * DAY,
            }
          : {}),
      });
      await ctx.db.insert("part_fitments", { part_id: id, vehicle_config_id: configId });
    }
  });
}

/**
 * The two consumers treat suppression differently, on purpose:
 *   zeroPricePartsPage      — the FLEET sweep. Drops a suppressed part outright.
 *   zeroPricePartsForConfig — the targeted heal. KEEPS it and flags it, so a
 *                             config's gap never reads as healed by giving up.
 */
const sweptOems = async (t: ReturnType<typeof makeT>) => {
  const page = await t.query(internal.vehicleEnrichment.priceRefresh.zeroPricePartsPage, {});
  return page.parts.map((p: any) => p.oem_part_number);
};

describe("discovery verdicts back off on their own clocks", () => {
  test("a FRESH verdict of either kind drops the part from the sweep", async () => {
    const t = makeT();
    await seed(t, [
      { oem: "NONE-1", outcome: "no_listing", ageDays: 1 },
      { oem: "UNP-1", outcome: "unparsed", ageDays: 1 },
      { oem: "CLEAN-1" },
    ]);
    // `unparsed` is the new half: before the split it recorded nothing and the
    // sweep re-selected it every run to fail identically.
    expect(await sweptOems(t)).toEqual(["CLEAN-1"]);
  });

  test("unparsed expires SOONER than no_listing — ours to fix, so retried sooner", async () => {
    const t = makeT();
    // 10 days: past the 7-day unparsed window, inside the 30-day no_listing one.
    await seed(t, [
      { oem: "NONE-2", outcome: "no_listing", ageDays: 10 },
      { oem: "UNP-2", outcome: "unparsed", ageDays: 10 },
    ]);
    const swept = await sweptOems(t);
    expect(swept).toContain("UNP-2");
    expect(swept).not.toContain("NONE-2");
  });

  test("both expire eventually — no verdict suppresses forever", async () => {
    const t = makeT();
    await seed(t, [
      { oem: "NONE-3", outcome: "no_listing", ageDays: 400 },
      { oem: "UNP-3", outcome: "unparsed", ageDays: 400 },
    ]);
    expect((await sweptOems(t)).sort()).toEqual(["NONE-3", "UNP-3"]);
  });

  test("an UNRECOGNISED verdict suppresses nothing", async () => {
    // An older row, or a value a future deploy adds, may only ever cost a
    // retry — never silently hide a part from the backfill.
    const t = makeT();
    await seed(t, [{ oem: "WEIRD-1", outcome: "something_else", ageDays: 1 }]);
    expect(await sweptOems(t)).toContain("WEIRD-1");
  });

  test("a verdict with no timestamp suppresses nothing", async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const makeId = await ctx.db.insert("makes", { name: "GMC" });
      const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Acadia" });
      const configId = await ctx.db.insert("vehicle_configs", {
        config_key: "2021_gmc_acadia_nots",
        year: 2021,
        make_id: makeId,
        model_id: modelId,
        enrichment_status: "complete",
      });
      const id = await ctx.db.insert("oem_parts", {
        oem_part_number: "NOTS-1",
        name: "no timestamp",
        make_id: makeId,
        price_discovery_outcome: "no_listing",
      });
      await ctx.db.insert("part_fitments", { part_id: id, vehicle_config_id: configId });
    });
    expect(await sweptOems(t)).toContain("NOTS-1");
  });

  test("the targeted heal KEEPS a suppressed part and flags it", async () => {
    // A config's gap must never read as healed because we gave up on it, so
    // the per-config census reports the part with discovery_dead rather than
    // dropping it the way the fleet sweep does.
    const t = makeT();
    const configId = await t.run(async (ctx) => {
      const makeId = await ctx.db.insert("makes", { name: "GMC" });
      const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Acadia" });
      const configId = await ctx.db.insert("vehicle_configs", {
        config_key: "2021_gmc_acadia_census",
        year: 2021,
        make_id: makeId,
        model_id: modelId,
        enrichment_status: "complete",
      });
      for (const [oem, outcome] of [["NONE-4", "no_listing"], ["UNP-4", "unparsed"]]) {
        const id = await ctx.db.insert("oem_parts", {
          oem_part_number: oem,
          name: oem,
          make_id: makeId,
          price_discovery_outcome: outcome,
          price_discovery_at: Date.now(),
        });
        await ctx.db.insert("part_fitments", { part_id: id, vehicle_config_id: configId });
      }
      return configId;
    });
    const rows = await t.query(
      internal.vehicleEnrichment.priceRefresh.zeroPricePartsForConfig,
      { vehicle_config_id: configId },
    );
    const byOem = Object.fromEntries(rows.map((r: any) => [r.oem_part_number, r.discovery_dead]));
    expect(byOem["NONE-4"]).toBe(true);
    expect(byOem["UNP-4"]).toBe(true);
  });
});
