// =============================================================================
// Shops portal · Mechanics — /shops/mechanics (+ detail) (Shops spec §4.4).
// "Mechanics are first-class" — network directory with the barber-shop moat
// column (data contributions) + per-mechanic detail: performance, reviews,
// week strip, verification stream. Read-only (activate/deactivate stays in
// Shop Detail).
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";
import {
  listAvailableWindowsForShopDate,
  listNextAvailableWindowsForShop,
} from "./lib/timeSlotAvailability";
import { SLOT_GRID_MINUTES } from "./lib/schedule_overlap";
import {
  enrichReviews,
  resolveVehicleDisplay,
  type EnrichedReview,
} from "./lib/bookingEnrichment";
import type { Doc, Id } from "./_generated/dataModel";

const DAY = 24 * 60 * 60 * 1000;

const NOTE_SNIPPET_LEN = 160;
function snippet(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > NOTE_SNIPPET_LEN ? `${t.slice(0, NOTE_SNIPPET_LEN)}…` : t;
}

const TERMINAL_BOOKING_STATUSES = new Set([
  "cancelled",
  "completed",
  "no_show",
  "declined",
]);

// --- Authored return types (see dataOverview.ts header) -----------------------

export type MechanicRow = {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  photo: string | null;
  shop: string | null;
  shop_id: string;
  active: boolean;
  rating: number | null;
  review_count: number | null;
  jobs: number;
  jobs_capped: boolean;
  contributions: number; // mechanic_verifications — the moat column
  next_slot: string | null;
};

export const directory = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<MechanicRow[]> => {
    await requireDirector(ctx, token);
    const shops = await ctx.db.query("shops").collect(); // 9 rows
    const out: MechanicRow[] = [];
    const today = new Date().toISOString().slice(0, 10);
    for (const s of shops) {
      const mechanics = await ctx.db
        .query("mechanics")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", s._id))
        .take(50);
      for (const m of mechanics) {
        const jobs = await ctx.db
          .query("job_actuals")
          .withIndex("by_mechanic_id", (q) => q.eq("mechanic_id", m._id))
          .take(101);
        const contributions = await ctx.db
          .query("mechanic_verifications")
          .withIndex("by_mechanic", (q) => q.eq("mechanic_id", m._id))
          .take(101);
        // Next available slot is DERIVED (optimistic model): shop hours minus
        // this mechanic's bookings/blocks — not a stored is_available row.
        const nextWindows = await listNextAvailableWindowsForShop(ctx, {
          shopId: s._id,
          mechanicId: m._id,
          startDate: today,
          limit: 1,
        });
        const next = nextWindows[0];
        out.push({
          id: String(m._id),
          name: [m.first_name, m.last_name].filter(Boolean).join(" "),
          title: m.title ?? null,
          email: m.email ?? null,
          photo: m.photo ?? null,
          shop: s.name,
          shop_id: String(s._id),
          active: m.is_active !== false,
          rating: m.rating ?? null,
          review_count: m.review_count ?? null,
          jobs: Math.min(jobs.length, 100),
          jobs_capped: jobs.length > 100,
          contributions: Math.min(contributions.length, 100),
          next_slot: next ? `${next.date} ${next.start_time}` : null,
        });
      }
    }
    return out.sort((a, b) => b.contributions - a.contributions || b.jobs - a.jobs);
  },
});

export type MechanicDetail = {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  photo: string | null;
  shop: string | null;
  shop_id: string;
  active: boolean;
  rating: number | null;
  review_count: number | null;
  recent_jobs: {
    id: string;
    booking_id: string;
    services: string[];
    vehicle: string | null;
    status: string | null;
    minutes: number | null; // actual labor minutes
    est_minutes: number | null; // estimated labor minutes (booking)
    parts_cost: number | null;
    parts_count: number | null;
    difficulty: number | null;
    mileage_in: number | null;
    mileage_out: number | null;
    notes: string | null; // technician_notes ?? mechanic_findings snippet
    started_at: number | null;
    completed_at: number | null;
    at: number;
  }[];
  aggregates: {
    total_jobs: number;
    avg_labor_minutes: number | null;
    total_parts_cost: number;
    avg_difficulty: number | null;
    labor_variance_pct: number | null; // avg (actual-est)/est over jobs with both
    labor_revenue: number | null; // sum of booking labor_cost
    distinct_services: number;
    distinct_customers: number;
    avg_review: number | null;
    contribution_accuracy: number | null; // avg overall_accuracy
  };
  reviews: EnrichedReview[];
  week_slots: { date: string; available: number; booked: number }[];
  contributions: {
    id: string;
    status: string | null;
    service: string | null;
    labor_hours: number | null;
    parts_correct: boolean | null;
    fields: number;
    decisions: number;
    accuracy: number | null;
    reviewer: string | null;
    at: number;
  }[];
} | null;

