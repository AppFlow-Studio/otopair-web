/**
 * jobRecommendations.ts — Structured post-job recommendations.
 *
 * Replaces the free-text `additional_observations` capture with per-row
 * lifecycle records. Created from the post-job survey; confirmed/dismissed
 * from the next pre-job survey for the same VIN; auto-expired after 12mo.
 *
 * Driver-side wiring (this file owns):
 *   1. follow_ups   — schedules a reminder per visible+canonical rec.
 *   2. VHS penalty  — writes vehicle_owners.health_score_rec_penalty.
 *   3. Recs feed    — getDriverVisibleRecsForVehicle for the consumer app.
 *
 * The maintenance pipeline that owns the algorithmic health score is left
 * untouched. We layer rec impact on a separate field so changes are
 * cheap (no full pipeline rerun) and reversible.
 */

import { v } from "convex/values";
import {
  query,
  mutation,
  internalMutation,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { jobRecommendationInputValidator } from "./lib/vehicle_passports";
// One ledger for catalog gaps, shared with the custom-job path: a name typed as
// work-performed and the same name typed as a recommendation are the same signal,
// and counting them separately would understate every cluster.
import { bumpPendingServiceSubmission } from "./customJobs";
import { ensureJobActualRecord } from "./lib/job_actuals";

const DAY_MS = 24 * 60 * 60 * 1000;

// Days until each urgency tier fires a driver reminder. `next_visit` stays
// null — those land at the next pre-job survey, not as a push.
const URGENCY_SCHEDULE_DAYS: Record<string, number | null> = {
  next_visit: null,
  within_3_months: 60,
  soon: 90,
};

// Raw penalty per open rec (subtracted from health_score on read).
// Ramped over 30 days from created_at so the score never drops suddenly.
const URGENCY_PENALTY: Record<string, number> = {
  next_visit: 5,
  within_3_months: 2,
  soon: 1,
};
const PENALTY_RAMP_DAYS = 30;
const PENALTY_CAP = 25;

/**
 * ADVISORIES (Off-Catalog Work spec, §6).
 *
 * A recommendation with no `recommended_service_id` is an *advisory*: the
 * mechanic's professional opinion about work Otopair doesn't model, price or
 * book. Until now these were written but never delivered — both driver queries
 * filtered on `recommended_service_id`, so a mechanic could tick "visible to
 * driver" and nothing whatsoever happened. The mechanic believed they'd told
 * the customer; the customer never heard it.
 *
 * Advisories now reach the driver, with three differences from a canonical rec:
 *   - not bookable (`bookable: false`) — we can't quote what we don't model,
 *     and a disabled Book button reads as a bug
 *   - no health-score effect, guaranteed upstream in `penalize`
 *   - they never auto-expire; they AGE instead (see ADVISORY_AGE_MS), dropping
 *     into a collapsed group rather than being deleted. "Your intake valves are
 *     coked" doesn't stop being true because a year passed, and silently
 *     deleting a mechanic's advice is the same failure as never delivering it.
 */
const ADVISORY_AGE_MS = 365 * DAY_MS;

/** A rec is an advisory when it names work outside the canonical catalog. */
function isAdvisory(rec: { recommended_service_id?: unknown }): boolean {
  return !rec.recommended_service_id;
}

/** One line of framing, kept identical everywhere it's shown so the driver
 *  reads the same sentence on the card, in the reminder and in history. */
export const ADVISORY_DISCLAIMER =
  "Otopair doesn't price or book this service yet — this is the shop's recommendation, not an Otopair estimate.";

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

async function requireShopStaff(ctx: any, userId: any, shopId: any) {
  const shopUser = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", userId).eq("shop_id", shopId),
    )
    .first();
  if (shopUser?.is_active) return shopUser;

  const owned = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .filter((q: any) => q.eq(q.field("_id"), shopId))
    .first();
  if (owned) return { user_id: userId, shop_id: shopId, role: "owner" };

  throw new Error("Not authorized for this shop");
}

/**
 * Look up the active vehicle_owners row for a VIN. Returns null when the
 * vehicle isn't on any driver account (walk-in / mechanic-only) — in which
 * case driver-side wiring is a silent no-op.
 */
async function resolveVehicleOwner(ctx: any, vin: string) {
  const row = await ctx.db
    .query("vehicle_owners")
    .withIndex("by_vin", (q: any) => q.eq("vin", vin))
    .filter((q: any) => q.eq(q.field("status"), "active"))
    .first();
  return row ?? null;
}

/**
 * Recompute the open-recs penalty for a single vehicle. Cheap to call on
 * every rec mutation because we only scan recs for one VIN.
 *
 * Penalty = sum over open+visible+canonical recs of:
 *   URGENCY_PENALTY[urgency] * min(1, (now - created_at) / 30d)
 *
 * Then clamped at PENALTY_CAP. The 30-day ramp delivers the "no sudden
 * score drops" guarantee from the spec.
 */
