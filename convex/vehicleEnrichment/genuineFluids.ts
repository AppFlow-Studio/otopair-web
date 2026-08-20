// =============================================================================
// vehicleEnrichment/genuineFluids.ts — curated fluid SKUs as a heal rung
// (Aug 2026).
//
// WHY: fluids were the last structurally-unfillable roles. Coolant jugs and
// oil bottles rarely appear on storefront category pages, oil/coolant SERPs
// rank marketplaces and spec sheets over product tiles, and some genuine
// jugs carry NON-make-format SKUs (MB's BASF-numbered antifreeze) that the
// format gate rightly refuses. But fluids are MAKE-level truth: every
// Mercedes requiring MB 229.5 0W-40 takes the same genuine 1L bottle. So a
// tiny operator-curated table (make × kind × spec/viscosity → SKU) closes a
// role for an entire make at once.
//
// LAW: seed rows are CANDIDATES, never direct writes. Each one is anchored
// against THIS vehicle's spec strings (engines.coolant_type /
// engines.oil_viscosity), pushed through the same verifyPartFitments that
// judges every scraped part (write unless positively refuted — curated rows
// with provenance are catalog-grade), and lands via upsertPartAndFitment
// with every write gate active. Pricing rides the targeted price backfill.
// Kill switch: PARTS_GENUINE_FLUID_SEED=off.
// =============================================================================

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { verifyPartFitments } from "./utils/partFitmentVerifier";
import { normalizeOemNumber } from "./priceParser";
import { missingCoreRoles } from "./quotability";
import { PART_FIELD_MAP } from "./v3pipeline";
import { makeKeyOf } from "../lib/makeKey";
import { familyMakeKeys } from "./contentSanitization";

/** Loose token-contains spec match: row spec "MB 325.0" matches an engine
 *  coolant_type of "MB 325.0", "MB 325.0 / Q 1 03 0002", "MB325.0" — but not
 *  "MB 326.3". Both sides are collapsed to alphanumerics so punctuation and
 *  spacing never decide. */
export function specMatches(
  rowSpec: string | null | undefined,
  engineSpec: string | null | undefined,
): boolean {
  if (!rowSpec || !engineSpec) return false;
  const flat = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const needle = flat(rowSpec);
  if (needle.length < 3) return false;
  return flat(engineSpec).includes(needle);
}

/** Viscosity equality with normalized punctuation ("0W-40" ≡ "0w40"). */
export function viscosityEquals(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const flat = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return flat(a) === flat(b) && flat(a).length >= 3;
}

/** Operator-curated upsert — provenance REQUIRED, keyed by
 *  (make, kind, normalized number). */
export const upsertGenuineFluidProduct = internalMutation({
  args: {
    make: v.string(),
    fluidKind: v.string(),
    spec: v.optional(v.string()),
    viscosity: v.optional(v.string()),
    oemPartNumber: v.string(),
    name: v.string(),
    packageSize: v.optional(v.string()),
    provenance: v.string(),
  },
  handler: async (ctx, args) => {
    const make_key = makeKeyOf(args.make);
    const norm = normalizeOemNumber(args.oemPartNumber);
    const rows = await ctx.db
      .query("genuine_fluid_products")
      .withIndex("by_make_kind", (q) =>
        q.eq("make_key", make_key).eq("fluid_kind", args.fluidKind),
      )
      .collect();
    const existing = rows.find(
      (r) => normalizeOemNumber(r.oem_part_number) === norm,
    );
    const doc = {
      make_key,
      fluid_kind: args.fluidKind,
      spec: args.spec,
      viscosity: args.viscosity,
      oem_part_number: args.oemPartNumber,
      name: args.name,
      package_size: args.packageSize,
      provenance: args.provenance,
      created_at: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return { ok: true as const, updated: existing._id };
    }
    const id = await ctx.db.insert("genuine_fluid_products", doc);
    return { ok: true as const, inserted: id };
  },
});

