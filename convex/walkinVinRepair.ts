/**
 * walkinVinRepair.ts — moving a car off its placeholder VIN (Off-Catalog Work
 * spec, §5).
 *
 * WHAT GOES WRONG WITHOUT THIS
 * A walk-in entered without a valid VIN gets a placeholder from
 * `mintPseudoVin`. The booking bills fine, and thanks to `ymmtPipeline` the car
 * can even reach a vehicle_config from year/make/model alone. But the identity
 * is fake, and the real cost shows up later:
 *
 *   - No VIN-decoded truth. Engine code and factory options come from the VIN;
 *     YMMT research is a weaker substitute that deliberately refuses to guess.
 *   - IDENTITY FORK — the expensive one. When the driver later adds the same car
 *     properly by VIN in the consumer app, they get a second `vehicles` row, a
 *     second `vehicle_owners` row, and a second service history. One physical
 *     car, two identities, and the shop's work is stranded on the placeholder.
 *
 * WHY IT'S ALL-OR-NOTHING
 * Eighteen tables key on a VIN string. Moving some and not others doesn't
 * half-fix the fork, it creates one: half the car's history under the old key
 * and half under the new. So this module moves every table that a walk-in can
 * populate in a single transaction, records the counts, and refuses outright in
 * the one case it can't handle safely.
 *
 * WHAT IT REFUSES
 * If the target VIN is already known to the system, this is not a re-key — it's
 * a MERGE of two identities that may each have owners, bookings and health
 * scores. That is the exact operation that previously produced duplicate configs
 * and orphaned rows, and it needs its own deliberate tool with a revert path,
 * not a side effect of somebody signing up. We block and report instead.
 */

import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { isRealVin, isPseudoVin, canonicalVin } from "./lib/vinIdentity";

/**
 * Every table whose rows belong to one car and are keyed on the VIN string,
 * with the index used to find them.
 *
 * Convex needs literal table names for type inference, which a loop can't give
 * us — so the list is data and the walk is dynamic (`as any`). That's the trade
 * that keeps this maintainable: a new VIN-keyed table is one line here rather
 * than a new block of copy-pasted re-key code that someone will forget.
 *
 * A prefix of a compound index is a valid range query in Convex, which is why
 * by_vin_user and by_vin_service work with only the VIN pinned.
 */
const VIN_KEYED_TABLES: Array<{
  table: string;
  field: "vin" | "vehicle_vin";
  index: string;
}> = [
  { table: "vehicles", field: "vin", index: "by_vin" },
  { table: "vehicle_owners", field: "vin", index: "by_vin" },
  { table: "bookings", field: "vin", index: "by_vin" },
  { table: "follow_ups", field: "vin", index: "by_vin" },
  { table: "job_recommendations", field: "vehicle_vin", index: "by_vehicle_vin" },
  { table: "custom_jobs", field: "vehicle_vin", index: "by_vehicle_vin" },
  { table: "vehicle_passports", field: "vin", index: "by_vin" },
  { table: "vehicle_inspections", field: "vin", index: "by_vin" },
  { table: "vehicle_documents", field: "vin", index: "by_vin" },
  { table: "vehicle_part_preferences", field: "vin", index: "by_vin_service" },
  { table: "vehicle_tiers", field: "vin", index: "by_vin_user" },
  { table: "vehicle_health_points", field: "vin", index: "by_vin_user" },
  { table: "urgency_tier_events", field: "vin", index: "by_vin" },
];

/**
 * Deliberately NOT re-keyed, and why. Written down so the next person doesn't
 * assume it was an oversight:
 *
 *   pending_service_submissions.vehicle_vin — provenance only ("first seen on
 *     this car"), not a per-car record. Nothing reads it per-vehicle.
 *   vin_queue — placeholders never enter the enrichment queue.
 *   review_queue.vin — a display label on a review row.
 *   determinism_probes — test fixture.
 *
 * part_snapshots.vin has no VIN index, but its rows hang off bookings we ARE
 * moving, so they're reached via by_booking below rather than scanned.
 */
const NOT_REKEYED = [
  "pending_service_submissions",
  "vin_queue",
  "review_queue",
  "determinism_probes",
] as const;

export type RepairPlan = {
  from_vin: string;
  to_vin: string;
  moved: Record<string, number>;
  total: number;
};

/** Count what a re-key would touch, without touching it. */
async function planRepair(
  ctx: any,
  fromVin: string,
  toVin: string,
): Promise<RepairPlan> {
  const moved: Record<string, number> = {};
  let total = 0;

  for (const spec of VIN_KEYED_TABLES) {
    const rows = await ctx.db
      .query(spec.table as any)
      .withIndex(spec.index as any, (q: any) => q.eq(spec.field, fromVin))
      .collect();
    if (rows.length > 0) {
      moved[spec.table] = rows.length;
      total += rows.length;
    }
  }

  // part_snapshots by way of the bookings above.
  const bookings = await ctx.db
    .query("bookings")
    .withIndex("by_vin", (q: any) => q.eq("vin", fromVin))
    .collect();
  let snapshots = 0;
  for (const b of bookings) {
    const rows = await ctx.db
      .query("part_snapshots")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", b._id))
      .collect();
    snapshots += rows.filter((r: any) => r.vin === fromVin).length;
  }
  if (snapshots > 0) {
    moved.part_snapshots = snapshots;
    total += snapshots;
  }

  return { from_vin: fromVin, to_vin: toVin, moved, total };
}

