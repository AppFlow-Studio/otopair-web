/**
 * devOnly/seedFluidCatalog — fleet-wide curated ATF catalog for the
 * certification-equivalence policy (mechanic feedback Aug 2026).
 *
 * One row per (corporate-family parent key, certification, tier). Family
 * expansion in seedFluidsRung (familyMakeKeys) means a "chrysler" row serves
 * Jeep/Ram/Dodge/Fiat/Alfa, a "chevrolet" row serves the whole GM roster,
 * etc. The `spec` field carries EVERY published name of the certification
 * ("|"-separated aliases; specMatches accepts any segment) because the
 * vehicle-side strings vary wildly ("ZF Lifeguard 8 (lifetime)",
 * "Mopar 8 & 9 Speed ATF, P/N 68218925AB", "Toyota WS (World Standard ATF)").
 *
 * LAW unchanged: rows are CANDIDATES — every write is adjudicated per vehicle
 * by the fitment verifier. Only SKUs with unambiguous public documentation
 * belong here; a family whose genuine SKU we are not sure of stays absent
 * (MB 236.x, Hyundai SP-IV, Subaru CVTF — operator to add with a source).
 *
 *   npx convex run devOnly/seedFluidCatalog:seed
 */
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { normalizeOemNumber } from "../vehicleEnrichment/priceParser";

const PROVENANCE = "curated_fluid_catalog_aug2026 (mechanic feedback: cert-equivalence policy)";

type CatalogRow = {
  make: string;
  spec: string;
  oemPartNumber: string;
  name: string;
  partTier: "oem" | "aftermarket";
  brand?: string;
  packageSize?: string;
};

const ROWS: CatalogRow[] = [
  // ── Ford family (ford → lincoln, mercury) ────────────────────────────────
  { make: "ford", spec: "MERCON ULV|Mercon ULV|XT-12", oemPartNumber: "XT-12-QULV", name: "Motorcraft MERCON ULV ATF (1 qt)", partTier: "oem", brand: "Motorcraft", packageSize: "1qt" },
  { make: "ford", spec: "MERCON LV|Mercon LV|XT-10", oemPartNumber: "XT-10-QLVC", name: "Motorcraft MERCON LV ATF (1 qt)", partTier: "oem", brand: "Motorcraft", packageSize: "1qt" },
  // ── GM family (chevrolet → gmc, cadillac, buick, pontiac, saturn, hummer,
  //    oldsmobile, saab) ───────────────────────────────────────────────────
  { make: "chevrolet", spec: "Dexron VI|Dexron-VI|DEXRON VI|DEX-VI", oemPartNumber: "10-9243", name: "ACDelco Dexron VI ATF (1 qt)", partTier: "oem", brand: "ACDelco", packageSize: "1qt" },
  // ── Toyota family (toyota → lexus, scion) ────────────────────────────────
  { make: "toyota", spec: "ATF WS|Type WS|World Standard|Toyota WS", oemPartNumber: "00289-ATFWS", name: "Toyota Genuine ATF WS (1 qt)", partTier: "oem", brand: "Toyota", packageSize: "1qt" },
  { make: "toyota", spec: "ATF WS|Type WS|World Standard|Toyota WS", oemPartNumber: "ATF-0WS", name: "Aisin ATF-0WS (WS spec, 1 qt)", partTier: "aftermarket", brand: "Aisin", packageSize: "1qt" },
  // Supra's BMW-built drivetrain: ZF 8HP under a Toyota badge.
  { make: "toyota", spec: "ZF Lifeguard 8|ZF LifeGuardFluid 8|ZF 8HP", oemPartNumber: "S671090312", name: "ZF LifeGuardFluid 8 (1L)", partTier: "aftermarket", brand: "ZF", packageSize: "1L" },
  // ── Honda family ─────────────────────────────────────────────────────────
  { make: "honda", spec: "ATF DW-1|DW-1|DW1", oemPartNumber: "08200-9008", name: "Honda Genuine ATF DW-1 (1 qt)", partTier: "oem", brand: "Honda", packageSize: "1qt" },
  // ── Nissan family (nissan → infiniti) ────────────────────────────────────
  { make: "nissan", spec: "NS-3|NS3|CVT Fluid NS-3|CVTF NS-3", oemPartNumber: "999MP-NS300P", name: "Nissan CVT Fluid NS-3 (1 qt)", partTier: "oem", brand: "Nissan", packageSize: "1qt" },
  { make: "nissan", spec: "NS-2|NS2|CVT Fluid NS-2", oemPartNumber: "999MP-NS200P", name: "Nissan CVT Fluid NS-2 (1 qt)", partTier: "oem", brand: "Nissan", packageSize: "1qt" },
  // ── Mopar family (chrysler → dodge, jeep, ram, fiat, alfa romeo) ─────────
  { make: "chrysler", spec: "8 & 9 Speed|8&9 Speed|ZF 8&9|68218925|Lifeguard 8|LifeGuard 8|8HP", oemPartNumber: "68218925AB", name: "Mopar ZF 8&9 Speed ATF (1 qt)", partTier: "oem", brand: "Mopar", packageSize: "1qt" },
  { make: "chrysler", spec: "Lifeguard 8|LifeGuard 8|8HP|G 060 162", oemPartNumber: "S671090312", name: "ZF LifeGuardFluid 8 (1L)", partTier: "aftermarket", brand: "ZF", packageSize: "1L" },
  { make: "chrysler", spec: "ATF+4|ATF Plus 4|MS-9602", oemPartNumber: "68218057AB", name: "Mopar ATF+4 (1 qt)", partTier: "oem", brand: "Mopar", packageSize: "1qt" },
  // ── VAG family (volkswagen → audi, porsche, bentley, lamborghini) ────────
  // VAG sells fluid under the G-number itself — the spec IS the genuine SKU.
  { make: "volkswagen", spec: "G 055 540|Aisin 09P", oemPartNumber: "G055540A2", name: "VW/Audi ATF G 055 540 A2 (1L)", partTier: "oem", brand: "VW", packageSize: "1L" },
  { make: "volkswagen", spec: "G 053 001|Aisin 09S", oemPartNumber: "G053001A2", name: "VW/Audi ATF G 053 001 A2 (1L)", partTier: "oem", brand: "VW", packageSize: "1L" },
  // The exorbitant-genuine exemplar: present so the resolver's 1.5× rule has
  // the genuine-vs-ZF comparison to act on once both carry prices.
  { make: "volkswagen", spec: "G 060 162|ZF Lifeguard 8|8HP", oemPartNumber: "G060162A2", name: "VW/Audi ATF G 060 162 A2 (1L)", partTier: "oem", brand: "VW", packageSize: "1L" },
  { make: "volkswagen", spec: "G 055 005|ZF Lifeguard 6|6HP", oemPartNumber: "G055005A2", name: "VW/Audi ATF G 055 005 A2 (1L)", partTier: "oem", brand: "VW", packageSize: "1L" },
  // ── JLR family (jaguar → land rover, range rover) ────────────────────────
  { make: "jaguar", spec: "Lifeguard 8|LifeGuard 8|8HP|M-L12108", oemPartNumber: "S671090312", name: "ZF LifeGuardFluid 8 (1L)", partTier: "aftermarket", brand: "ZF", packageSize: "1L" },
  { make: "jaguar", spec: "Lifeguard 6|LifeGuard 6|6HP|M-1375.4|M1375", oemPartNumber: "S671090255", name: "ZF LifeGuardFluid 6 (1L)", partTier: "aftermarket", brand: "ZF", packageSize: "1L" },
  // ── Volvo family (volvo → polestar) ──────────────────────────────────────
  { make: "volvo", spec: "Lifeguard 8|LifeGuard 8|8HP|Geartronic", oemPartNumber: "S671090312", name: "ZF LifeGuardFluid 8 (1L)", partTier: "aftermarket", brand: "ZF", packageSize: "1L" },
  // ── Aston Martin (no family) ─────────────────────────────────────────────
  { make: "aston-martin", spec: "Lifeguard 6|LifeGuard 6|Touchtronic|6HP", oemPartNumber: "S671090255", name: "ZF LifeGuardFluid 6 (1L)", partTier: "aftermarket", brand: "ZF", packageSize: "1L" },
];