export const detail = query({
  args: { token: v.string(), mechanicId: v.id("mechanics") },
  handler: async (ctx, { token, mechanicId }): Promise<MechanicDetail> => {
    await requireDirector(ctx, token);
    const m = await ctx.db.get(mechanicId);
    if (!m) return null;
    const shop = await ctx.db.get(m.shop_id);

    // Broader window for utilization aggregates; first 25 shown as recent.
    const jobs = await ctx.db
      .query("job_actuals")
      .withIndex("by_mechanic_id", (q) => q.eq("mechanic_id", mechanicId))
      .order("desc")
      .take(200);

    // Resolve each DISTINCT booking behind these jobs once — the source of
    // service / vehicle / estimated-labor / customer context for both the
    // aggregates and the recent-jobs table.
    const jobBookingIds = new Set(jobs.map((j) => String(j.booking_id)));
    const bookingById = new Map<string, Doc<"bookings"> | null>();
    await Promise.all(
      [...jobBookingIds].map(async (id) => {
        bookingById.set(id, await ctx.db.get(id as Id<"bookings">));
      }),
    );

    // Distinct vin + service resolution (deduped across all jobs' bookings).
    const jobVins = new Set<string>();
    const jobSvcIds = new Set<string>();
    for (const b of bookingById.values()) {
      if (b?.vin) jobVins.add(b.vin);
      for (const s of b?.service_ids ?? []) jobSvcIds.add(String(s));
    }
    const vehByVin = new Map<string, string | null>();
    const svcNameById = new Map<string, string>();
    await Promise.all([
      ...[...jobVins].map(async (vin) => {
        vehByVin.set(vin, (await resolveVehicleDisplay(ctx, vin)).ymm);
      }),
      ...[...jobSvcIds].map(async (sid) => {
        const s = await ctx.db.get(sid as Id<"services">);
        svcNameById.set(sid, s?.name ?? "—");
      }),
    ]);

    const laborSamples = jobs
      .map((j) => j.actual_labor_minutes)
      .filter((m): m is number => m != null);
    const difficultySamples = jobs
      .map((j) => j.difficulty_rating)
      .filter((d): d is number => d != null);
    // Labor variance: mean of (actual − estimated) / estimated over jobs that
    // have both an actual labor time and an estimate on their booking.
    const variancePcts: number[] = [];
    let laborRevenue = 0;
    const customerIds = new Set<string>();
    for (const j of jobs) {
      const b = bookingById.get(String(j.booking_id));
      if (b?.user_id) customerIds.add(String(b.user_id));
      if (b?.labor_cost != null) laborRevenue += b.labor_cost;
      const est = b?.estimated_labor_minutes;
      if (j.actual_labor_minutes != null && est != null && est > 0) {
        variancePcts.push((j.actual_labor_minutes - est) / est);
      }
    }
    const aggregates = {
      total_jobs: jobs.length,
      avg_labor_minutes:
        laborSamples.length > 0
          ? Math.round(laborSamples.reduce((s, m) => s + m, 0) / laborSamples.length)
          : null,
      total_parts_cost: jobs.reduce((s, j) => s + (j.actual_parts_cost ?? 0), 0),
      avg_difficulty:
        difficultySamples.length > 0
          ? difficultySamples.reduce((s, d) => s + d, 0) / difficultySamples.length
          : null,
      labor_variance_pct:
        variancePcts.length > 0
          ? variancePcts.reduce((s, v) => s + v, 0) / variancePcts.length
          : null,
      labor_revenue: laborRevenue > 0 ? laborRevenue : null,
      distinct_services: jobSvcIds.size,
      distinct_customers: customerIds.size,
      avg_review: null as number | null, // filled after reviews resolve
      contribution_accuracy: null as number | null, // filled after verifications
    };

    const reviewRows = await ctx.db
      .query("reviews")
      .withIndex("by_mechanic_id", (q) => q.eq("mechanic_id", mechanicId))
      .take(50);
    const reviews = (await enrichReviews(ctx, reviewRows)).sort((a, b) => b.at - a.at);
    const visibleReviews = reviews.filter((r) => !r.hidden);
    aggregates.avg_review =
      visibleReviews.length > 0
        ? visibleReviews.reduce((s, r) => s + r.rating, 0) / visibleReviews.length
        : null;

    // Personal week strip: next 7 days. Availability DERIVED (optimistic
    // model) = open 15-min windows for this mechanic; booked = their live
    // non-terminal bookings that day.
    const weekSlots: { date: string; available: number; booked: number }[] = [];
    const weekDates: string[] = [];
    for (let d = 0; d < 7; d++) {
      weekDates.push(new Date(Date.now() + d * DAY).toISOString().slice(0, 10));
    }
    const weekBookings = m.shop_id
      ? await ctx.db
          .query("bookings")
          .withIndex("by_shop_and_date", (q) =>
            q
              .eq("shop_id", m.shop_id)
              .gte("scheduled_date", weekDates[0])
              .lte("scheduled_date", weekDates[weekDates.length - 1]),
          )
          .take(300)
      : [];
    for (const date of weekDates) {
      const windows = await listAvailableWindowsForShopDate(ctx, {
        shopId: m.shop_id,
        date,
        mechanicId,
        durationMinutes: SLOT_GRID_MINUTES,
      });
      const booked = weekBookings.filter(
        (b) =>
          b.scheduled_date === date &&
          String(b.mechanic_id) === String(mechanicId) &&
          !TERMINAL_BOOKING_STATUSES.has(b.status),
      ).length;
      weekSlots.push({ date, available: windows.length, booked });
    }

    const verifications = await ctx.db
      .query("mechanic_verifications")
      .withIndex("by_mechanic", (q) => q.eq("mechanic_id", mechanicId))
      .order("desc")
      .take(25);
    // Resolve service names + reviewer (director) names for the verifications.
    const verSvcIds = new Set(
      verifications.filter((v) => v.service_id).map((v) => String(v.service_id)),
    );
    const verReviewerIds = new Set(
      verifications.filter((v) => v.reviewer_id).map((v) => String(v.reviewer_id)),
    );
    const verSvcName = new Map<string, string>();
    const verReviewerName = new Map<string, string | null>();
    await Promise.all([
      ...[...verSvcIds].map(async (sid) => {
        const s = await ctx.db.get(sid as Id<"services">);
        verSvcName.set(sid, s?.name ?? "—");
      }),
      ...[...verReviewerIds].map(async (rid) => {
        const r = (await ctx.db.get(rid as Id<"director_users">)) as {
          name?: string;
        } | null;
        verReviewerName.set(rid, r?.name ?? null);
      }),
    ]);
    const accuracySamples = verifications
      .map((v) => v.overall_accuracy)
      .filter((a): a is number => a != null);
    aggregates.contribution_accuracy =
      accuracySamples.length > 0
        ? accuracySamples.reduce((s, a) => s + a, 0) / accuracySamples.length
        : null;

    return {
      id: String(m._id),
      name: [m.first_name, m.last_name].filter(Boolean).join(" "),
      title: m.title ?? null,
      email: m.email ?? null,
      photo: m.photo ?? null,
      shop: shop ? ((shop as { name?: string }).name ?? null) : null,
      shop_id: String(m.shop_id),
      active: m.is_active !== false,
      rating: m.rating ?? null,
      review_count: m.review_count ?? null,
      recent_jobs: jobs.slice(0, 25).map((j) => {
        const b = bookingById.get(String(j.booking_id));
        return {
          id: String(j._id),
          booking_id: String(j.booking_id),
          services: (b?.service_ids ?? []).map((s) => svcNameById.get(String(s)) ?? "—"),
          vehicle: b?.vin ? (vehByVin.get(b.vin) ?? null) : null,
          status: b?.status ?? null,
          minutes: j.actual_labor_minutes ?? null,
          est_minutes: b?.estimated_labor_minutes ?? null,
          parts_cost: j.actual_parts_cost ?? null,
          parts_count: Array.isArray(j.parts_used) ? j.parts_used.length : null,
          difficulty: j.difficulty_rating ?? null,
          mileage_in: j.odometer_in ?? null,
          mileage_out: j.completion_mileage ?? null,
          notes: snippet(j.technician_notes ?? j.mechanic_findings),
          started_at: j.started_at ?? null,
          completed_at: j.completed_at_ms ?? null,
          at: j.created_at ?? j._creationTime,
        };
      }),
      aggregates,
      reviews,
      week_slots: weekSlots,
      contributions: verifications.map((vr) => {
        const blob = vr.verifications as Record<string, unknown> | null | undefined;
        const decisions = vr.review_decisions as
          | Record<string, unknown>
          | null
          | undefined;
        return {
          id: String(vr._id),
          status: vr.status ?? null,
          service: vr.service_id ? (verSvcName.get(String(vr.service_id)) ?? null) : null,
          labor_hours: vr.actual_labor_hours ?? null,
          parts_correct: vr.parts_used_correct ?? null,
          fields: blob && typeof blob === "object" ? Object.keys(blob).length : 0,
          decisions:
            decisions && typeof decisions === "object" ? Object.keys(decisions).length : 0,
          accuracy: vr.overall_accuracy ?? null,
          reviewer: vr.reviewer_id
            ? (verReviewerName.get(String(vr.reviewer_id)) ?? null)
            : null,
          at: vr.verified_at ?? vr.created_at ?? vr._creationTime,
        };
      }),
    };
  },
});