export async function recomputeRecPenaltyForVehicle(
  ctx: any,
  args: { vin: string; now: number },
) {
  const owner = await resolveVehicleOwner(ctx, args.vin);
  if (!owner) return;

  const open = await ctx.db
    .query("job_recommendations")
    .withIndex("by_vehicle_and_status", (q: any) =>
      q.eq("vehicle_vin", args.vin).eq("status", "open"),
    )
    .collect();

  // Driver-dismissed-as-hidden recs also count toward the penalty so the
  // health score keeps reflecting unaddressed work after the card is hidden
  // from the tracker. We pull them in a second scan to avoid widening the
  // status index.
  const hidden = await ctx.db
    .query("job_recommendations")
    .withIndex("by_vehicle_and_status", (q: any) =>
      q.eq("vehicle_vin", args.vin).eq("status", "dismissed"),
    )
    .collect();

  let total = 0;
  const penalize = (rec: any) => {
    if (!rec.visible_to_driver) return;
    // ─── CUSTOM JOB INVARIANT — ENFORCEMENT SITE 2 OF 2 ────────────────────
    // No canonical service → no penalty, ever. A freeform ("advisory")
    // recommendation is the mechanic's professional opinion about work Otopair
    // doesn't model; penalising the driver's health score for not doing it
    // would be scoring them against a standard we can't define, quote or book.
    //
    // Do NOT relax this to `if (!rec.recommended_service_id && !rec.freeform_text)`
    // or similar. Advisories surface to the driver through the advisory card
    // (jobRecommendations.getDriverVisibleRecsForVehicle) and through reminders
    // — never through the score.
    // Guarded by tests/customJobHealthIsolation.test.ts.
    if (!rec.recommended_service_id) return;
    const raw = URGENCY_PENALTY[rec.urgency] ?? 0;
    const ageDays = Math.max(0, (args.now - rec.created_at) / DAY_MS);
    const ramp = Math.min(1, ageDays / PENALTY_RAMP_DAYS);
    total += raw * ramp;
  };
  for (const rec of open) penalize(rec);
  for (const rec of hidden) {
    if (rec.dismissed_reason === "hidden_by_driver") penalize(rec);
  }
  const clamped = Math.min(PENALTY_CAP, Math.round(total * 10) / 10);

  await ctx.db.patch(owner._id, {
    health_score_rec_penalty: clamped,
    health_score_rec_penalty_updated_at: args.now,
  });
}

/**
 * Atomically schedule a driver reminder for a recommendation. Idempotent
 * per (vin, service_id) — if an algorithm-generated follow-up already
 * exists for the same service, we mark it superseded so the driver doesn't
 * get two pings about the same job.
 *
 * Skips entirely when:
 *   - urgency is next_visit (no driver-facing reminder)
 *   - the vehicle has no driver account (no user_id to address)
 *
 * Returns the new follow_up id, or null if skipped.
 */
async function createFollowUpForRecommendation(
  ctx: any,
  args: {
    recommendationId: Id<"job_recommendations">;
    booking: { _id: Id<"bookings">; vin: string; shop_id?: Id<"shops"> };
    /** Absent on advisories — the work has no canonical service. */
    serviceId?: Id<"services">;
    /** The mechanic's typed name, used for the advisory reminder copy. */
    freeformName?: string;
    urgency: string;
    now: number;
  },
): Promise<Id<"follow_ups"> | null> {
  const days = URGENCY_SCHEDULE_DAYS[args.urgency];
  if (days == null) return null;

  const owner = await resolveVehicleOwner(ctx, args.booking.vin);
  if (!owner) return null;

  // Supersede any pending algorithm-generated follow-up for the same service.
  // Algorithm rows have recommendation_id === undefined; we filter in
  // memory rather than maintaining a compound index for a rare scan.
  //
  // Advisories skip this entirely: with no canonical service there is nothing
  // the maintenance algorithm could have scheduled that this would replace.
  if (args.serviceId) {
    const sameService = await ctx.db
      .query("follow_ups")
      .withIndex("by_vin_and_service", (q: any) =>
        q.eq("vin", args.booking.vin).eq("service_id", args.serviceId),
      )
      .collect();
    for (const f of sameService) {
      if (f.status !== "pending") continue;
      if (f.recommendation_id != null) continue;
      await ctx.db.patch(f._id, {
        status: "dismissed",
        dismissed_reason: "superseded_by_mechanic_rec",
      });
    }
  }

  // Templated message — best-effort lookup; falls back to a generic message
  // if any of the joins miss (e.g., shop hidden).
  const shop = args.booking.shop_id ? await ctx.db.get(args.booking.shop_id) : null;
  const service = args.serviceId ? await ctx.db.get(args.serviceId) : null;
  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", args.booking.vin))
    .unique();
  const shopName = shop?.name ?? "Your shop";
  const serviceName =
    service?.name ?? args.freeformName ?? "a follow-up service";
  const vehicleLabel = vehicle?.year ? `${vehicle.year} vehicle` : "vehicle";
  // The advisory reminder carries the same framing as the card. A driver who
  // only ever sees the notification must still learn that this is the shop's
  // recommendation and not something they can book here.
  const message = args.serviceId
    ? `${shopName} recommended ${serviceName} for your ${vehicleLabel}`
    : `${shopName} suggested ${serviceName} for your ${vehicleLabel}. ${ADVISORY_DISCLAIMER}`;

  const id = await ctx.db.insert("follow_ups", {
    user_id: owner.user_id,
    vin: args.booking.vin,
    booking_id: args.booking._id,
    service_id: args.serviceId,
    follow_up_type: "maintenance_due",
    scheduled_for: args.now + days * DAY_MS,
    status: "pending",
    message,
    created_at: args.now,
    recommendation_id: args.recommendationId,
  });
  return id;
}

