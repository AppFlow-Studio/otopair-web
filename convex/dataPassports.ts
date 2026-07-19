// =============================================================================
// Data portal · Vehicle ID — Passports & Shop Truth — /data/vehicle-id
// (Data spec §10.2). Two-layer rendering: Layer 1 static (AI-enriched decode,
// read-only BY CONSTRUCTION — this module exposes zero passport writes) and
// Layer 2 living (shop truth off vehicle_passports). Survey streams from
// job_actuals' typed prejob/postjob reports + vehicle_inspections.
// Honest descopes: passports store section-level timestamps, not per-field
// provenance — "last shop touch" renders per section; the ×2–3 override
// timeline ships when per-field history exists.
// =============================================================================
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";
import {
  getPassportCompletionPercent,
  getMissingRequiredPassportFields,
  PASSPORT_REQUIRED_FIELDS,
} from "./lib/vehicle_passports";

// --- Authored return types (see dataOverview.ts header) -----------------------

export type PassportListRow = {
  vin: string;
  vehicle: string | null;
  l1_pct: number; // decode-link completeness (trim/engine/config)
  l2_pct: number; // required passport fields (lib/vehicle_passports)
  mileage: number | null;
  last_shop_touch: number | null;
  verified_sections: number;
  updated_at: number | null;
};

