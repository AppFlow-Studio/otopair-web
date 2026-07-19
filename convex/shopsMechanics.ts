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

const DAY = 24 * 60 * 60 * 1000;

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
    minutes: number | null;
    parts_cost: number | null;
    difficulty: number | null;
    at: number;
  }[];
  aggregates: {
    total_jobs: number;
    avg_labor_minutes: number | null;
    total_parts_cost: number;
    avg_difficulty: number | null;
  };
  reviews: { rating: number; comment: string | null; hidden: boolean; at: number }[];
  week_slots: { date: string; available: number; booked: number }[];
  contributions: {
    id: string;
    status: string | null;
    fields: number;
    accuracy: number | null;
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
    const laborSamples = jobs
      .map((j) => j.actual_labor_minutes)
      .filter((m): m is number => m != null);
    const difficultySamples = jobs
      .map((j) => j.difficulty_rating)
      .filter((d): d is number => d != null);
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
    };
    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_mechanic_id", (q) => q.eq("mechanic_id", mechanicId))
      .take(50);

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
      recent_jobs: jobs.slice(0, 25).map((j) => ({
        id: String(j._id),
        booking_id: String(j.booking_id),
        minutes: j.actual_labor_minutes ?? null,
        parts_cost: j.actual_parts_cost ?? null,
        difficulty: j.difficulty_rating ?? null,
        at: j.created_at ?? j._creationTime,
      })),
      aggregates,
      reviews: reviews
        .map((r) => ({
          rating: r.rating,
          comment: r.comment ?? null,
          hidden: r.hidden_at != null,
          at: r.created_at ?? r._creationTime,
        }))
        .sort((a, b) => b.at - a.at),
      week_slots: weekSlots,
      contributions: verifications.map((vr) => {
        const blob = vr.verifications as Record<string, unknown> | null | undefined;
        return {
          id: String(vr._id),
          status: vr.status ?? null,
          fields: blob && typeof blob === "object" ? Object.keys(blob).length : 0,
          accuracy: vr.overall_accuracy ?? null,
          at: vr.verified_at ?? vr.created_at ?? vr._creationTime,
        };
      }),
    };
  },
});
