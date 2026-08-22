import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { applyBookingStatusTransition } from "./bookings";
import {
  ensureJobActualRecord,
  finalizeJobActuals,
  getLatestJobActualForBooking,
  jobActualInputValidator,
  jobActualPartValidator,
  reopenJobActuals,
  saveJobActualDraft,
} from "./lib/job_actuals";
import { summarizePartPrices, quoteUnitPrice } from "./part_prices";
import {
  axleForBrakeService,
  axlePositionByServiceId,
  fitmentMatchesPosition,
  isBrakeSlug,
  partNameAxle,
  type AxlePosition,
} from "./lib/brakeScope";
import { ensureWalkInCashPayment } from "./bookings";
import { partFitsConfigMake } from "./partSelector";
import { hydrateTieredInspectionState } from "./lib/hydrateInspectionState";
import { resolveSparkPlugQuantity } from "./lib/sparkPlugs";
import { deriveSuggestedRecommendations } from "../lib/inspection-template";

function primaryServiceId(booking: { service_ids?: Id<"services">[] }): Id<"services"> | undefined {
  return booking.service_ids?.[0];
}

type SuggestedPart = {
  part_name: string;
  oem_number: string;
  cost: number;
  // Whole-unit count of this part needed for the service. Sourced from
  // part_fitments.quantity_needed (catalog) or service-specific knowledge
  // (spark_plug_quantity, tire qty). UI falls back to 1 when absent.
  quantity?: number;
  // The booking service this suggestion belongs to. Lets the post-job and
  // backfill flows render per-service parts blocks and lets snapshot
  // attribution stay accurate on multi-service jobs.
  service_id?: Id<"services">;
  // Which layer of the cascade returned this part. Lets the UI badge
  // "Used last time on this car" (vin) vs "Shop default" (shop) vs catalog
  // fallback. Absent for legacy paths that pre-date the layered cascade.
  learned_from?: "vin" | "shop" | "config" | "catalog";
  // Tire-replacement suggestion — identity lives in these structured fields
  // (tires have no OEM number). oem_number carries the `TIRE-{size}` sentinel.
  is_tire?: boolean;
  tire_size?: string | null;
  tire_brand?: string | null;
  tire_model?: string | null;
  tire_position?: string | null;
};

// Mirror of SHOP_DEMOTE_DELTA in shop_part_preferences.ts so the cascade
// applies the same vote-against rule as the accrual writer.
const CASCADE_SHOP_DEMOTE_DELTA = 2;

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Three-layer prefill cascade for the post-job parts step.
 *
 *   Layer 1 — Shop preferences: parts where this shop has crossed the
 *             use-count default threshold for this (service, config).
 *             Cost = median of this shop's recent unit_costs for that part.
 *
 *   Layer 2 — Cross-shop aggregate: top-N parts other shops use for the
 *             same (service, config), ranked by use_count, with median
 *             unit_cost. Only fires once sample crosses the min threshold.
 *
 * If both miss, returns []. The caller falls through to the legacy
 * service_vehicle_specs slug-based suggestion as the catalog floor.
 */
