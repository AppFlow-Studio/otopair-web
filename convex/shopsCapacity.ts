// =============================================================================
// Shops portal · Capacity & Scheduling — /shops/capacity (Shops spec §4.5).
// Heatmap: shops × next 14 days, cell = availability density with booked
// overlay (9 shops × 14 by_shop_and_date reads — bounded). Integrity: the
// two always-on should-be-empty checks (double-booked · booked-but-available)
// over the same window. Delay monitors DESCOPED (needs the live job state
// machine) — rendered as an honest note. Read-only; fixes stay with the shop
// calendar's own mutations.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 14;

function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

// --- Authored return types (see dataOverview.ts header) -----------------------

export type HeatCell = { date: string; total: number; available: number; booked: number };
export type ShopHeatRow = { shop_id: string; shop: string; cells: HeatCell[] };
export type IntegrityIssue = {
  kind: "double_booked" | "booked_but_available";
  shop: string;
  mechanic_id: string | null;
  date: string;
  detail: string;
  slot_ids: string[];
};
export type CapacityResult = {
  rows: ShopHeatRow[];
  dates: string[];
  integrity: IntegrityIssue[];
};

export const overview = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<CapacityResult> => {
    await requireDirector(ctx, token);
    const shops = await ctx.db.query("shops").collect(); // 9 rows
    const dates: string[] = [];
    for (let d = 0; d < WINDOW_DAYS; d++) {
      dates.push(new Date(Date.now() + d * DAY).toISOString().slice(0, 10));
    }

    const rows: ShopHeatRow[] = [];
    const integrity: IntegrityIssue[] = [];

    for (const s of shops) {
      const cells: HeatCell[] = [];
      for (const date of dates) {
        const slots = await ctx.db
          .query("time_slots")
          .withIndex("by_shop_and_date", (q) => q.eq("shop_id", s._id).eq("date", date))
          .take(200);
        cells.push({
          date,
          total: slots.length,
          available: slots.filter((sl) => sl.is_available).length,
          booked: slots.filter((sl) => !sl.is_available).length,
        });

        // ── Integrity check 1: double-booked — same mechanic, overlapping
        //    non-available (booked/blocked) slots on the same day.
        const busyByMech = new Map<string, typeof slots>();
        for (const sl of slots) {
          if (sl.is_available) continue;
          const key = String(sl.mechanic_id);
          const list = busyByMech.get(key) ?? [];
          list.push(sl);
          busyByMech.set(key, list);
        }
        for (const [mech, list] of busyByMech) {
          const sorted = [...list].sort(
            (a, b) => toMinutes(a.start_time) - toMinutes(b.start_time),
          );
          for (let i = 1; i < sorted.length; i++) {
            if (toMinutes(sorted[i].start_time) < toMinutes(sorted[i - 1].end_time)) {
              integrity.push({
                kind: "double_booked",
                shop: s.name,
                mechanic_id: mech,
                date,
                detail: `${sorted[i - 1].start_time}–${sorted[i - 1].end_time} overlaps ${sorted[i].start_time}–${sorted[i].end_time}`,
                slot_ids: [String(sorted[i - 1]._id), String(sorted[i]._id)],
              });
            }
          }
        }
      }
      rows.push({ shop_id: String(s._id), shop: s.name, cells });

      // ── Integrity check 2: booked-but-available — a scheduled booking in
      //    the window whose date still shows every slot available at its time.
      const bookings = await ctx.db
        .query("bookings")
        .withIndex("by_shop_and_date", (q) =>
          q.eq("shop_id", s._id).gte("scheduled_date", dates[0]).lte("scheduled_date", dates[dates.length - 1]),
        )
        .take(100);
      for (const b of bookings) {
        const bTime = (b as { scheduled_time?: string }).scheduled_time;
        const bDate = (b as { scheduled_date?: string }).scheduled_date;
        if (!bTime || !bDate) continue;
        if (["cancelled", "no_show", "completed"].includes(b.status)) continue;
        const daySlots = await ctx.db
          .query("time_slots")
          .withIndex("by_shop_and_date", (q) => q.eq("shop_id", s._id).eq("date", bDate))
          .take(200);
        const covering = daySlots.filter(
          (sl) =>
            toMinutes(sl.start_time) <= toMinutes(bTime) &&
            toMinutes(sl.end_time) > toMinutes(bTime),
        );
        if (covering.length > 0 && covering.every((sl) => sl.is_available)) {
          integrity.push({
            kind: "booked_but_available",
            shop: s.name,
            mechanic_id: null,
            date: bDate,
            detail: `booking ${String(b._id).slice(0, 10)}… at ${bTime} (${b.status}) — every covering slot still is_available`,
            slot_ids: covering.map((sl) => String(sl._id)),
          });
        }
      }
    }

    return { rows, dates, integrity };
  },
});