/**
 * Called from within completeWithPostjob (same transaction) to persist
 * a batch of recommendations against the freshly-created job_actual.
 * Auth is already enforced by the calling mutation.
 *
 * For each rec we also (best-effort):
 *   - dedupe across shops: if a different shop already has an open rec
 *     for the same {vin, service_id}, this one lands as `acknowledged`
 *     without a new follow-up.
 *   - schedule a driver reminder (createFollowUpForRecommendation).
 *
 * Finally, recompute the vehicle's penalty once after the batch.
 */
export async function submitRecommendationsForBooking(
  ctx: any,
  args: {
    booking: {
      _id: Id<"bookings">;
      shop_id?: Id<"shops">;
      mechanic_id?: Id<"mechanics">;
      vin: string;
    };
    jobActualId: Id<"job_actuals">;
    mechanicId: Id<"mechanics">;
    // Provenance for the whole batch. Defaults to "post_job" when omitted.
    source?: string;
    // Denormalized attribution stored on each rec (e.g. inspection author line).
    authorLabel?: string;
    recommendations: Array<{
      recommended_service_id?: Id<"services"> | null;
      freeform_service_name?: string | null;
      urgency: "next_visit" | "within_3_months" | "soon";
      reason?: string | null;
      visible_to_driver: boolean;
      target_mileage?: number | null;
      scheduled_at?: number | null;
      scheduled_mechanic_id?: Id<"mechanics"> | null;
      selected_service_option?: {
        option_id: Id<"service_options">;
        option_label: string;
        option_type?: string;
      } | null;
      tire_specs?: {
        size: string;
        type: string;
        tier: string;
        quantity: number;
      } | null;
    }>;
    now: number;
  },
) {
  const { booking, jobActualId, mechanicId, recommendations, now } = args;
  const source = args.source ?? "post_job";
  const authorLabel = args.authorLabel;
  if (!booking.shop_id) {
    throw new Error("Cannot record recommendations before a shop is assigned.");
  }
  if (recommendations.length === 0) return [];

  const insertedIds: Id<"job_recommendations">[] = [];
  for (const rec of recommendations) {
    const hasService = !!rec.recommended_service_id;
    const freeform = (rec.freeform_service_name ?? "").trim();
    if (!hasService && freeform.length === 0) continue;

    let pendingId: Id<"pending_service_submissions"> | undefined;
    let freeformText: string | undefined;
    if (!hasService) {
      pendingId = await bumpPendingServiceSubmission(ctx, {
        name: freeform,
        reason: rec.reason ?? null,
        mechanicId,
        bookingId: booking._id,
        vin: booking.vin,
        now,
      });
      freeformText = freeform;
    }

    // Cross-shop dedupe: if another shop already has an open rec for this
    // service on this VIN, this submission is corroboration — record it as
    // acknowledged so the timeline shows both shops agreed.
    let status: "open" | "acknowledged" = "open";
    if (hasService) {
      const existingOpen = await ctx.db
        .query("job_recommendations")
        .withIndex("by_vehicle_and_status", (q: any) =>
          q.eq("vehicle_vin", booking.vin).eq("status", "open"),
        )
        .collect();
      const dupe = existingOpen.find(
        (r: any) =>
          r.recommended_service_id &&
          String(r.recommended_service_id) ===
            String(rec.recommended_service_id),
      );
      if (dupe) status = "acknowledged";
    }

    const id = await ctx.db.insert("job_recommendations", {
      booking_id: booking._id,
      job_actual_id: jobActualId,
      shop_id: booking.shop_id,
      mechanic_id: mechanicId,
      vehicle_vin: booking.vin,
      recommended_service_id: rec.recommended_service_id ?? undefined,
      pending_service_submission_id: pendingId,
      freeform_text: freeformText,
      urgency: rec.urgency,
      reason: rec.reason?.trim() || undefined,
      visible_to_driver: rec.visible_to_driver,
      target_mileage:
        typeof rec.target_mileage === "number" && rec.target_mileage > 0
          ? rec.target_mileage
          : undefined,
      scheduled_at:
        typeof rec.scheduled_at === "number" && rec.scheduled_at > 0
          ? rec.scheduled_at
          : undefined,
      scheduled_mechanic_id: rec.scheduled_mechanic_id ?? undefined,
      selected_service_option: rec.selected_service_option ?? undefined,
      tire_specs: rec.tire_specs ?? undefined,
      source,
      author_label: authorLabel,
      status,
      acknowledged_at: status === "acknowledged" ? now : undefined,
      created_at: now,
    });
    insertedIds.push(id);

    // Driver-side wiring for any visible, fresh-open rec — canonical OR
    // advisory. This used to require `recommended_service_id`, which is why a
    // mechanic could mark freeform advice driver-visible and have it reach
    // nobody: no card, no reminder, no trace.
    if (status === "open" && rec.visible_to_driver) {
      const followUpId = await createFollowUpForRecommendation(ctx, {
        recommendationId: id,
        booking,
        serviceId: rec.recommended_service_id ?? undefined,
        freeformName: freeformText,
        urgency: rec.urgency,
        now,
      });
      if (followUpId) {
        await ctx.db.patch(id, { followup_id: followUpId });
      }
    }
  }

  // One recompute per batch instead of per-rec — cheaper and gives a
  // consistent view of the vehicle's penalty after all inserts land.
  await recomputeRecPenaltyForVehicle(ctx, { vin: booking.vin, now });

  return insertedIds;
}