async function resolveSuggestedPartsFromCascade(
  ctx: any,
  {
    shopId,
    serviceId,
    vehicleConfigId,
    vin,
  }: {
    shopId: Id<"shops">;
    serviceId: Id<"services">;
    vehicleConfigId: Id<"vehicle_configs">;
    /** Canonical VIN. When set, Layer 0 (per-VIN sticky preference) is tried
     *  first — that's how "we know this car had this part installed" wins
     *  over the shop's per-model default. */
    vin?: string;
  },
): Promise<SuggestedPart[]> {
  // Layer 0 — per-VIN sticky. Single hit short-circuits the cascade so the
  // mechanic sees what's actually installed in THIS car, not what the shop
  // installs on this model in general.
  if (vin) {
    const vinRows = await ctx.db
      .query("vehicle_part_preferences")
      .withIndex("by_vin_service", (q: any) =>
        q.eq("vin", vin).eq("service_id", serviceId),
      )
      .collect();

    const eligibleVin = vinRows.filter((r: any) => {
      const used = r.use_count ?? 0;
      const against = (r.swap_away_count ?? 0) + (r.not_used_count ?? 0);
      // Either explicitly the sticky default OR a single use that hasn't
      // been voted against past the threshold.
      return r.is_default === true || against <= used + CASCADE_SHOP_DEMOTE_DELTA;
    });

    if (eligibleVin.length > 0) {
      // Hydrate each into a SuggestedPart. Use shop-level snapshots for the
      // cost estimate when possible; fall back to the cross-shop median.
      const vinSuggestions: SuggestedPart[] = [];
      for (const row of eligibleVin) {
        const part = await ctx.db.get(row.part_id);
        if (!part) continue;
        // Median of recent shop-supplied snapshots for this part across any
        // vehicle_config, scoped to the shop when known. Cheap-and-good — a
        // dedicated per-VIN cost would be too thin a sample.
        const recent = await ctx.db
          .query("part_snapshots")
          .withIndex("by_part", (q: any) => q.eq("part_id", row.part_id))
          .order("desc")
          .take(50);
        const usable = (recent as any[]).filter(
          (s) =>
            s.superseded_by_id === undefined &&
            s.supplied_by === "shop" &&
            s.not_used !== true,
        );
        vinSuggestions.push({
          part_name: part.name,
          oem_number: part.oem_part_number,
          cost: medianOf(usable.map((s) => s.unit_cost)),
          learned_from: "vin",
        });
      }
      if (vinSuggestions.length > 0) return vinSuggestions;
    }
  }

  // Layer 1
  const prefs = await ctx.db
    .query("shop_part_preferences")
    .withIndex("by_shop_service_config", (q: any) =>
      q
        .eq("shop_id", shopId)
        .eq("service_id", serviceId)
        .eq("vehicle_config_id", vehicleConfigId),
    )
    .collect();
  // Honor is_default AND the same demote rule the accrual writer uses, so
  // a recently-demoted preference doesn't sneak back in before the next
  // accrual tick.
  const defaults = prefs.filter((p: any) => {
    if (!p.is_default) return false;
    const against = (p.swap_away_count ?? 0) + (p.not_used_count ?? 0);
    return against <= (p.use_count ?? 0) + CASCADE_SHOP_DEMOTE_DELTA;
  });

  if (defaults.length > 0) {
    // Pull this shop's recent snapshots once and bucket by part_id so we can
    // compute a realistic suggested cost for each preferred part.
    const shopSnapshots = await ctx.db
      .query("part_snapshots")
      .withIndex("by_shop_service_config", (q: any) =>
        q
          .eq("shop_id", shopId)
          .eq("service_id", serviceId)
          .eq("vehicle_config_id", vehicleConfigId),
      )
      .order("desc")
      .take(50);

    const costsByPart = new Map<string, number[]>();
    for (const snap of shopSnapshots as any[]) {
      if (snap.superseded_by_id !== undefined) continue;
      if (snap.supplied_by !== "shop") continue;
      if (!snap.part_id) continue;
      const key = snap.part_id as unknown as string;
      const bucket = costsByPart.get(key) ?? [];
      bucket.push(snap.unit_cost);
      costsByPart.set(key, bucket);
    }

    const suggestions: SuggestedPart[] = [];
    for (const pref of defaults) {
      const part = await ctx.db.get(pref.part_id);
      if (!part) continue;
      const costs = costsByPart.get(pref.part_id as unknown as string) ?? [];
      suggestions.push({
        part_name: part.name,
        oem_number: part.oem_part_number,
        cost: medianOf(costs),
        learned_from: "shop",
      });
    }
    if (suggestions.length > 0) return suggestions;
  }

  // Layer 2 — cross-shop aggregate. Min sample of 5 to avoid noise.
  const crossShop = await ctx.db
    .query("part_snapshots")
    .withIndex("by_service_config", (q: any) =>
      q.eq("service_id", serviceId).eq("vehicle_config_id", vehicleConfigId),
    )
    .collect();

  const eligible = (crossShop as any[]).filter(
    (row) =>
      row.superseded_by_id === undefined &&
      row.supplied_by === "shop" &&
      row.part_id !== undefined,
  );
  if (eligible.length < 5) return [];

  const byPart = new Map<
    string,
    { part_id: Id<"oem_parts">; count: number; costs: number[] }
  >();
  for (const row of eligible) {
    const key = row.part_id as unknown as string;
    const bucket = byPart.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.costs.push(row.unit_cost);
    } else {
      byPart.set(key, {
        part_id: row.part_id as Id<"oem_parts">,
        count: 1,
        costs: [row.unit_cost],
      });
    }
  }

  const ranked = Array.from(byPart.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 2);

  const suggestions: SuggestedPart[] = [];
  for (const entry of ranked) {
    const part = await ctx.db.get(entry.part_id);
    if (!part) continue;
    suggestions.push({
      part_name: part.name,
      oem_number: part.oem_part_number,
      cost: medianOf(entry.costs),
      learned_from: "config",
    });
  }
  return suggestions;
}

async function getCurrentUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();

  if (!user) throw new Error("User not found");
  return user;
}

async function requireShopStaff(ctx: any, userId: any, shopId: any) {
  const shopUser = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", userId).eq("shop_id", shopId)
    )
    .first();

  if (shopUser && shopUser.is_active) {
    return shopUser;
  }

  const ownedShop = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .filter((q: any) => q.eq(q.field("_id"), shopId))
    .first();

  if (ownedShop) {
    return {
      user_id: userId,
      shop_id: shopId,
      role: "owner",
      is_active: true,
    };
  }

  throw new Error("Not authorized for this shop");
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("job_actuals").collect();
  },
});

export const getById = query({
  args: { id: v.id("job_actuals") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByBookingId = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;

    await requireShopStaff(ctx, user._id, booking.shop_id);
    if (booking.status !== "vehicle_at_shop" && booking.status !== "in_progress") {
      throw new Error("Mark the vehicle here before starting work.");
    }

    return await getLatestJobActualForBooking(ctx, args.bookingId);
  },
});