export const listPassports = query({
  args: { token: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (
    ctx,
    { token, paginationOpts },
  ): Promise<{ page: PassportListRow[]; isDone: boolean; continueCursor: string }> => {
    await requireDirector(ctx, token);
    const page = await ctx.db
      .query("vehicle_passports")
      .withIndex("by_updated_at")
      .order("desc")
      .paginate(paginationOpts);

    const rows: PassportListRow[] = [];
    for (const p of page.page) {
      const veh = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", p.vin))
        .first();
      let vehicleLabel: string | null = null;
      let l1Links = 0;
      if (veh) {
        if (veh.trim_id) l1Links++;
        if (veh.engine_id) l1Links++;
        if (veh.vehicle_config_id) l1Links++;
        const config = veh.vehicle_config_id ? await ctx.db.get(veh.vehicle_config_id) : null;
        vehicleLabel = config
          ? config.config_key
          : veh.year != null
            ? `${veh.year} (decode incomplete)`
            : null;
      }
      // Verified-section count: sections carrying a shop-confirmation signal.
      let verified = 0;
      if (p.tires?.last_verified_at != null) verified++;
      if (p.fluids?.confirmation_status != null) verified++;
      if (p.brakes != null) verified++;
      if (p.inspection?.status != null) verified++;
      rows.push({
        vin: p.vin,
        vehicle: vehicleLabel,
        l1_pct: veh ? Math.round((l1Links / 3) * 100) : 0,
        l2_pct: getPassportCompletionPercent(p),
        mileage: p.mileage ?? null,
        last_shop_touch: p.last_shop_confirmed_at ?? null,
        verified_sections: verified,
        updated_at: p.updated_at ?? null,
      });
    }
    return { page: rows, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export type PassportDetailResult = {
  vin: string;
  // Layer 1 — static AI-enriched identity (read-only by construction)
  layer1: {
    year: number | null;
    make: string | null;
    model: string | null;
    trim: string | null;
    engine: string | null;
    drivetrain: string | null;
    config: { id: string; config_key: string } | null;
  };
  // Layer 2 — living shop truth (raw validated sections)
  layer2: {
    mileage: number | null;
    mileage_velocity: number | null;
    tires: unknown;
    fluids: unknown;
    brakes: unknown;
    inspection: unknown;
    modifications: unknown;
    first_shop_confirmed_at: number | null;
    last_shop_confirmed_at: number | null;
  };
  required_fields: readonly string[];
  missing_required: string[];
  inspections: {
    id: string;
    booking_id: string;
    template_version: string;
    zones_done: number;
    zones_total: number;
    attention: { label: string; zone: string }[];
    monitor: { label: string; zone: string }[];
    at: number;
  }[];
} | null;

export const passportDetail = query({
  args: { token: v.string(), vin: v.string() },
  handler: async (ctx, { token, vin }): Promise<PassportDetailResult> => {
    await requireDirector(ctx, token);
    const canonical = vin.trim().toUpperCase();
    const p = await ctx.db
      .query("vehicle_passports")
      .withIndex("by_vin", (q) => q.eq("vin", canonical))
      .first();
    if (!p) return null;

    // Layer 1 identity from the decode chain.
    const veh = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", canonical))
      .first();
    let make: string | null = null;
    let model: string | null = null;
    let trim: string | null = null;
    let engine: string | null = null;
    let drivetrain: string | null = null;
    let config: { id: string; config_key: string } | null = null;
    if (veh) {
      if (veh.trim_id) {
        const t = await ctx.db.get(veh.trim_id);
        trim = t ? ((t as { name?: string }).name ?? null) : null;
        const modelId = (t as { model_id?: import("./_generated/dataModel").Id<"models"> } | null)
          ?.model_id;
        if (modelId) {
          const m = await ctx.db.get(modelId);
          model = m ? ((m as { name?: string }).name ?? null) : null;
          const makeId = (m as { make_id?: import("./_generated/dataModel").Id<"makes"> } | null)
            ?.make_id;
          if (makeId) {
            const mk = await ctx.db.get(makeId);
            make = mk ? ((mk as { name?: string }).name ?? null) : null;
          }
        }
      }
      if (veh.engine_id) {
        const e = await ctx.db.get(veh.engine_id);
        const eo = e as { engine_code?: string; name?: string } | null;
        engine = eo?.engine_code ?? eo?.name ?? null;
      }
      if (veh.vehicle_config_id) {
        const c = await ctx.db.get(veh.vehicle_config_id);
        if (c) {
          config = { id: String(c._id), config_key: c.config_key };
          drivetrain = c.drivetrain ?? null;
        }
      }
    }

    // Recent inspections (Jun 19 instrumentation renders from zones).
    const inspections = await ctx.db
      .query("vehicle_inspections")
      .withIndex("by_vin", (q) => q.eq("vin", canonical))
      .order("desc")
      .take(10);

    // Missing required fields (shared helper — same math the shop flow uses).
    const missing = [...getMissingRequiredPassportFields(p)] as string[];

    return {
      vin: canonical,
      layer1: { year: veh?.year ?? null, make, model, trim, engine, drivetrain, config },
      layer2: {
        mileage: p.mileage ?? null,
        mileage_velocity: p.mileage_velocity ?? null,
        tires: p.tires ?? null,
        fluids: p.fluids ?? null,
        brakes: p.brakes ?? null,
        inspection: p.inspection ?? null,
        modifications: p.modifications ?? null,
        first_shop_confirmed_at: p.first_shop_confirmed_at ?? null,
        last_shop_confirmed_at: p.last_shop_confirmed_at ?? null,
      },
      required_fields: PASSPORT_REQUIRED_FIELDS,
      missing_required: missing,
      inspections: inspections.map((i) => ({
        id: String(i._id),
        booking_id: String(i.booking_id),
        template_version: i.template_version,
        zones_done: i.zones.filter((z) => z.done).length,
        zones_total: i.zones.length,
        attention: i.findings_attention,
        monitor: i.findings_monitor,
        at: i.created_at,
      })),
    };
  },
});

export type SurveyRow = {
  id: string;
  kind: "pre-job" | "post-job" | "both" | "none";
  vin: string | null;
  shop: string | null;
  mechanic: string | null;
  mileage: number | null;
  flagged_specs: boolean;
  parts_count: number;
  photos: number;
  tread: unknown; // tireTreadMeasurementsValidator shape (2×2 grid client-side)
  rotor_thickness: unknown; // rotorThicknessMeasurementsValidator shape
  filters: unknown; // prejobFilterChecksValidator shape (G/Y/R dots)
  at: number;
};

export const surveyStream = query({
  args: { token: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (
    ctx,
    { token, paginationOpts },
  ): Promise<{ page: SurveyRow[]; isDone: boolean; continueCursor: string }> => {
    await requireDirector(ctx, token);
    const page = await ctx.db
      .query("job_actuals")
      .withIndex("by_created_at")
      .order("desc")
      .paginate(paginationOpts);
    const shopName = new Map<string, string | null>();
    const mechName = new Map<string, string | null>();
    const rows: SurveyRow[] = [];
    for (const j of page.page) {
      const pre = j.prejob_report != null;
      const post = j.postjob_report != null;
      const booking = await ctx.db.get(j.booking_id);
      let shop: string | null = null;
      const shopId = (booking as { shop_id?: import("./_generated/dataModel").Id<"shops"> } | null)
        ?.shop_id;
      if (shopId) {
        const sid = String(shopId);
        if (!shopName.has(sid)) {
          const s = await ctx.db.get(shopId);
          shopName.set(sid, s ? ((s as { name?: string }).name ?? null) : null);
        }
        shop = shopName.get(sid) ?? null;
      }
      const mid = String(j.mechanic_id);
      if (!mechName.has(mid)) {
        const m = await ctx.db.get(j.mechanic_id);
        mechName.set(mid, m ? ((m as { name?: string }).name ?? null) : null);
      }
      rows.push({
        id: String(j._id),
        kind: pre && post ? "both" : pre ? "pre-job" : post ? "post-job" : "none",
        vin: (booking as { vin?: string } | null)?.vin ?? null,
        shop,
        mechanic: mechName.get(mid) ?? null,
        mileage: j.prejob_report?.mileage ?? j.postjob_report?.completion_mileage ?? null,
        flagged_specs:
          j.flagged_vehicle_specs === true || j.prejob_report?.flagged_vehicle_specs === true,
        parts_count: j.postjob_report?.parts_used?.length ?? 0,
        photos: j.postjob_report?.postjob_photos?.length ?? 0,
        tread: j.prejob_report?.tire_tread ?? null,
        rotor_thickness: j.prejob_report?.brakes != null
          ? (j.prejob_report.brakes as { rotor_thickness?: unknown }).rotor_thickness ?? null
          : null,
        filters: j.prejob_report?.filters ?? null,
        at: j.created_at ?? j._creationTime,
      });
    }
    return { page: rows, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
