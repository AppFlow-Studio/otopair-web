// =============================================================================
// PUBLIC car-data teaser — backs the no-login /car-data marketing page.
//
// Deliberately NOT the full dataset (user decision Jul 14: teaser + CTA).
// An anonymous visitor gets: vehicle identity, the cached render, a handful
// of headline gate-passing specs, two sample intervals — and COUNTS of what
// the full product holds. The counts are the CTA; the full field set stays
// behind the /v0 API (key-authed) and the future paid report.
//
// Same sellability gate as everything else (lib/dataLayers): only servable
// (A/C/D/E, NHTSA-carve-out) fields can appear, even in the teaser.
// No auth by design; exposure is bounded by the teaser shape itself.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { collectSpecFields, latestFieldEvidence } from "./dataCatalog";
import { deriveLayer, isServable, type LayerLetter } from "./lib/dataLayers";

const slug = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// Headline fields — the consumer-recognizable ones, in display order.
const HEADLINE_FIELDS = [
  "oil_viscosity",
  "oil_capacity_qts",
  "coolant_type",
  "drivetrain",
  "spark_plug_quantity",
  "transmission_type",
  "brake_fluid_type",
] as const;
const HEADLINE_LIMIT = 5;

// --- Authored return types -----------------------------------------------------

export type TeaserSpec = {
  label: string;
  value: string;
  layer: LayerLetter;
};
export type TeaserResult =
  | {
      object: "teaser";
      config: {
        config_key: string;
        year: number;
        make: string;
        model: string;
        trim: string | null;
        engine: string | null;
        drivetrain: string | null;
      };
      image_url: string | null;
      headline_specs: TeaserSpec[];
      sample_intervals: { name: string; display: string }[];
      locked: {
        specs_served: number; // total gate-passing spec fields (incl. shown)
        intervals: number;
        part_fitments: number;
        empirical_labor_services: number;
      };
    }
  | { object: "multiple_matches"; matches: { config_key: string; label: string }[] }
  | null;

export const teaserLookup = query({
  args: {
    vin: v.optional(v.string()),
    year: v.optional(v.number()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim: v.optional(v.string()),
    config_key: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<TeaserResult> => {
    // ── Resolve (config_key | vin | ymmt) — same normalization as /v0 ──
    let c: Doc<"vehicle_configs"> | null = null;
    if (args.config_key) {
      c = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_config_key", (q) => q.eq("config_key", args.config_key!))
        .first();
    } else if (args.vin && args.vin.trim().length >= 11) {
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", args.vin!.trim().toUpperCase()))
        .first();
      if (vehicle?.vehicle_config_id) c = await ctx.db.get(vehicle.vehicle_config_id);
    } else if (args.year != null && args.make && args.model) {
      const prefix = `${args.year}_${slug(args.make)}_${slug(args.model)}`;
      const rows = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_config_key", (q) =>
          q.gte("config_key", prefix).lt("config_key", prefix + "￿"),
        )
        .take(25);
      const trimSlug = args.trim ? slug(args.trim) : null;
      const filtered = trimSlug ? rows.filter((r) => r.config_key.includes(trimSlug)) : rows;
      const pool = filtered.length > 0 ? filtered : rows;
      if (pool.length === 1) c = pool[0];
      else if (pool.length > 1) {
        return {
          object: "multiple_matches",
          matches: pool.map((r) => ({ config_key: r.config_key, label: r.config_key })),
        };
      }
    }
    if (!c) return null;

    const make = await ctx.db.get(c.make_id);
    const model = await ctx.db.get(c.model_id);
    const engine = c.engine_id ? await ctx.db.get(c.engine_id) : null;
    const transmission = c.transmission_id ? await ctx.db.get(c.transmission_id) : null;
    const engineLabel = engine
      ? [
          (engine.displacement_l ?? engine.displacement_liters) != null
            ? `${engine.displacement_l ?? engine.displacement_liters}L`
            : null,
          engine.engine_code ?? null,
        ]
          .filter(Boolean)
          .join(" ") || null
      : null;

    // ── Gate every spec field; count served, expose only the headline few ──
    const fields = collectSpecFields(c, engine, transmission);
    let servedTotal = 0;
    const headline: TeaserSpec[] = [];
    for (const f of fields) {
      if (f.value == null) continue;
      const ev = await latestFieldEvidence(ctx, c, f.field_name);
      const layer = deriveLayer(ev?.source_type ?? null, ev?.confidence ?? null);
      const servable = ev
        ? isServable(layer.letter, ev.source_type)
        : true; // stored value without evidence trail rides as C, same as /v0
      if (!servable) continue;
      servedTotal++;
      if (
        headline.length < HEADLINE_LIMIT &&
        (HEADLINE_FIELDS as readonly string[]).includes(f.field_name)
      ) {
        headline.push({ label: f.label, value: f.value, layer: ev ? layer.letter : "C" });
      }
    }

    // ── Locked counts (bounded indexed reads) ──
    const intervalRows = await ctx.db
      .query("service_intervals")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c!._id))
      .take(100);
    const realIntervals = intervalRows.filter(
      (r) => r.interval_miles != null || r.interval_months != null || r.display_string,
    );
    const services = await ctx.db.query("services").collect(); // 23 rows
    const serviceById = new Map(services.map((s) => [String(s._id), s.name]));
    const sampleIntervals = realIntervals.slice(0, 2).map((r) => ({
      name: serviceById.get(String(r.service_id)) ?? "Service",
      display:
        r.display_string ??
        [
          r.interval_miles != null ? `${r.interval_miles.toLocaleString("en-US")} mi` : null,
          r.interval_months != null ? `${r.interval_months} mo` : null,
        ]
          .filter(Boolean)
          .join(" / "),
    }));

    const fitments = await ctx.db
      .query("part_fitments")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c!._id))
      .take(200);
    const laborRows = await ctx.db
      .query("labor_times")
      .withIndex("by_vehicle_config", (q) => q.eq("vehicle_config_id", c!._id))
      .take(100);
    const empiricalServices = laborRows.filter(
      (l) => l.empirical_hours != null && (l.empirical_sample_size ?? 0) > 0,
    ).length;

    return {
      object: "teaser",
      config: {
        config_key: c.config_key,
        year: c.year,
        make: (make as { name?: string } | null)?.name ?? "?",
        model: (model as { name?: string } | null)?.name ?? "?",
        trim: c.trim_name ?? null,
        engine: engineLabel,
        drivetrain: c.drivetrain ?? null,
      },
      image_url: c.image_url ?? null,
      headline_specs: headline,
      sample_intervals: sampleIntervals,
      locked: {
        specs_served: servedTotal,
        intervals: realIntervals.length,
        part_fitments: fitments.length,
        empirical_labor_services: empiricalServices,
      },
    };
  },
});