export const getPostjobReportForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;

    await requireShopStaff(ctx, user._id, booking.shop_id);

    const actual = await getLatestJobActualForBooking(ctx, args.bookingId);
    if (!actual) return null;

    return {
      postjobReport: actual.postjob_report ?? null,
      submittedAt: actual.updated_at ?? actual._creationTime ?? null,
      mechanicId: actual.mechanic_id ?? null,
    };
  },
});

export const getPrefillData = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;

    await requireShopStaff(ctx, user._id, booking.shop_id);

    // Walk-in bookings give the mechanic full control over parts: we only
    // pre-fill what they explicitly declared ("Add parts" → priced_parts_snapshot).
    // The catalog cascade / floor / OEM-fitment auto-fill below is suppressed so
    // a "Skip" / "No parts" walk-in starts with an empty, editable parts step
    // instead of injecting catalog parts the mechanic never chose. Customer
    // self-serve bookings keep the full cascade behavior.
    const isWalkIn =
      (booking as any).source === "mechanic_walk_in" ||
      (booking as any).source === "mechanic_backfill";

    const serviceId = primaryServiceId(booking);
    const service = serviceId ? await ctx.db.get(serviceId) : null;

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", booking.vin))
      .unique();
    if (!vehicle) return null;

    const engine = vehicle.engine_id ? await ctx.db.get(vehicle.engine_id) : null;
    if (!engine) return null;

    const trim = engine.trim_id ? await ctx.db.get(engine.trim_id) : null;
    const model = trim ? await ctx.db.get(trim.model_id as Id<"models">) : null;
    const make = model ? await ctx.db.get(model.make_id as Id<"makes">) : null;

    const vehicleLabel = [make?.name, model?.name, trim?.name, vehicle.year]
      .filter(Boolean)
      .join(" ");

    const mechanic = booking.mechanic_id ? await ctx.db.get(booking.mechanic_id) : null;
    const mechanicName = mechanic
      ? `${mechanic.first_name} ${mechanic.last_name}`
      : "Unassigned";

    const allSpecs = await ctx.db.query("service_vehicle_specs").collect();
    const specs = allSpecs.find((row: any) => row.engine_id === engine._id);

    const suggestedParts: SuggestedPart[] = [];

    // Per-service axle scope (front/rear/both) from the customer's chosen
    // options. Drives the brake-pad/rotor scoping below so a "Rear pads only"
    // job doesn't pre-list front pads. Services with no axle signal stay
    // undefined → no filtering (both axles shown).
    const axleByServiceId = axlePositionByServiceId(booking);
    const brakeAxleByServiceId = new Map<string, AxlePosition>();
    for (const sid of booking.service_ids ?? []) {
      const svc: any = await ctx.db.get(sid);
      if (!svc?.slug || !isBrakeSlug(svc.slug)) continue;
      const axle = axleForBrakeService(
        booking,
        String(sid),
        svc.slug,
        axleByServiceId,
      );
      if (axle) brakeAxleByServiceId.set(String(sid), axle);
    }

    // Pre-Job Approval flow: when the booking was created with a priced
    // parts snapshot (frozen per-unit prices from `getPricedPartsForServices`
    // at booking time), seed `suggestedParts` from that first. This is the
    // SAME data the customer saw on Review & Pay, so the mechanic and
    // customer can't disagree about the unit price even if `part_prices`
    // has drifted since. The cascade + catalog fallbacks below run
    // afterward and skip anything already covered by the snapshot.
    const snapshot: any[] = ((booking as any).priced_parts_snapshot ?? []);
    const snapshotOems = new Set<string>();
    // Services the quote already covers. The hardcoded catalog floor (layer 3)
    // below must NOT fire for these — its gate (`length === before`) is true
    // whenever the cascade added nothing, which INCLUDES the case where every
    // cascade row was deduped against the snapshot. Without this guard a
    // fully-quoted oil change re-adds catalog "Oil Filter / Synthetic Oil /
    // Drain Plug Gasket" rows that were never on the quote.
    const snapshotServiceIds = new Set<string>();
    const normalizeOem = (n: string) =>
      n.trim().toUpperCase().replace(/\s+/g, "");
    if (snapshot && snapshot.length > 0) {
      for (const row of snapshot) {
        // Rows the snapshotRevalidation sweep stamped as cross-make
        // contaminated must not pre-fill the mechanic's billing dialog.
        if (row.integrity_flag != null) continue;
        suggestedParts.push({
          part_name: row.part_name,
          oem_number: row.oem_number,
          // Snapshot stores cents; SuggestedPart.cost is dollars per-unit.
          cost: Math.round(row.unit_price_cents) / 100,
          quantity: row.quantity,
          service_id: row.service_id,
          learned_from: "config",
        });
        if (row.oem_number) snapshotOems.add(normalizeOem(row.oem_number));
        if (row.service_id) snapshotServiceIds.add(String(row.service_id));
      }
    }

    // Sentinel-prefix tire identifiers so downstream consumers that key on
    // oem_number (part_snapshots, shop_part_preferences) don't get bare
    // size codes treated as OEM numbers.
    const tireOem = (size: string | null | undefined) =>
      size ? `TIRE-${size}` : "";

    // Per-service suggestion build. Each service in the booking gets its own
    // shot at: layers 1+2 (cascade) → layer 3 (catalog floor) → tire-specific
    // prefill. Stamping service_id on every push keeps multi-service jobs
    // correctly attributed downstream (snapshots, per-service analytics).
    for (const sid of booking.service_ids ?? []) {
      const svc: any = await ctx.db.get(sid);
      if (!svc) continue;

      const before = suggestedParts.length;

      if (!isWalkIn && vehicle.vehicle_config_id && booking.shop_id) {
        const cascadeSuggestions = await resolveSuggestedPartsFromCascade(ctx, {
          shopId: booking.shop_id,
          serviceId: sid,
          vehicleConfigId: vehicle.vehicle_config_id,
          // Canonical VIN unlocks Layer 0 (per-VIN sticky preference). When
          // a previous mechanic recorded a part install on this exact car,
          // it surfaces here ahead of the per-model default.
          vin: typeof booking.vin === "string" ? booking.vin : undefined,
        });
        for (const s of cascadeSuggestions) {
          // Skip rows already covered by the booking-time priced snapshot —
          // the snapshot is the customer's source of truth.
          if (s.oem_number && snapshotOems.has(normalizeOem(s.oem_number))) {
            continue;
          }
          suggestedParts.push({ ...s, service_id: sid });
        }
      }

      // Layer 3 catalog floor — only when the cascade produced nothing for
      // this service AND the quote snapshot doesn't already cover it. Uses
      // service_vehicle_specs OEM columns indexed by engine to suggest
      // canonical parts even with zero historical data. Skipping
      // snapshot-covered services keeps post-job anchored to what was quoted.
      if (
        !isWalkIn &&
        suggestedParts.length === before &&
        specs &&
        !snapshotServiceIds.has(String(sid))
      ) {
        // TODO(ts-fix): service_vehicle_specs schema is missing OEM-part fields used below:
        //   oil_filter_oem, oil_capacity_qts (lives on engines), oil_viscocity (note: actual field on engines is oil_viscosity),
        //   oil_drain_plug_gasket_oem, front_brake_pad_oem, rear_brake_pad_oem, engine_air_filter_oem,
        //   cabin_air_filter_oem, spark_plug_oem, spark_plug_quantity (lives on engines),
        //   serpentine_belt_oem, front_brake_rotor_oem, rear_brake_rotor_oem.
        //   Verify intent (rename/migrate/add to schema); using `any` cast meanwhile.
        const s = specs as any;
        const slug = svc.slug;
        if (slug === "oil-change") {
          suggestedParts.push({
            part_name: "Oil Filter",
            oem_number: s.oil_filter_oem ?? "",
            cost: 12,
            service_id: sid,
          });
          suggestedParts.push({
            part_name: `Synthetic Oil ${s.oil_capacity_qts ?? "-"}qt`,
            oem_number: s.oil_viscocity ?? "",
            cost: 35,
            service_id: sid,
          });
          if (s.oil_drain_plug_gasket_oem) {
            suggestedParts.push({
              part_name: "Drain Plug Gasket",
              oem_number: s.oil_drain_plug_gasket_oem,
              cost: 2,
              service_id: sid,
            });
          }
        } else if (slug === "brake-pads") {
          const axle = brakeAxleByServiceId.get(String(sid));
          if (axle !== "rear") {
            suggestedParts.push({
              part_name: "Front Brake Pads",
              oem_number: s.front_brake_pad_oem ?? "",
              cost: 45,
              service_id: sid,
            });
          }
          if (axle !== "front") {
            suggestedParts.push({
              part_name: "Rear Brake Pads",
              oem_number: s.rear_brake_pad_oem ?? "",
              cost: 40,
              service_id: sid,
            });
          }
        } else if (slug === "engine-air-filter" && s.engine_air_filter_oem) {
          suggestedParts.push({
            part_name: "Engine Air Filter",
            oem_number: s.engine_air_filter_oem,
            cost: 25,
            service_id: sid,
          });
        } else if (slug === "cabin-air-filter" && s.cabin_air_filter_oem) {
          suggestedParts.push({
            part_name: "Cabin Air Filter",
            oem_number: s.cabin_air_filter_oem,
            cost: 22,
            service_id: sid,
          });
        } else if (slug === "spark-plugs" && s.spark_plug_oem) {
          // Per-unit cost (the dialog multiplies by quantity for the total).
          // Pre-fix bug: previously pushed `cost: 12 * qty` (line total)
          // with no `quantity`, which the dialog then multiplied again.
          //
          // The `?? 4` this replaces was a second, quieter bug: a missing
          // quantity billed FOUR plugs on every engine, so a V6 was under-
          // quoted by two and a HEMI V8 by twelve — confidently, with nothing
          // marking it as a guess. `engine` is in scope here, so derive from
          // its real cylinder count instead (lib/sparkPlugs owns the twin-plug
          // exceptions). A genuinely unknown count now falls back to 1 rather
          // than 4: still not the truth, but off by the smallest possible
          // margin and visible as an obviously-wrong line rather than a
          // plausible one. The pre-job form is where a mechanic corrects it.
          const resolved = resolveSparkPlugQuantity({
            spark_plug_quantity: s.spark_plug_quantity ?? engine.spark_plug_quantity,
            cylinders: engine.cylinders,
            make: make?.name,
            engineCode: engine.engine_code,
            displacementL: engine.displacement_l,
          });
          if (resolved.quantity == null) {
            console.warn(
              `[job-actuals] spark plug quantity unknown for engine ${engine._id} ` +
                `(cylinders=${engine.cylinders ?? "null"}) — quoting 1, needs mechanic input`,
            );
          }
          const qty = resolved.quantity ?? 1;
          suggestedParts.push({
            part_name: "Spark Plug",
            oem_number: s.spark_plug_oem,
            cost: 12,
            quantity: qty,
            service_id: sid,
          });
        } else if (slug === "serpentine-belt" && s.serpentine_belt_oem) {
          suggestedParts.push({
            part_name: "Serpentine Belt",
            oem_number: s.serpentine_belt_oem,
            cost: 45,
            service_id: sid,
          });
        } else if (slug === "brake-rotors" && s.front_brake_rotor_oem) {
          const axle = brakeAxleByServiceId.get(String(sid));
          if (axle !== "rear") {
            suggestedParts.push({
              part_name: "Front Brake Rotors",
              oem_number: s.front_brake_rotor_oem ?? "",
              cost: 85,
              service_id: sid,
            });
          }
          if (axle !== "front" && s.rear_brake_rotor_oem) {
            suggestedParts.push({
              part_name: "Rear Brake Rotors",
              oem_number: s.rear_brake_rotor_oem,
              cost: 75,
              service_id: sid,
            });
          }
        }
      }

      // Tire-replacement — independent of service_vehicle_specs. For in-app
      // bookings the accepted tire_quote_responses row has brand / model /
      // per-tire price / qty; for walk-in / backfilled jobs fall back to
      // booking.tire_specs and leave cost 0 for the mechanic to fill.
      if (suggestedParts.length === before && svc.slug === "tire-replacement") {
        const acceptedQuote = await ctx.db
          .query("tire_quote_responses")
          .withIndex("by_booking_id", (q: any) =>
            q.eq("booking_id", booking._id),
          )
          .filter((q: any) => q.eq(q.field("superseded_at"), undefined))
          .first();
        if (acceptedQuote) {
          const qty = acceptedQuote.quantity ?? 4;
          const brandModel = [acceptedQuote.tire_brand, acceptedQuote.tire_model]
            .filter(Boolean)
            .join(" ");
          suggestedParts.push({
            part_name: brandModel
              ? `Tires — ${brandModel} (x${qty})`
              : `Tires (x${qty})`,
            oem_number: tireOem(booking.tire_specs?.size),
            // Per-unit cost + real quantity so the parts step (which bills
            // cost × quantity) shows the true count instead of a single line.
            cost: acceptedQuote.per_tire_price ?? 0,
            quantity: qty,
            service_id: sid,
            is_tire: true,
            tire_size: booking.tire_specs?.size ?? null,
            tire_brand: acceptedQuote.tire_brand ?? null,
            tire_model: acceptedQuote.tire_model ?? null,
          });
        } else if (booking.tire_specs) {
          const qty = booking.tire_specs.quantity ?? 4;
          suggestedParts.push({
            part_name: `Tires — ${booking.tire_specs.tier} ${booking.tire_specs.type} (x${qty})`,
            oem_number: tireOem(booking.tire_specs.size),
            cost: 0,
            quantity: qty,
            service_id: sid,
            is_tire: true,
            tire_size: booking.tire_specs.size ?? null,
          });
        }
      }
    }

    // OEM catalog recommendations from part_fitments — one entry per service
    // on the booking. Surfaced in the post-job UI as a confirm-or-swap
    // checklist, so the mechanic can verify the catalog matches reality.
    type OemRecommendationPart = {
      part_id: Id<"oem_parts">;
      oem_part_number: string;
      part_name: string;
      brand: string | null;
      part_tier: string | null;
      category: string | null;
      quantity_needed: number | null;
      position: string | null;
      average_price: number;       // 0 when no price data
      median_price: number;        // 0 when no price data
      price_sample_size: number;
      price_sources_used: number;
    };
    const oemRecommendations: Array<{
      service_id: Id<"services">;
      service_slug: string;
      service_name: string;
      parts: OemRecommendationPart[];
    }> = [];

    if (vehicle.vehicle_config_id) {
      const recConfig = await ctx.db.get(vehicle.vehicle_config_id);
      for (const sid of booking.service_ids ?? []) {
        const svc = await ctx.db.get(sid);
        if (!svc?.slug) continue;
        const fitments = await ctx.db
          .query("part_fitments")
          .withIndex("by_config_service", (q) =>
            q
              .eq("vehicle_config_id", vehicle.vehicle_config_id!)
              .eq("service_type", svc.slug!),
          )
          .collect();
        const recPosition = isBrakeSlug(svc.slug)
          ? brakeAxleByServiceId.get(String(sid))
          : undefined;
        const parts: OemRecommendationPart[] = [];
        for (const f of fitments) {
          if (f.package_code != null) continue;
          const part = await ctx.db.get(f.part_id);
          if (!part) continue;
          // I1 make guard: drop cross-make contaminant parts
          if (!partFitsConfigMake(part.make_id, recConfig?.make_id)) continue;
          // Scope to the booked axle — position-neutral parts (hardware,
          // grease) survive a single-axle filter.
          if (!fitmentMatchesPosition(f.position, part.subcategory, recPosition)) {
            continue;
          }
          const priceSummary = await summarizePartPrices(ctx, f.part_id);
          parts.push({
            part_id: f.part_id,
            oem_part_number: part.oem_part_number,
            part_name: part.name,
            brand: part.brand ?? null,
            part_tier: part.part_tier ?? null,
            category: part.category ?? null,
            quantity_needed: f.quantity_needed ?? null,
            position: f.position ?? null,
            average_price: priceSummary.average,
            median_price: priceSummary.median,
            price_sample_size: priceSummary.sample_size,
            price_sources_used: priceSummary.used_sample_size,
          });
        }
        if (parts.length > 0) {
          oemRecommendations.push({
            service_id: sid,
            service_slug: svc.slug,
            service_name: svc.name,
            parts,
          });
        }
      }
    }

    // Merge any OEM-recommended parts that aren't already represented in
    // suggestedParts (by normalized oem_number) so they appear as
    // pre-listed rows in the post-job parts step ready to confirm. Suppressed
    // for walk-ins — they only pre-fill explicitly-declared parts; the
    // oemRecommendations list is still returned below as a reference strip.
    const normalize = (n: string) => n.trim().toUpperCase().replace(/\s+/g, "");
    const existingByOem = new Map<string, SuggestedPart>();
    for (const p of suggestedParts) {
      const key = p.oem_number ? normalize(p.oem_number) : "";
      if (key) existingByOem.set(key, p);
    }
    for (const rec of isWalkIn ? [] : oemRecommendations) {
      for (const part of rec.parts) {
        const key = normalize(part.oem_part_number);
        if (!key) continue;
        const catalogQty =
          typeof part.quantity_needed === "number" && part.quantity_needed > 0
            ? part.quantity_needed
            : undefined;
        const existing = existingByOem.get(key);
        if (existing) {
          // Cascade already surfaced this part — stamp the catalog qty so the
          // mechanic sees the correct count (e.g., 4 spark plugs) instead of
          // the UI's hard-coded fallback of 1.
          if (existing.quantity === undefined && catalogQty !== undefined) {
            existing.quantity = catalogQty;
          }
          continue;
        }
        suggestedParts.push({
          part_name: part.part_name,
          oem_number: part.oem_part_number,
          // Shared PARTS_PRICE_SOURCE selector — matches what the customer saw
          // on the Review & Pay screen (serviceParts uses the same helper).
          // Median across sources once flipped (>=3 sources), else the
          // outlier-rejected mean. Default is average.
          cost: quoteUnitPrice({
            average: part.average_price,
            median: part.median_price,
            sample_size: part.price_sample_size ?? 0,
          }),
          quantity: catalogQty,
          service_id: rec.service_id,
          // These rows didn't come from a learned preference — they're the
          // canonical catalog fitment for the (vehicle_config, service)
          // tuple. The UI badges them differently from "Used last time on
          // this car" / "Shop default".
          learned_from: "catalog",
        });
        existingByOem.set(key, suggestedParts[suggestedParts.length - 1]);
      }
    }

    // Prior open recommendations for the same VIN (shop-scoped). Surfaced as
    // a muted "last visit said…" strip at the top of the post-job step so
    // the mechanic has memory aids — actual confirmation happens in pre-job.
    const priorRecRows = booking.shop_id
      ? (
          await ctx.db
            .query("job_recommendations")
            .withIndex("by_vehicle_and_status", (q) =>
              q.eq("vehicle_vin", booking.vin).eq("status", "open"),
            )
            .collect()
        )
          .filter((r) => String(r.shop_id) === String(booking.shop_id))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, 5)
      : [];
    const priorOpenRecommendations = await Promise.all(
      priorRecRows.map(async (rec) => {
        const svc = rec.recommended_service_id
          ? await ctx.db.get(rec.recommended_service_id)
          : null;
        return {
          _id: rec._id,
          service_name: svc?.name ?? rec.freeform_text ?? "Unspecified",
          is_freeform: !rec.recommended_service_id,
          urgency: rec.urgency,
          reason: rec.reason ?? null,
          created_at: rec.created_at,
        };
      }),
    );

    // Final axle net: drop any brake suggestion whose name names the OTHER
    // axle than the booking covers. Catches rows from sources that don't carry
    // a subcategory — the priced-snapshot seed (which can mis-default to front
    // on older bookings) and the learned cascade. Position-neutral names are
    // kept (partNameAxle returns null).
    const scopedSuggestedParts = suggestedParts.filter((p) => {
      const sid = p.service_id ? String(p.service_id) : null;
      const axle = sid ? brakeAxleByServiceId.get(sid) : undefined;
      if (!axle || axle === "both") return true;
      const nameAxle = partNameAxle(p.part_name);
      return nameAxle == null || nameAxle === axle;
    });

    // This visit's inspection recommendations — split into what the mechanic
    // already confirmed at pre-job (read-only here) and what they saw but
    // didn't check (a second chance at post-job). See "Post-job survey —
    // surfacing this visit's inspection recommendations."
    const thisVisitRecRows = await ctx.db
      .query("job_recommendations")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .collect();
    const confirmedThisVisitRows = thisVisitRecRows.filter(
      (r) => r.source === "inspection",
    );
    const confirmedThisVisit = await Promise.all(
      confirmedThisVisitRows.map(async (rec) => {
        const svc = rec.recommended_service_id
          ? await ctx.db.get(rec.recommended_service_id)
          : null;
        return {
          _id: rec._id,
          service_name: svc?.name ?? rec.freeform_text ?? "Unspecified",
          is_freeform: !rec.recommended_service_id,
          urgency: rec.urgency,
          reason: rec.reason ?? null,
          created_at: rec.created_at,
        };
      }),
    );
    const confirmedServiceIds = new Set(
      confirmedThisVisitRows
        .map((r) => (r.recommended_service_id ? String(r.recommended_service_id) : null))
        .filter((id): id is string => !!id),
    );
    const confirmedFreeformLabels = new Set(
      confirmedThisVisitRows
        .filter((r) => !r.recommended_service_id)
        .map((r) => (r.freeform_text ?? "").trim().toLowerCase())
        .filter((label) => label.length > 0),
    );

    const inspection = await ctx.db
      .query("vehicle_inspections")
      .withIndex("by_booking", (q) => q.eq("booking_id", args.bookingId))
      .first();
    const allServices = booking.shop_id ? await ctx.db.query("services").collect() : [];
    const suggestedFromInspection = inspection
      ? deriveSuggestedRecommendations(hydrateTieredInspectionState(inspection), {
          onlyCompletedZones: true,
        })
          .map((s) => {
            const found = allServices.find((svc: any) =>
              svc.slug ? s.match.includes(svc.slug) : false,
            );
            return {
              key: s.key,
              label: s.label,
              urgency: s.urgency,
              reasons: s.reasons,
              serviceId: found?._id ?? null,
              serviceName: found?.name ?? null,
            };
          })
          .filter((s) =>
            s.serviceId
              ? !confirmedServiceIds.has(String(s.serviceId))
              : !confirmedFreeformLabels.has(s.label.trim().toLowerCase()),
          )
      : [];

    // Prejob inspection tire findings — surfaced so the mid-job / walk-in tire
    // editor can prefill the sizes (and brand/model) recorded per corner during
    // the multi-point inspection. Front axle takes front_left else front_right;
    // rear axle takes rear_left else rear_right (sizes are synced per axle).
    const latestActual = await getLatestJobActualForBooking(ctx, args.bookingId);
    const prejob = (latestActual?.prejob_report ?? null) as any;
    const td = prejob?.tire_details ?? null;
    const pickCorner = (a: any, b: any) =>
      (a ?? null) || (b ?? null) || null;
    const prejobTires = prejob
      ? {
          tire_size_front: prejob.tire_size_front ?? null,
          tire_size_rear: prejob.tire_size_rear ?? null,
          front: td
            ? {
                brand: pickCorner(td.front_left?.brand, td.front_right?.brand),
                model: pickCorner(td.front_left?.model, td.front_right?.model),
              }
            : null,
          rear: td
            ? {
                brand: pickCorner(td.rear_left?.brand, td.rear_right?.brand),
                model: pickCorner(td.rear_left?.model, td.rear_right?.model),
              }
            : null,
        }
      : null;

    return {
      vehicleLabel,
      serviceName: service?.name ?? "",
      serviceSlug: service?.slug ?? "",
      engineCode: engine.engine_code,
      engineId: engine._id,
      serviceId,
      mechanicName,
      suggestedParts: scopedSuggestedParts,
      oemRecommendations,
      vehicleConfigId: vehicle.vehicle_config_id ?? null,
      priorOpenRecommendations,
      confirmedThisVisit,
      suggestedFromInspection,
      prejobTires,
    };
  },
});