/**
 * Flag something for next time, from the active-job overlay (Flag Issue spec, §4).
 *
 * Mechanically small — it's one row with `source: "mid_job"`. What makes it worth
 * building is WHEN: the post-job survey already asks for recommendations, but
 * noticing at 11am and remembering at 4pm are different accuracies. The mechanic
 * flags it while looking at the thing.
 *
 * This deliberately does NOT duplicate the survey question. The survey seeds
 * itself from these rows (see getMidJobFlaggedForBooking), so the mechanic sees
 * what they already flagged and confirms rather than being asked twice.
 *
 * Canonical service → a normal bookable recommendation. Freeform → an advisory,
 * with the attribution-led card and no price. Neither touches today's money and
 * neither can move the health score.
 */
export const flagFromActiveJob = mutation({
  args: {
    bookingId: v.id("bookings"),
    recommendedServiceId: v.optional(v.id("services")),
    freeformName: v.optional(v.string()),
    urgency: v.union(
      v.literal("next_visit"),
      v.literal("within_3_months"),
      v.literal("soon"),
    ),
    reason: v.optional(v.string()),
    visibleToDriver: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const freeform = (args.freeformName ?? "").trim();
    if (!args.recommendedServiceId && !freeform) {
      throw new Error("Pick a service or type what you found.");
    }
    if (!booking.mechanic_id) {
      throw new Error("This job has no assigned mechanic to attribute it to.");
    }

    // job_recommendations requires a job_actual, and mid-job there may not be one
    // yet — the mechanic hasn't finished. ensureJobActualRecord is the same helper
    // the start-job and completion paths use, so this doesn't invent a second
    // lifecycle for the row.
    const now = Date.now();
    const jobActual = await ensureJobActualRecord(ctx, { booking, now });

    const ids = await submitRecommendationsForBooking(ctx, {
      booking,
      jobActualId: jobActual._id,
      mechanicId: booking.mechanic_id,
      source: "mid_job",
      recommendations: [
        {
          recommended_service_id: args.recommendedServiceId ?? null,
          freeform_service_name: args.recommendedServiceId ? null : freeform,
          urgency: args.urgency,
          reason: args.reason ?? null,
          visible_to_driver: args.visibleToDriver,
        },
      ],
      now,
    });

    return { ok: true, recommendationId: ids[0] ?? null };
  },
});

/**
 * What was already flagged mid-job on this booking, so the post-job survey can
 * seed itself instead of asking again. Shop-scoped by the booking.
 */
export const getMidJobFlaggedForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return [];
    const rows = await ctx.db
      .query("job_recommendations")
      .withIndex("by_booking_id", (q) => q.eq("booking_id", args.bookingId))
      .collect();
    const midJob = rows.filter((r) => r.source === "mid_job");
    midJob.sort((a, b) => a.created_at - b.created_at);

    return await Promise.all(
      midJob.map(async (rec) => {
        const service = rec.recommended_service_id
          ? await ctx.db.get(rec.recommended_service_id)
          : null;
        return {
          _id: rec._id,
          recommended_service_id: rec.recommended_service_id ?? null,
          service_label: service?.name ?? null,
          service_slug: (service as any)?.slug ?? null,
          service_has_options: Boolean((service as any)?.has_options),
          freeform_service_name: rec.freeform_text ?? "",
          urgency: rec.urgency,
          reason: rec.reason ?? "",
          visible_to_driver: rec.visible_to_driver,
        };
      }),
    );
  },
});

/**
 * Open recommendations for a VIN — used by the pre-job survey to surface
 * "did you do this?" prompts at the start of the next visit. Shop-scoped so
 * one shop doesn't see another shop's recs for the same vehicle.
 */