/** Is the target VIN already a car we know about? */
async function targetAlreadyKnown(
  ctx: any,
  toVin: string,
): Promise<{ known: boolean; where: string[] }> {
  const where: string[] = [];
  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", toVin))
    .first();
  if (vehicle) where.push("vehicles");
  const owner = await ctx.db
    .query("vehicle_owners")
    .withIndex("by_vin", (q: any) => q.eq("vin", toVin))
    .first();
  if (owner) where.push("vehicle_owners");
  const booking = await ctx.db
    .query("bookings")
    .withIndex("by_vin", (q: any) => q.eq("vin", toVin))
    .first();
  if (booking) where.push("bookings");
  return { known: where.length > 0, where };
}

/**
 * The re-key itself. Plain helper so it runs inside whichever mutation
 * authorised it — the whole point is that every table moves in one transaction.
 *
 * Returns a discriminated result rather than throwing on the blocked case: "this
 * VIN belongs to a car we already know" is an expected outcome that a caller
 * needs to render, not an error.
 */
export async function reconcileVin(
  ctx: any,
  args: {
    fromVin: string;
    toVin: string;
    trigger: string;
    actorUserId?: Id<"users">;
    now: number;
  },
): Promise<
  | { ok: true; plan: RepairPlan; batch: string }
  | { ok: false; reason: "not_pseudo" | "not_real" | "same" | "target_known"; detail?: string[] }
> {
  const fromVin = canonicalVin(args.fromVin);
  const toVin = canonicalVin(args.toVin);

  if (fromVin === toVin) return { ok: false, reason: "same" };
  // Only placeholders may be replaced. Rewriting a real VIN would be a
  // correction of decoded truth, which is a different and much more dangerous
  // operation than filling in a blank.
  if (!isPseudoVin(fromVin)) return { ok: false, reason: "not_pseudo" };
  if (!isRealVin(toVin)) return { ok: false, reason: "not_real" };

  const known = await targetAlreadyKnown(ctx, toVin);
  if (known.known) {
    return { ok: false, reason: "target_known", detail: known.where };
  }

  const plan = await planRepair(ctx, fromVin, toVin);
  const batch = `vin_repair_${fromVin}_${args.now}`;

  for (const spec of VIN_KEYED_TABLES) {
    const rows = await ctx.db
      .query(spec.table as any)
      .withIndex(spec.index as any, (q: any) => q.eq(spec.field, fromVin))
      .collect();
    for (const row of rows) {
      await ctx.db.patch(row._id, { [spec.field]: toVin } as any);
    }
  }

  const bookings = await ctx.db
    .query("bookings")
    .withIndex("by_vin", (q: any) => q.eq("vin", toVin))
    .collect();
  for (const b of bookings) {
    const snaps = await ctx.db
      .query("part_snapshots")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", b._id))
      .collect();
    for (const s of snaps) {
      if (s.vin === fromVin) await ctx.db.patch(s._id, { vin: toVin });
    }
  }

  await ctx.db.insert("vin_repair_log", {
    from_vin: fromVin,
    to_vin: toVin,
    trigger: args.trigger,
    actor_user_id: args.actorUserId,
    moved: plan.moved,
    skipped: NOT_REKEYED,
    batch,
    created_at: args.now,
  });

  // The payoff: the car finally has an identity a decoder can resolve, so run
  // the real enrichment. Scheduled rather than inline — it's an action, and the
  // re-key must commit whether or not enrichment succeeds.
  await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.runHeadless.go, {
    vin: toVin,
  });

  return { ok: true, plan, batch };
}

/** Does the caller own an active row for this VIN? */
async function ownsVin(ctx: any, userId: Id<"users">, vin: string) {
  return await ctx.db
    .query("vehicle_owners")
    .withIndex("by_vin_user", (q: any) => q.eq("vin", vin).eq("user_id", userId))
    .filter((q: any) => q.eq(q.field("status"), "active"))
    .first();
}

async function getCurrentUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", identity.subject),
    )
    .unique();
  if (!user) throw new Error("User not found");
  return user;
}

/**
 * The driver's own cars that are still on a placeholder VIN.
 *
 * Drives the prompt wherever it makes sense to ask — the post-claim screen, the
 * garage, onboarding. Kept as a query on the user rather than bolted into the
 * claim page so it works for a walk-in who signed up normally instead of
 * following their claim link.
 */