export const startJob = mutation({
  args: {
    bookingId: v.id("bookings"),
    mechanicId: v.id("mechanics"),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);
    if (!["vehicle_at_shop", "in_progress"].includes(booking.status)) {
      throw new Error("Mark the vehicle as here before starting this booking.");
    }

    // One-active-job-per-mechanic invariant. Mirrors startWithPrejob.
    if (booking.status === "vehicle_at_shop") {
      const inProgress = await ctx.db
        .query("bookings")
        .withIndex("by_shop_and_status", (q: any) =>
          q.eq("shop_id", booking.shop_id).eq("status", "in_progress"),
        )
        .collect();
      const conflict = inProgress.find(
        (b: any) =>
          b.mechanic_id &&
          String(b.mechanic_id) === String(args.mechanicId) &&
          String(b._id) !== String(args.bookingId),
      );
      if (conflict) {
        throw new Error(`MECHANIC_HAS_ACTIVE_JOB:${String(conflict._id)}`);
      }
    }

    const now = Date.now();
    await ensureJobActualRecord(ctx, {
      booking,
      mechanicId: args.mechanicId,
      now,
      startedAtMs: now,
    });

    if (booking.status === "vehicle_at_shop") {
      await applyBookingStatusTransition(ctx, {
        booking,
        newStatus: "in_progress",
        changedBy: user._id,
        reason: "started_by_shop",
      });
    }

    return await getLatestJobActualForBooking(ctx, args.bookingId);
  },
});

