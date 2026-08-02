// =============================================================================
// Shops portal · Capacity & Scheduling — /shops/capacity (Shops spec §4.5).
// Heatmap: shops × next 14 days, cell = OPEN capacity (derived) with booked
// overlay. Availability is computed under the optimistic model (shop hours −
// bookings − blocks); `open` counts free 15-min grid windows across a shop's
// active mechanics, `booked` counts live (non-terminal) bookings. Integrity:
// the always-on double-booked check, recomputed from overlapping BOOKINGS (the
// old booked-but-available check asserted a retired invariant and is gone).
// Delay monitors DESCOPED. Read-only.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";
import { listAvailableWindowsForShopDate } from "./lib/timeSlotAvailability";
import { SLOT_GRID_MINUTES } from "./lib/schedule_overlap";

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 14;

const TERMINAL_BOOKING_STATUSES = new Set([
  "cancelled",
  "completed",
  "no_show",
  "declined",
]);

function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

// --- Authored return types (see dataOverview.ts header) -----------------------

export type HeatCell = { date: string; total: number; available: number; booked: number };
export type ShopHeatRow = { shop_id: string; shop: string; cells: HeatCell[] };
export type IntegrityIssue = {
  kind: "double_booked";
  shop: string;
  shop_id: string;
  booking_id: string | null;
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
      // One window of the shop's scheduled bookings over the whole range —
      // the booked layer + the double-booking integrity source.
      const windowBookings = await ctx.db
        .query("bookings")
        .withIndex("by_shop_and_date", (q) =>
          q.eq("shop_id", s._id).gte("scheduled_date", dates[0]).lte("scheduled_date", dates[dates.length - 1]),
        )
        .take(300);
      const liveBookings = windowBookings.filter(
        (b) => !TERMINAL_BOOKING_STATUSES.has(b.status) && b.scheduled_date && b.scheduled_time,
      );

      const cells: HeatCell[] = [];
      for (const date of dates) {
        // Derived OPEN grid windows across all active mechanics.
        const windows = await listAvailableWindowsForShopDate(ctx, {
          shopId: s._id,
          date,
          durationMinutes: SLOT_GRID_MINUTES,
        });
        const bookedForDate = liveBookings.filter((b) => b.scheduled_date === date).length;
        cells.push({
          date,
          available: windows.length,
          booked: bookedForDate,
          total: windows.length + bookedForDate,
        });
      }
      rows.push({ shop_id: String(s._id), shop: s.name, cells });

      // ── Integrity: double-booked — same mechanic, overlapping live bookings
      //    on the same day (recomputed from bookings, not is_available slots).
      const byMechDate = new Map<string, typeof liveBookings>();
      for (const b of liveBookings) {
        if (!b.mechanic_id) continue;
        const key = `${String(b.mechanic_id)}|${b.scheduled_date}`;
        const list = byMechDate.get(key) ?? [];
        list.push(b);
        byMechDate.set(key, list);
      }
      for (const [key, list] of byMechDate) {
        const [mech, date] = key.split("|");
        const sorted = [...list].sort(
          (a, b) => toMinutes(a.scheduled_time!) - toMinutes(b.scheduled_time!),
        );
        for (let i = 1; i < sorted.length; i++) {
          const prev = sorted[i - 1];
          const cur = sorted[i];
          const prevEnd = toMinutes(prev.scheduled_time!) + (prev.estimated_labor_minutes ?? 60);
          if (toMinutes(cur.scheduled_time!) < prevEnd) {
            integrity.push({
              kind: "double_booked",
              shop: s.name,
              shop_id: String(s._id),
              booking_id: String(cur._id),
              mechanic_id: mech,
              date,
              detail: `${prev.scheduled_time} (${prev.estimated_labor_minutes ?? 60}m) overlaps ${cur.scheduled_time}`,
              slot_ids: [String(prev._id), String(cur._id)],
            });
          }
        }
      }
    }

    return { rows, dates, integrity };
  },
});