export const _fluidRowsForMake = internalQuery({
  args: { makeKey: v.string(), fluidKind: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("genuine_fluid_products")
      .withIndex("by_make_kind", (q) =>
        q.eq("make_key", args.makeKey).eq("fluid_kind", args.fluidKind),
      )
      .collect();
  },
});

/** The rung: for each fluid role this config is missing (coolant from the
 *  core-role gap list; engine_oil when no real fitment exists — its
 *  universal fallback keeps it out of the gap list), anchor the make's
 *  curated rows against THIS vehicle's spec strings, verify, write. */
export const seedFluidsRung = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args) => {
    if (process.env.PARTS_GENUINE_FLUID_SEED === "off") {
      return { status: "disabled" as const };
    }
    const resolved: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.vehicleConfigId },
    );
    if (!resolved?.makeId || !resolved.make) return { status: "no_config" as const };
    const engine: any = resolved.engineId
      ? await ctx.runQuery(internal.vehicleEnrichment.v3queries.getEngine, {
          engineId: resolved.engineId,
        })
      : null;

    const latestRun: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getLatestRunForConfig,
      { vehicleConfigId: args.vehicleConfigId },
    );
    let applicableSlugs: string[] = ((latestRun?.quotability?.services ?? []) as any[]).map(
      (s: any) => s.slug,
    );
    if (applicableSlugs.length === 0) {
      applicableSlugs = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getPriorApplicableSlugs,
        { vehicleConfigId: args.vehicleConfigId },
      );
    }
    const fitments = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
      { vehicleConfigId: args.vehicleConfigId },
    );
    const missingRoles = new Set(
      missingCoreRoles(fitments, applicableSlugs, new Set()).map((m) => m.roleKey),
    );
    const hasReal = (sub: string) => fitments.some((f: any) => f.subcategory === sub);

    // Which fluid roles to attempt. `specValue` is the vehicle-side anchor —
    // when it is EMPTY the spec gate cannot fire, which used to end the rung
    // for that role even when the make has exactly one curated chemistry.
    const targets: Array<{
      roleKey: string;
      specValue: string | null;
      anchor: (row: any) => boolean;
    }> = [];
    if (missingRoles.has("coolant")) {
      targets.push({
        roleKey: "coolant",
        specValue: engine?.coolant_type ?? null,
        anchor: (row) => specMatches(row.spec, engine?.coolant_type),
      });
    }
    if (!hasReal("engine_oil") && engine?.oil_viscosity) {
      targets.push({
        roleKey: "engine_oil",
        specValue: engine.oil_viscosity,
        anchor: (row) => viscosityEquals(row.viscosity, engine.oil_viscosity),
      });
    }
    if (missingRoles.has("atf_fluid")) {
      targets.push({
        roleKey: "atf_fluid",
        specValue: resolved?.transFluidType ?? null,
        anchor: (row) => specMatches(row.spec, resolved?.transFluidType ?? null),
      });
    }
    if (targets.length === 0) return { status: "nothing_missing" as const };

    const metaBySubcategory: Record<string, any> = Object.fromEntries(
      Object.values(PART_FIELD_MAP).map((m: any) => [m.subcategory, m]),
    );
    // Rows span the CORPORATE FAMILY, own make's rows first. Fluids are
    // family-level truth under the parent's brand (Motorcraft serves Lincoln,
    // ACDelco serves GMC/Buick/Cadillac) and curating one row per family is
    // the whole point of the table — a make-only lookup re-created the
    // thin-make failure the attestation vocabulary already fixed (live: the
    // 2021 Nautilus's coolant hit no_seed_match with Ford rows on file).
    const famKeys = familyMakeKeys(resolved.make);

    const toVerify: Array<{
      roleKey: string;
      oem: string;
      name: string;
      quantity: number | null;
      observedTitle: string | null;
    }> = [];
    for (const t of targets) {
      const rows: any[] = [];
      const seenRow = new Set<string>();
      for (const famKey of famKeys) {
        const famRows: any[] = await ctx.runQuery(
          internal.vehicleEnrichment.genuineFluids._fluidRowsForMake,
          { makeKey: famKey, fluidKind: t.roleKey },
        );
        for (const row of famRows) {
          const norm = normalizeOemNumber(row.oem_part_number);
          if (seenRow.has(norm)) continue;
          seenRow.add(norm);
          rows.push(row);
        }
      }
      // Anchored rows are the normal path. When the vehicle carries NO spec
      // string to anchor against, a family with exactly ONE curated chemistry
      // for this kind is an unambiguous default — the adversarial verifier
      // still adjudicates it against the real vehicle before any write. Two
      // or more chemistries with no spec stays a real gap: guessing between
      // them 50/50 is exactly the wrong-chemistry failure this rung exists
      // to prevent.
      const anchored = rows.filter((row) => t.anchor(row));
      const candidates =
        anchored.length > 0 ? anchored : !t.specValue && rows.length === 1 ? rows : [];
      if (anchored.length === 0 && candidates.length === 1) {
        console.log(
          `[genuine-fluids] ${t.roleKey}: no vehicle spec on file — using the family's single curated chemistry (${candidates[0].oem_part_number}), verifier decides`,
        );
      }
      for (const row of candidates) {
        if (toVerify.some((x) => normalizeOemNumber(x.oem) === normalizeOemNumber(row.oem_part_number))) continue;
        toVerify.push({
          roleKey: t.roleKey,
          oem: row.oem_part_number,
          name: metaBySubcategory[t.roleKey]?.name ?? t.roleKey,
          quantity: null,
          observedTitle: row.name,
        });
      }
    }
    if (toVerify.length === 0) {
      return { status: "no_seed_match", targets: targets.map((t) => t.roleKey) } as const;
    }

    const verdicts = await verifyPartFitments(
      {
        year: resolved.year,
        make: resolved.make,
        model: resolved.model,
        trim: resolved.trim ?? "",
        engineCode: resolved.engineCode ?? undefined,
        displacement: resolved.displacement ?? undefined,
        oilViscosity: engine?.oil_viscosity ?? undefined,
      },
      toVerify,
    );
    const written: string[] = [];
    const outcomes: string[] = [];
    const filled = new Set<string>();
    for (const t of toVerify) {
      const vd = verdicts.find(
        (x) => x.roleKey === t.roleKey && normalizeOemNumber(x.oem) === normalizeOemNumber(t.oem),
      );
      const verdict = vd?.verdict ?? "uncertain";
      // Reasons ride the outcome strings — a refuted curated seed is a
      // machine-vs-curator disagreement that MUST be adjudicable from the
      // log, not re-run blind (three consecutive MB fluid refutations were
      // unexplainable until this line existed).
      outcomes.push(
        `${t.roleKey}:${t.oem}:${verdict}${vd?.reason ? ` — ${vd.reason.slice(0, 160)}` : ""}`,
      );
      // Curated + provenance + spec-anchored = catalog-grade: write unless
      // the verifier POSITIVELY refutes it for this vehicle.
      if (verdict === "refuted" || filled.has(t.roleKey)) continue;
      const meta = metaBySubcategory[t.roleKey];
      if (!meta) continue;
      const res: any = await ctx.runMutation(
        internal.vehicleEnrichment.v3mutations.upsertPartAndFitment,
        {
          oem_part_number: t.oem,
          name: meta.name,
          category: meta.category,
          subcategory: meta.subcategory,
          make_id: resolved.makeId,
          vehicle_config_id: args.vehicleConfigId,
          service_type: meta.serviceSlug ?? meta.subcategory,
          quantity_needed: 1,
          position: meta.position,
          service_role: meta.serviceRole,
          confidence: 0.75,
          observed_title: t.observedTitle ?? undefined,
        },
      );
      if (res?.part_id && !res?.rejected) {
        filled.add(t.roleKey);
        written.push(`${t.roleKey}:${t.oem}`);
      } else {
        outcomes.push(`${t.roleKey}:${t.oem}:write_rejected_${res?.rejected ?? "unknown"}`);
      }
    }
    const summary = { status: "done" as const, candidates: toVerify.length, outcomes, written };
    console.log("[genuine-fluids]", JSON.stringify(summary));
    return summary;
  },
});