export const completeJob = mutation({
  args: {
    bookingId: v.id("bookings"),
    finalizeActuals: v.optional(v.boolean()),
    actuals: v.optional(jobActualInputValidator),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    const now = Date.now();
    await saveJobActualDraft(ctx, {
      booking,
      actuals: args.actuals,
      now,
      completedAtMs: now,
      preferAutoLaborMinutes: true,
      actorUserId: user._id,
    });

    if (booking.status !== "completed") {
      await applyBookingStatusTransition(ctx, {
        booking,
        newStatus: "completed",
        changedBy: user._id,
        reason: "completed_by_shop",
      });
    }

    const completedBooking = await ctx.db.get(args.bookingId);
    if (!completedBooking) throw new Error("Booking not found");

    if (args.finalizeActuals) {
      await finalizeJobActuals(ctx, {
        booking: completedBooking,
        userId: user._id,
        actuals: args.actuals,
        now,
      });
    }

    return await getLatestJobActualForBooking(ctx, args.bookingId);
  },
});

export const saveDraft = mutation({
  args: {
    bookingId: v.id("bookings"),
    actuals: jobActualInputValidator,
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    return await saveJobActualDraft(ctx, {
      booking,
      actuals: args.actuals,
      now: Date.now(),
      preferAutoLaborMinutes: booking.status === "completed",
      actorUserId: user._id,
    });
  },
});