export const myVehiclesNeedingVin = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    const ownerships = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_status", (q: any) =>
        q.eq("user_id", user._id).eq("status", "active"),
      )
      .collect();

    const out: Array<{
      vin: string;
      label: string | null;
      bookings: number;
    }> = [];

    for (const o of ownerships) {
      if (!isPseudoVin(o.vin)) continue;
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q: any) => q.eq("vin", o.vin))
        .first();
      const parts = [
        (vehicle as any)?.year,
        (vehicle as any)?.metadata?.make,
        (vehicle as any)?.metadata?.model,
      ].filter(Boolean);
      const bookings = await ctx.db
        .query("bookings")
        .withIndex("by_vin", (q: any) => q.eq("vin", o.vin))
        .collect();
      out.push({
        vin: o.vin,
        label: parts.length ? parts.join(" ") : null,
        bookings: bookings.length,
      });
    }
    return out;
  },
});

/**
 * Driver-authorised repair: "this is my car, here's its VIN."
 *
 * Authorised by ownership rather than by the claim token, so it works whenever
 * the driver gets round to it — the claim link, the garage, or months later.
 */
export const submitVinForMyVehicle = mutation({
  args: { pseudoVin: v.string(), vin: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const from = canonicalVin(args.pseudoVin);

    const ownership = await ownsVin(ctx, user._id, from);
    if (!ownership) throw new Error("Not authorized for this vehicle");

    const result = await reconcileVin(ctx, {
      fromVin: from,
      toVin: args.vin,
      trigger: "claim",
      actorUserId: user._id,
      now: Date.now(),
    });

    if (!result.ok) {
      // Surfaced verbatim so the UI can say something specific — especially for
      // target_known, where the right next step is support, not a retry.
      return { ok: false as const, reason: result.reason, detail: result.detail };
    }
    return { ok: true as const, moved: result.plan.moved, total: result.plan.total };
  },
});

/**
 * Shop-side repair: the mechanic is standing next to the windscreen, which is
 * the best VIN-capture moment that will ever exist for this car.
 *
 * Authorised against the booking's shop rather than vehicle ownership — the shop
 * has the car, and the walk-in customer may not have an account yet.
 */
export const submitVinForBooking = mutation({
  args: { bookingId: v.id("bookings"), vin: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");
    if (!booking.shop_id) throw new Error("Booking has no shop");

    const shopUser = await ctx.db
      .query("shop_users")
      .withIndex("by_user_and_shop", (q: any) =>
        q.eq("user_id", user._id).eq("shop_id", booking.shop_id),
      )
      .first();
    if (!shopUser?.is_active) {
      const owned = await ctx.db
        .query("shops")
        .withIndex("by_owner_user_id", (q: any) =>
          q.eq("owner_user_id", user._id),
        )
        .filter((q: any) => q.eq(q.field("_id"), booking.shop_id))
        .first();
      if (!owned) throw new Error("Not authorized for this shop");
    }

    const result = await reconcileVin(ctx, {
      fromVin: booking.vin,
      toVin: args.vin,
      trigger: "mechanic",
      actorUserId: user._id,
      now: Date.now(),
    });

    if (!result.ok) {
      return { ok: false as const, reason: result.reason, detail: result.detail };
    }
    return { ok: true as const, moved: result.plan.moved, total: result.plan.total };
  },
});

/**
 * Is this booking's car still on a placeholder? Self-contained so the prompt
 * component doesn't depend on whatever shape the surrounding panel's job object
 * happens to have.
 */
export const bookingNeedsVin = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return { needsVin: false as const };
    if (!isPseudoVin(booking.vin)) return { needsVin: false as const };
    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
      .first();
    const parts = [
      (vehicle as any)?.year,
      (vehicle as any)?.metadata?.make,
      (vehicle as any)?.metadata?.model,
    ].filter(Boolean);
    return {
      needsVin: true as const,
      pseudoVin: booking.vin,
      label: parts.length ? parts.join(" ") : null,
    };
  },
});

/**
 * Dry run. Lets an operator see the blast radius — and the blocked case — before
 * anything moves.
 */
export const previewRepair = query({
  args: { pseudoVin: v.string(), vin: v.string() },
  handler: async (ctx, args) => {
    const from = canonicalVin(args.pseudoVin);
    const to = canonicalVin(args.vin);
    if (!isPseudoVin(from)) return { ok: false as const, reason: "not_pseudo" };
    if (!isRealVin(to)) return { ok: false as const, reason: "not_real" };
    const known = await targetAlreadyKnown(ctx, to);
    if (known.known) {
      return { ok: false as const, reason: "target_known", detail: known.where };
    }
    const plan = await planRepair(ctx, from, to);
    return { ok: true as const, ...plan, skipped: NOT_REKEYED };
  },
});

/** Escape hatch for scripted/admin repairs. Same helper, no user auth. */
export const reconcileVinInternal = internalMutation({
  args: { pseudoVin: v.string(), vin: v.string(), trigger: v.optional(v.string()) },
  handler: async (ctx, args) =>
    await reconcileVin(ctx, {
      fromVin: args.pseudoVin,
      toVin: args.vin,
      trigger: args.trigger ?? "director",
      now: Date.now(),
    }),
});
