// =============================================================================
// fluidCatalog.ts — the fluid picker's data source (Aug 2026).
//
// The post-job survey's "Any updates from what you saw?" step used to offer a
// short static list of generic chemistry buckets (IAT/OAT/HOAT for coolant,
// Dexron VI / ATF+4 for trans) plus a free-text "Other" box. A mechanic who
// actually poured "Subaru Super Coolant (Blue)" had to type it — the product
// Otopair already knows about was invisible.
//
// This query backs a single-column, data-driven picker instead: the curated
// Otopair OEM catalog (`genuine_fluid_products`) first, then every fluid of the
// same kind we've scraped into `oem_parts`, with THIS vehicle's make pinned to
// the top of each group. The client paginates the raw list and keeps an
// "Other…" escape hatch, so nothing that isn't in the catalog yet becomes
// un-enterable.
// =============================================================================

import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { makeKeyOf, findMakeByName } from "./lib/makeKey";

// The `fluid_kind` (genuine_fluid_products) / `subcategory` (oem_parts) values
// that name a pourable fluid. Kept in sync with PART_FIELD_MAP subcategories in
// vehicleEnrichment/v3pipeline.ts.
const FLUID_KINDS = new Set([
  "engine_oil",
  "coolant",
  "atf_fluid",
  "brake_fluid",
  "ps_fluid",
  "gear_oil",
  "friction_modifier",
]);

// The raw `oem_parts` pool for a single fluid subcategory is a fraction of the
// whole table, but still cap the scan so a pathological subcategory can't blow
// the read limit. The client only ever paginates through what we return.
const RAW_CAP = 500;

/** Uppercase-alphanumeric OEM number, so "5Q0 698 451 A" and "5Q0698451A"
 *  dedupe to one row. Mirrors normalizeOemNumber without the import weight. */
function normOem(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

type FluidCatalogOption = {
  /** Stored verbatim on the passport (a product name string), preserving the
   *  existing free-string `fluids.*_type` shape. */
  value: string;
  label: string;
  /** Spec / viscosity / package / brand / SKU, joined for a dim second line. */
  sublabel: string | null;
  oem_part_number: string | null;
  /** Belongs to this vehicle's make — pinned to the top of its group. */
  make_match: boolean;
};

/** vehicles → vehicle_config → make, inlined to avoid importing the whole
 *  quote engine into this read-only picker query. */
async function resolveMakeFromVin(
  ctx: QueryCtx,
  vin: string,
): Promise<Doc<"makes"> | null> {
  const canonical = vin.trim().toUpperCase();
  if (!canonical) return null;
  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q) => q.eq("vin", canonical))
    .first();
  const cfgId = (vehicle as { vehicle_config_id?: Id<"vehicle_configs"> } | null)
    ?.vehicle_config_id;
  if (!cfgId) return null;
  const cfg = await ctx.db.get(cfgId);
  if (!cfg?.make_id) return null;
  return await ctx.db.get(cfg.make_id);
}

function byMakeThenLabel(a: FluidCatalogOption, b: FluidCatalogOption): number {
  if (a.make_match !== b.make_match) return a.make_match ? -1 : 1;
  return a.label.localeCompare(b.label);
}

export const listForVehicle = query({
  args: {
    fluidKind: v.string(),
    // Either identifier resolves the make used to pin this vehicle's own
    // products on top. Both optional — with neither, the full catalog still
    // returns, just unsorted by make.
    vin: v.optional(v.string()),
    makeName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const fluidKind = args.fluidKind;
    if (!FLUID_KINDS.has(fluidKind)) {
      return {
        makeKey: null,
        makeLabel: null,
        curated: [] as FluidCatalogOption[],
        raw: [] as FluidCatalogOption[],
        rawTotal: 0,
      };
    }

    // Resolve the vehicle's make (name comes first — it's cheaper and the
    // caller usually has it), falling back to a VIN lookup.
    let make: Doc<"makes"> | null = null;
    if (args.makeName && args.makeName.trim()) {
      make = await findMakeByName(ctx.db, args.makeName.trim());
    }
    if (!make && args.vin && args.vin.trim()) {
      make = await resolveMakeFromVin(ctx, args.vin);
    }
    const makeKey = make
      ? makeKeyOf(make.name)
      : args.makeName
        ? makeKeyOf(args.makeName)
        : null;
    const makeId = make?._id ?? null;

    // ── Curated: the Otopair OEM catalog ────────────────────────────────────
    // Operator-seeded and small (a handful per make × kind), so a full scan
    // filtered to this kind is cheap and avoids a per-make fan-out.
    const curatedRows = (
      await ctx.db.query("genuine_fluid_products").collect()
    ).filter((r) => r.fluid_kind === fluidKind);

    const seenNames = new Set<string>();
    const seenOem = new Set<string>();
    const curated: FluidCatalogOption[] = [];
    for (const r of curatedRows) {
      const sub = [r.viscosity, r.spec, r.package_size, r.oem_part_number]
        .filter((x): x is string => !!x && x.trim().length > 0)
        .join(" · ");
      curated.push({
        value: r.name,
        label: r.name,
        sublabel: sub || null,
        oem_part_number: r.oem_part_number || null,
        make_match: makeKey != null && r.make_key === makeKey,
      });
      seenNames.add(r.name.trim().toLowerCase());
      if (r.oem_part_number) seenOem.add(normOem(r.oem_part_number));
    }
    curated.sort(byMakeThenLabel);

    // ── Raw: everything scraped into oem_parts for this fluid subcategory ────
    const rawRows = await ctx.db
      .query("oem_parts")
      .withIndex("by_subcategory", (q) => q.eq("subcategory", fluidKind))
      .take(RAW_CAP + 250);

    const raw: FluidCatalogOption[] = [];
    for (const p of rawRows) {
      const name = (p.name ?? "").trim();
      if (!name) continue;
      const nlow = name.toLowerCase();
      const oemN = normOem(p.oem_part_number);
      // Drop rows the curated catalog already covers (by product name or SKU)
      // so a product never appears twice.
      if (seenNames.has(nlow)) continue;
      if (oemN && seenOem.has(oemN)) continue;
      seenNames.add(nlow);
      if (oemN) seenOem.add(oemN);
      const sub = [p.brand, p.oem_part_number]
        .filter((x): x is string => !!x && x.trim().length > 0)
        .join(" · ");
      raw.push({
        value: name,
        label: name,
        sublabel: sub || null,
        oem_part_number: p.oem_part_number || null,
        make_match: makeId != null && p.make_id === makeId,
      });
    }
    raw.sort(byMakeThenLabel);

    return {
      makeKey,
      makeLabel: make?.name ?? args.makeName ?? null,
      curated,
      raw: raw.slice(0, RAW_CAP),
      rawTotal: raw.length,
    };
  },
});