export const finalizeByBooking = mutation({
  args: {
    bookingId: v.id("bookings"),
    actuals: v.optional(jobActualInputValidator),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    if (booking.status !== "completed") {
      throw new Error("Booking must be completed before finalizing actuals.");
    }

    return await finalizeJobActuals(ctx, {
      booking,
      userId: user._id,
      actuals: args.actuals,
      now: Date.now(),
    });
  },
});

export const reopenByBooking = mutation({
  args: {
    bookingId: v.id("bookings"),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    if (booking.status !== "completed") {
      throw new Error("Only completed bookings can reopen actuals.");
    }

    return await reopenJobActuals(ctx, {
      booking,
      now: Date.now(),
    });
  },
});

export const submitJobActuals = mutation({
  args: {
    bookingId: v.id("bookings"),
    parts_used: v.array(jobActualPartValidator),
    actual_parts_cost: v.float64(),
    difficulty_rating: v.float64(),
    technician_notes: v.string(),
    actual_labor_minutes: v.optional(v.union(v.float64(), v.null())),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");

    await requireShopStaff(ctx, user._id, booking.shop_id);

    const now = Date.now();
    await saveJobActualDraft(ctx, {
      booking,
      actuals: {
        actual_labor_minutes: args.actual_labor_minutes,
        actual_parts_cost: args.actual_parts_cost,
        difficulty_rating: args.difficulty_rating,
        technician_notes: args.technician_notes,
        parts_used: args.parts_used,
      },
      now,
      completedAtMs: booking.status === "completed" ? undefined : now,
      preferAutoLaborMinutes: true,
      actorUserId: user._id,
    });

    if (booking.status !== "completed") {
      await applyBookingStatusTransition(ctx, {
        booking,
        newStatus: "completed",
        changedBy: user._id,
        reason: "completed_by_shop",
      });
    }

    const completedBooking = await ctx.db.get(args.bookingId);
    if (!completedBooking) throw new Error("Booking not found");

    const result = await finalizeJobActuals(ctx, {
      booking: completedBooking,
      userId: user._id,
      actuals: {
        actual_labor_minutes: args.actual_labor_minutes,
        actual_parts_cost: args.actual_parts_cost,
        difficulty_rating: args.difficulty_rating,
        technician_notes: args.technician_notes,
        parts_used: args.parts_used,
      },
      now,
    });

    // Walk-in cash invoice record (no Stripe flow) — unlocks the invoice
    // pipeline (numbering, PDF, Send Invoice card, tokenized receipt).
    await ensureWalkInCashPayment(ctx, {
      booking: completedBooking,
      partsDollars: Number(args.actual_parts_cost ?? 0),
      laborMinutes: Number(args.actual_labor_minutes ?? 0),
      now,
    });

    return result;
  },
});
