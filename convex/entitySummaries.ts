// =============================================================================
// Entity-chip hover summaries (shared portal primitive).
//
// ONE gated query: entitySummaries.get { token, type, id }. Switches on the
// entity type and returns 3-4 cheap key facts for the hover card rendered by
// components/portal/EntityChip.tsx. Cost budget per call: one ctx.db.get plus
// AT MOST one small indexed read (user → bookings-count probe capped at 21).
// Unknown / deleted / malformed ids return null — the chip renders a lock
// tooltip instead of a dead link.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

export type EntitySummary = {
  type: "user" | "shop" | "booking" | "payment";
  id: string;
  title: string;
  status?: string;
  facts: { label: string; value: string }[];
};

function money(n: number | undefined | null): string {
  if (n == null) return "—";
  return `$${n.toFixed(2)}`;
}

function day(ms: number | undefined | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleDateString();
}

export const get = query({
  args: {
    token: v.string(),
    type: v.union(
      v.literal("user"),
      v.literal("shop"),
      v.literal("booking"),
      v.literal("payment"),
    ),
    id: v.string(),
  },
  handler: async (ctx, { token, type, id }): Promise<EntitySummary | null> => {
    await requireDirector(ctx, token);

    switch (type) {
      case "user": {
        const uid = ctx.db.normalizeId("users", id);
        if (!uid) return null;
        const u = await ctx.db.get(uid);
        if (!u) return null;
        // Cheap count probe: indexed window capped at 21 rows so a heavy
        // booker can never widen this read. 21+ renders as "20+".
        const bookings = await ctx.db
          .query("bookings")
          .withIndex("by_user_id", (q) => q.eq("user_id", uid))
          .take(21);
        const name =
          [u.first_name, u.last_name].filter(Boolean).join(" ") ||
          u.username ||
          u.email ||
          "Unnamed user";
        return {
          type,
          id,
          title: name,
          status: u.isPendingDeletion ? "pending deletion" : undefined,
          facts: [
            { label: "Email", value: u.email ?? "—" },
            {
              label: "Bookings",
              value: bookings.length > 20 ? "20+" : String(bookings.length),
            },
            { label: "Joined", value: day(u.createdAt ?? u._creationTime) },
          ],
        };
      }

      case "shop": {
        const sid = ctx.db.normalizeId("shops", id);
        if (!sid) return null;
        const s = await ctx.db.get(sid);
        if (!s) return null;
        return {
          type,
          id,
          title: s.name,
          status: s.is_active === false ? "inactive" : "active",
          facts: [
            {
              label: "City",
              value: [s.city, s.state].filter(Boolean).join(", ") || "—",
            },
            {
              label: "Rating",
              value:
                s.rating != null
                  ? `${s.rating.toFixed(1)} (${s.review_count ?? 0})`
                  : "unrated",
            },
            { label: "Phone", value: s.phone ?? "—" },
          ],
        };
      }

      case "booking": {
        const bid = ctx.db.normalizeId("bookings", id);
        if (!bid) return null;
        const b = await ctx.db.get(bid);
        if (!b) return null;
        // One extra point-get for the shop name (may be unset pre-quote).
        const shop = b.shop_id ? await ctx.db.get(b.shop_id) : null;
        return {
          type,
          id,
          title: `Booking …${id.slice(-6)}`,
          status: b.status,
          facts: [
            {
              label: "Scheduled",
              value: b.scheduled_date
                ? `${b.scheduled_date}${b.scheduled_time ? ` ${b.scheduled_time}` : ""}`
                : "unscheduled",
            },
            { label: "Total", value: money(b.total_cost) },
            { label: "Shop", value: shop?.name ?? "unassigned" },
          ],
        };
      }

      case "payment": {
        const pid = ctx.db.normalizeId("payments", id);
        if (!pid) return null;
        const p = await ctx.db.get(pid);
        if (!p) return null;
        const amount =
          p.captured_amount_cents != null
            ? p.captured_amount_cents / 100
            : p.amount;
        return {
          type,
          id,
          title: `Payment …${id.slice(-6)}`,
          status: p.status,
          facts: [
            { label: "Amount", value: money(amount) },
            { label: "Method", value: p.payment_origin ?? p.payment_method ?? "—" },
            { label: "Created", value: day(p.created_at ?? p._creationTime) },
          ],
        };
      }
    }
  },
});