export const seed = internalAction({
  args: {},
  handler: async (ctx): Promise<any> => {
    const results: string[] = [];
    for (const r of ROWS) {
      const res: any = await ctx.runMutation(
        internal.vehicleEnrichment.genuineFluids.upsertGenuineFluidProduct,
        {
          make: r.make,
          fluidKind: "atf_fluid",
          spec: r.spec,
          oemPartNumber: r.oemPartNumber,
          name: r.name,
          partTier: r.partTier,
          brand: r.brand,
          packageSize: r.packageSize,
          provenance: PROVENANCE,
        },
      );
      results.push(`${r.make}:${r.oemPartNumber}:${r.partTier}:${res.inserted ? "inserted" : "updated"}`);
    }
    console.log(`[fluid-catalog] seeded ${ROWS.length} rows`);
    return { rows: ROWS.length, results };
  },
});

/** One-off repair: aftermarket supplier SKUs written before the
 *  universal-make fix carry the first caller's make_id, which makes the I1
 *  guard reject every other family's reuse as cross-make. Clear make_id on
 *  the catalog's aftermarket part rows (idempotent; no-op once clean). */
export const fixAftermarketPartMakeIds = internalMutation({
  args: {},
  handler: async (ctx) => {
    const targets = new Set(
      ROWS.filter((r) => r.partTier === "aftermarket").map((r) =>
        normalizeOemNumber(r.oemPartNumber),
      ),
    );
    const fixed: string[] = [];
    for (const norm of targets) {
      const part: any = await ctx.db
        .query("oem_parts")
        .withIndex("by_part_number_normalized", (q: any) =>
          q.eq("oem_part_number_normalized", norm),
        )
        .first();
      if (part && part.make_id != null) {
        await ctx.db.patch(part._id, { make_id: undefined, part_tier: "aftermarket" });
        fixed.push(part.oem_part_number);
      }
    }
    return { fixed };
  },
});