export const getOpenForVehicle = query({
  args: {
    vin: v.string(),
    shopId: v.optional(v.id("shops")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("job_recommendations")
      .withIndex("by_vehicle_and_status", (q) =>
        q.eq("vehicle_vin", args.vin).eq("status", "open"),
      )
      .collect();
    const filtered = args.shopId
      ? rows.filter((r) => String(r.shop_id) === String(args.shopId))
      : rows;
    filtered.sort((a, b) => b.created_at - a.created_at);
    const limited = filtered.slice(0, args.limit ?? 10);
    return await Promise.all(
      limited.map(async (rec) => {
        const service = rec.recommended_service_id
          ? await ctx.db.get(rec.recommended_service_id)
          : null;
        return {
          _id: rec._id,
          service_name: service?.name ?? rec.freeform_text ?? "Unspecified",
          is_freeform: !rec.recommended_service_id,
          urgency: rec.urgency,
          reason: rec.reason ?? null,
          source: rec.source ?? "post_job",
          author_label: rec.author_label ?? null,
          created_at: rec.created_at,
        };
      }),
    );
  },
});

/**
 * Driver-facing query: open recs for a VIN with full provenance so the
 * iOS "Services That Need Booking" list can render "Joe at Brooklyn Auto
 * recommends…" copy and quick-book straight back through the rec.
 *
 * Only returns visible+canonical recs the driver should see. Acknowledged
 * recs are included (a second shop agreeing is still surfacing the same
 * unresolved item).
 */
export const getDriverVisibleRecsForVehicle = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const rows = (
      await ctx.db
        .query("job_recommendations")
        .withIndex("by_vehicle_vin", (q) => q.eq("vehicle_vin", args.vin))
        .collect()
    ).filter(
      (r) =>
        (r.status === "open" || r.status === "acknowledged") &&
        r.visible_to_driver &&
        // Advisories (freeform_text, no service id) belong here too — see the
        // ADVISORY block at the top of this file. Requiring
        // `recommended_service_id` is what made mechanic advice undeliverable.
        (r.recommended_service_id || r.freeform_text),
    );
    rows.sort((a, b) => b.created_at - a.created_at);

    const now = Date.now();

    return await Promise.all(
      rows.map(async (rec) => {
        const service = rec.recommended_service_id
          ? await ctx.db.get(rec.recommended_service_id)
          : null;
        const advisory = isAdvisory(rec);
        const shop = await ctx.db.get(rec.shop_id);
        const mechanic = await ctx.db.get(rec.mechanic_id);
        const mechanicName = mechanic
          ? `${mechanic.first_name ?? ""} ${mechanic.last_name ?? ""}`.trim()
          : null;
        const scheduledMechanic = rec.scheduled_mechanic_id
          ? await ctx.db.get(rec.scheduled_mechanic_id)
          : null;
        const scheduledMechanicName = scheduledMechanic
          ? `${scheduledMechanic.first_name ?? ""} ${scheduledMechanic.last_name ?? ""}`.trim()
          : null;
        return {
          _id: rec._id,
          // "canonical" renders the normal bookable card; "advisory" renders
          // the attribution-led card with no price and no Book button.
          kind: (advisory ? "advisory" : "canonical") as
            | "advisory"
            | "canonical",
          bookable: !advisory,
          disclaimer: advisory ? ADVISORY_DISCLAIMER : null,
          // Advisories never expire, so the client collapses aged ones into a
          // secondary group instead of showing them at full weight forever.
          aged: advisory && now - rec.created_at > ADVISORY_AGE_MS,
          service_id: rec.recommended_service_id ?? null,
          service_name:
            service?.name ?? rec.freeform_text ?? "Unspecified",
          urgency: rec.urgency,
          reason: rec.reason ?? null,
          shop_id: rec.shop_id,
          shop_name: shop?.name ?? null,
          mechanic_id: rec.mechanic_id,
          mechanic_name: mechanicName,
          created_at: rec.created_at,
          target_mileage: rec.target_mileage ?? null,
          scheduled_at: rec.scheduled_at ?? null,
          scheduled_mechanic_id: rec.scheduled_mechanic_id ?? null,
          scheduled_mechanic_name: scheduledMechanicName,
          selected_service_option: rec.selected_service_option ?? null,
          tire_specs: rec.tire_specs ?? null,
          source: rec.source ?? "post_job",
          // Attribution line — falls back to a sensible default for legacy rows.
          // On an advisory the attribution IS the headline — this is one
          // person's professional opinion, not an Otopair position, and naming
          // them is what makes that legible. Lead with the mechanic when we
          // know who it was, and prefer that over any stored label.
          author_label: advisory
            ? mechanicName && shop?.name
              ? `${mechanicName} at ${shop.name} suggests`
              : shop?.name
                ? `${shop.name} suggests`
                : "Your mechanic suggests"
            : (rec.author_label ??
              (rec.source === "inspection"
                ? `Based on last inspection @ ${shop?.name ?? "the shop"}`
                : shop?.name
                  ? `Recommended by ${shop.name}`
                  : null)),
          provenance: {
            kind: (rec.source === "inspection" ? "inspection" : "mechanic") as
              | "inspection"
              | "mechanic",
            shop_id: rec.shop_id,
            mechanic_id: rec.mechanic_id,
          },
          source_recommendation_id: rec._id,
        };
      }),
    );
  },
});

/**
 * History view: every rec for a VIN regardless of lifecycle state. Drives
 * the "Bookings → Recommended services" screen so drivers can see what was
 * hidden, what was resolved (with the booking that closed it), and what
 * expired. Same field-resolution shape as `getDriverVisibleRecsForVehicle`
 * plus lifecycle fields (status, dismissed_reason, completed_via_booking_id,
 * updated_at).
 */
export const getRecHistoryForVehicle = query({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const rows = (
      await ctx.db
        .query("job_recommendations")
        .withIndex("by_vehicle_vin", (q) => q.eq("vehicle_vin", args.vin))
        .collect()
    ).filter(
      (r) => r.visible_to_driver && (r.recommended_service_id || r.freeform_text),
    );
    rows.sort(
      (a, b) => (b.updated_at ?? b.created_at) - (a.updated_at ?? a.created_at),
    );

    return await Promise.all(
      rows.map(async (rec) => {
        const service = rec.recommended_service_id
          ? await ctx.db.get(rec.recommended_service_id)
          : null;
        const shop = await ctx.db.get(rec.shop_id);
        const mechanic = await ctx.db.get(rec.mechanic_id);
        const mechanicName = mechanic
          ? `${mechanic.first_name ?? ""} ${mechanic.last_name ?? ""}`.trim()
          : null;
        const scheduledMechanic = rec.scheduled_mechanic_id
          ? await ctx.db.get(rec.scheduled_mechanic_id)
          : null;
        const scheduledMechanicName = scheduledMechanic
          ? `${scheduledMechanic.first_name ?? ""} ${scheduledMechanic.last_name ?? ""}`.trim()
          : null;
        let resolvedAt: number | null = null;
        if (rec.completed_via_booking_id) {
          const booking = await ctx.db.get(rec.completed_via_booking_id);
          resolvedAt = booking?._creationTime ?? null;
        }
        const advisory = isAdvisory(rec);
        return {
          _id: rec._id,
          kind: (advisory ? "advisory" : "canonical") as
            | "advisory"
            | "canonical",
          bookable: !advisory,
          disclaimer: advisory ? ADVISORY_DISCLAIMER : null,
          service_id: rec.recommended_service_id ?? null,
          service_name: service?.name ?? rec.freeform_text ?? "Unspecified",
          urgency: rec.urgency,
          reason: rec.reason ?? null,
          shop_id: rec.shop_id,
          shop_name: shop?.name ?? null,
          mechanic_id: rec.mechanic_id,
          mechanic_name: mechanicName,
          source: rec.source ?? "post_job",
          author_label: advisory
            ? mechanicName && shop?.name
              ? `${mechanicName} at ${shop.name} suggests`
              : shop?.name
                ? `${shop.name} suggests`
                : "Your mechanic suggests"
            : (rec.author_label ??
              (rec.source === "inspection"
                ? `Based on last inspection @ ${shop?.name ?? "the shop"}`
                : shop?.name
                  ? `Recommended by ${shop.name}`
                  : null)),
          created_at: rec.created_at,
          updated_at: rec.updated_at ?? rec.created_at,
          status: rec.status,
          dismissed_reason: rec.dismissed_reason ?? null,
          completed_via_booking_id: rec.completed_via_booking_id ?? null,
          resolved_at: resolvedAt,
          acknowledged_at: rec.acknowledged_at ?? null,
          scheduled_at: rec.scheduled_at ?? null,
          scheduled_mechanic_name: scheduledMechanicName,
        };
      }),
    );
  },
});

/**
 * Mark an open rec as completed or dismissed from the pre-job survey.
 * Batched on Continue, not per-tap, to avoid mid-dialog network churn.
 *
 * Side effects: cancel any linked follow_up; recompute the vehicle's
 * health-score penalty once at the end.
 */
export const confirmFromPreJob = mutation({
  args: {
    bookingId: v.id("bookings"),
    confirmations: v.array(
      v.object({
        recommendation_id: v.id("job_recommendations"),
        outcome: v.union(v.literal("completed"), v.literal("dismissed")),
        dismissed_reason: v.optional(
          v.union(
            v.literal("fixed"),
            v.literal("not_needed"),
            v.literal("mistake"),
          ),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const now = Date.now();
    const touchedVins = new Set<string>();
    for (const c of args.confirmations) {
      const rec = await ctx.db.get(c.recommendation_id);
      if (!rec || rec.status !== "open") continue;
      // Shop-scope guard — only the same shop can close a rec.
      if (String(rec.shop_id) !== String(booking.shop_id)) continue;
      if (c.outcome === "completed") {
        await ctx.db.patch(rec._id, {
          status: "completed",
          completed_via_booking_id: booking._id,
          updated_at: now,
        });
        await cancelLinkedFollowUp(ctx, rec.followup_id, "completed_via_booking");
      } else {
        await ctx.db.patch(rec._id, {
          status: "dismissed",
          dismissed_reason: c.dismissed_reason ?? "not_needed",
          updated_at: now,
        });
        await cancelLinkedFollowUp(ctx, rec.followup_id, "user_dismissed");
      }
      touchedVins.add(rec.vehicle_vin);
    }
    for (const vin of touchedVins) {
      await recomputeRecPenaltyForVehicle(ctx, { vin, now });
    }
    return { ok: true };
  },
});

/**
 * Driver-side: dismiss an open mechanic recommendation from the Take Action
 * detail screen. Auth-checks the caller owns the vehicle the rec was filed
 * against, then mirrors the dismiss branch of `confirmFromPreJob` (status
 * flip, follow-up cancel, penalty recompute).
 */
export const dismissRecFromDriver = mutation({
  args: {
    recommendationId: v.id("job_recommendations"),
    reason: v.optional(
      v.union(
        v.literal("fixed"),
        v.literal("not_needed"),
        v.literal("mistake"),
        v.literal("hidden_by_driver"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const rec = await ctx.db.get(args.recommendationId);
    if (!rec) throw new Error("Recommendation not found");
    if (rec.status !== "open" && rec.status !== "acknowledged") {
      return { ok: true };
    }
    const reason = args.reason ?? "hidden_by_driver";
    const now = Date.now();
    // Auth: caller must have an active ownership row for the rec's VIN.
    // Joint-ownership / multi-driver cars can have several rows per VIN, so
    // look up by (vin, user_id) directly instead of trusting whichever row
    // `resolveVehicleOwner` returned first.
    const ownership = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q: any) =>
        q.eq("vin", rec.vehicle_vin).eq("user_id", user._id),
      )
      .filter((q: any) => q.eq(q.field("status"), "active"))
      .first();
    if (!ownership) {
      throw new Error("Not authorized for this recommendation");
    }
    await ctx.db.patch(rec._id, {
      status: "dismissed",
      dismissed_reason: reason,
      updated_at: now,
    });
    // Hidden-by-driver keeps the linked follow-up alive so reminders still
    // fire; the rec only stops nagging the user when the work is actually
    // done or the user marks it fixed/not_needed/mistake.
    if (reason !== "hidden_by_driver") {
      await cancelLinkedFollowUp(ctx, rec.followup_id, "user_dismissed");
    }
    await recomputeRecPenaltyForVehicle(ctx, { vin: rec.vehicle_vin, now });
    return { ok: true };
  },
});

/**
 * Driver-side: acknowledge a mechanic-pre-picked slot from the Take Action
 * detail screen. Only valid when the rec carries `scheduled_at`. We don't
 * create a booking here — the mobile app routes into the standard booking
 * flow with `prefilledScheduledAt` set so the date picker can confirm.
 */
export const confirmScheduledDateFromDriver = mutation({
  args: { recommendationId: v.id("job_recommendations") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const rec = await ctx.db.get(args.recommendationId);
    if (!rec) throw new Error("Recommendation not found");
    if (typeof rec.scheduled_at !== "number") {
      throw new Error("Recommendation has no scheduled date");
    }
    const ownership = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q: any) =>
        q.eq("vin", rec.vehicle_vin).eq("user_id", user._id),
      )
      .filter((q: any) => q.eq(q.field("status"), "active"))
      .first();
    if (!ownership) {
      throw new Error("Not authorized for this recommendation");
    }
    if (rec.status === "open") {
      await ctx.db.patch(rec._id, {
        status: "acknowledged",
        acknowledged_at: Date.now(),
        updated_at: Date.now(),
      });
    }
    return { ok: true, scheduled_at: rec.scheduled_at };
  },
});

async function cancelLinkedFollowUp(
  ctx: any,
  followupId: Id<"follow_ups"> | undefined | null,
  reason: string,
) {
  if (!followupId) return;
  const row = await ctx.db.get(followupId);
  if (!row || row.status !== "pending") return;
  await ctx.db.patch(followupId, {
    status: "dismissed",
    dismissed_reason: reason,
  });
}

/**
 * Plain helper — called inline from completed-booking side effects so the
 * rec closure shares the booking-completion transaction. Idempotent: re-entry
 * is a no-op if the rec is already closed.
 */
export async function closeRecForCompletedBooking(
  ctx: any,
  args: {
    recommendationId: Id<"job_recommendations">;
    bookingId: Id<"bookings">;
  },
) {
  const rec = await ctx.db.get(args.recommendationId);
  if (!rec) return;
  if (rec.status === "completed" || rec.status === "expired") return;

  const now = Date.now();
  await ctx.db.patch(rec._id, {
    status: "completed",
    completed_via_booking_id: args.bookingId,
    updated_at: now,
  });
  await cancelLinkedFollowUp(ctx, rec.followup_id, "completed_via_booking");
  await recomputeRecPenaltyForVehicle(ctx, { vin: rec.vehicle_vin, now });
}

/**
 * Closes every open / acknowledged / driver-hidden rec for the booking's
 * vehicle whose `recommended_service_id` matches a service the booking just
 * delivered — at *any* shop. Companion to `closeRecForCompletedBooking`,
 * which only closes the originating rec by `source_recommendation_id`.
 * Idempotent.
 */
export async function closeMatchingRecsForCompletedBooking(
  ctx: any,
  args: { bookingId: Id<"bookings"> },
) {
  const booking = await ctx.db.get(args.bookingId);
  if (!booking) return;
  const serviceIds = new Set<string>(
    (booking.service_ids ?? []).map((id: any) => String(id)),
  );
  if (serviceIds.size === 0) return;

  const candidates = await ctx.db
    .query("job_recommendations")
    .withIndex("by_vehicle_vin", (q: any) => q.eq("vehicle_vin", booking.vin))
    .collect();

  const now = Date.now();
  let touched = 0;
  for (const rec of candidates) {
    if (!rec.recommended_service_id) continue;
    if (!serviceIds.has(String(rec.recommended_service_id))) continue;
    const isOpen = rec.status === "open" || rec.status === "acknowledged";
    const isHidden =
      rec.status === "dismissed" &&
      rec.dismissed_reason === "hidden_by_driver";
    if (!isOpen && !isHidden) continue;

    await ctx.db.patch(rec._id, {
      status: "completed",
      completed_via_booking_id: args.bookingId,
      updated_at: now,
    });
    await cancelLinkedFollowUp(ctx, rec.followup_id, "completed_via_booking");
    touched += 1;
  }
  if (touched > 0) {
    await recomputeRecPenaltyForVehicle(ctx, { vin: booking.vin, now });
  }
}

/**
 * Internal mutation wrapper for external callers (admin scripts, schedulers).
 */
export const markRecCompletedFromBooking = internalMutation({
  args: {
    recommendationId: v.id("job_recommendations"),
    bookingId: v.id("bookings"),
  },
  handler: async (ctx, args) => {
    await closeRecForCompletedBooking(ctx, args);
  },
});

/**
 * Plain helper — called from checkin.completeCheckin (same transaction) when
 * the driver reports they had a service done elsewhere. Dismisses any open
 * rec whose service matches one of the reported service_ids. Idempotent.
 */
export async function dismissRecsForReportedServices(
  ctx: any,
  args: { vin: string; serviceIds: Id<"services">[] },
) {
  if (args.serviceIds.length === 0) return { dismissed: 0 };
  const wanted = new Set(args.serviceIds.map((id) => String(id)));
  const open = await ctx.db
    .query("job_recommendations")
    .withIndex("by_vehicle_and_status", (q: any) =>
      q.eq("vehicle_vin", args.vin).eq("status", "open"),
    )
    .collect();
  const now = Date.now();
  let dismissed = 0;
  for (const rec of open) {
    if (!rec.recommended_service_id) continue;
    if (!wanted.has(String(rec.recommended_service_id))) continue;
    await ctx.db.patch(rec._id, {
      status: "dismissed",
      dismissed_reason: "completed_externally",
      updated_at: now,
    });
    await cancelLinkedFollowUp(ctx, rec.followup_id, "completed_externally");
    dismissed += 1;
  }
  if (dismissed > 0) {
    await recomputeRecPenaltyForVehicle(ctx, { vin: args.vin, now });
  }
  return { dismissed };
}

/**
 * Daily cron — flip any "open" recommendation older than 12 months to
 * "expired". Capped per run so a backlog doesn't blow past mutation limits.
 *
 * Recomputes the penalty once per affected VIN at the end so any pending
 * driver-visible scoring updates land in the same transaction.
 */
export const expireOlderThan12Months = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - 365 * DAY_MS;
    const open = await ctx.db
      .query("job_recommendations")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .take(500);
    let expired = 0;
    let advisoriesSpared = 0;
    const touchedVins = new Set<string>();
    for (const rec of open) {
      if (rec.created_at >= cutoff) continue;
      // Advisories never auto-expire (see the ADVISORY block at the top of this
      // file). They age out of the driver's primary list via the `aged` flag on
      // getDriverVisibleRecsForVehicle instead — visible, attributed, just no
      // longer competing for attention. Only a driver dismissal or the work
      // actually getting done closes one.
      if (isAdvisory(rec)) {
        advisoriesSpared += 1;
        continue;
      }
      await ctx.db.patch(rec._id, { status: "expired", updated_at: now });
      await cancelLinkedFollowUp(ctx, rec.followup_id, "expired");
      touchedVins.add(rec.vehicle_vin);
      expired += 1;
    }
    for (const vin of touchedVins) {
      await recomputeRecPenaltyForVehicle(ctx, { vin, now });
    }
    if (expired > 0 || advisoriesSpared > 0) {
      console.log(
        `[Cron] Expired ${expired} stale recommendation(s); spared ${advisoriesSpared} advisory(ies)`,
      );
    }
    return { expired, advisoriesSpared };
  },
});

/**
 * Daily cron — recompute the rec-penalty for every vehicle that has any
 * open visible rec. Needed because the penalty ramps over 30 days from
 * created_at; without this, the score would only update on rec mutations.
 *
 * We pull the open set, then de-dup by VIN to avoid recomputing the same
 * vehicle multiple times.
 */
export const recomputeAllRecPenalties = internalMutation({
  args: {},
  handler: async (ctx) => {
    const open = await ctx.db
      .query("job_recommendations")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .collect();
    const vins = new Set<string>();
    for (const rec of open) {
      if (!rec.visible_to_driver) continue;
      if (!rec.recommended_service_id) continue;
      vins.add(rec.vehicle_vin);
    }
    const now = Date.now();
    let touched = 0;
    for (const vin of vins) {
      await recomputeRecPenaltyForVehicle(ctx, { vin, now });
      touched += 1;
      if (touched >= 200) break; // batch cap per run
    }
    return { touched };
  },
});

// Re-export validator for callers that pass recommendation arrays through
// existing mutation arg schemas (e.g., completeWithPostjob).
export { jobRecommendationInputValidator };
