// =============================================================================
// Shops portal — Directory (/shops/all) + Shop Detail tabs 1-6 (/shops/all/:id).
// Shops Atlas §3B (Directory T2, Shop Detail T3) + §4.2.
//
// All functions are token-gated via requireDirector. Table sizes measured on
// this deployment: shops 9, mechanics 4, services 23 — .collect() is fine on
// those. time_slots and bookings are windowed via indexes (+ .take()).
// =============================================================================
import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";
import type { Doc, Id } from "./_generated/dataModel";

// ---------------------------------------------------------------------------
// Health model (shared by directory + detail header).
// Green = active + hours complete (7/7 rows) + at least one offered service.
// Amber otherwise; the failing checks are returned for the hover popover.
// ---------------------------------------------------------------------------
async function shopHealth(
  ctx: { db: any },
  shop: Doc<"shops">,
): Promise<{ health: "green" | "amber"; failingChecks: string[] }> {
  const failing: string[] = [];
  if (!shop.is_active) failing.push("Shop is inactive");

  const hours = await ctx.db
    .query("shops_hours")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
    .collect();
  if (hours.length === 0) failing.push("No hours configured");
  else if (hours.length < 7) failing.push(`Hours incomplete (${hours.length}/7 days)`);

  const shopServices = await ctx.db
    .query("shop_services")
    .withIndex("by_shop_id", (q: any) => q.eq("shop_id", shop._id))
    .collect();
  const offered = shopServices.filter((s: Doc<"shop_services">) => s.is_offered).length;
  if (offered === 0) failing.push("No services offered");

  return { health: failing.length === 0 ? "green" : "amber", failingChecks: failing };
}

// ---------------------------------------------------------------------------
// Directory — one row per shop (9 rows on this deployment).
// ---------------------------------------------------------------------------
export const directoryList = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const shops = await ctx.db.query("shops").collect();

    return Promise.all(
      shops.map(async (s) => {
        const mechanics = await ctx.db
          .query("mechanics")
          .withIndex("by_shop_id", (q) => q.eq("shop_id", s._id))
          .collect();
        const activeMechanics = mechanics.filter((m) => m.is_active !== false).length;
        const { health, failingChecks } = await shopHealth(ctx, s);
        return {
          id: s._id,
          name: s.name,
          city: s.city ?? "—",
          zip: s.zip ?? "—",
          address: s.address ?? null,
          phone: s.phone ?? null,
          email: s.email ?? null,
          hasCoords: s.lat != null && s.lng != null,
          laborRate: s.labor_rate ?? null,
          rating: s.rating ?? null,
          reviewCount: s.review_count ?? 0,
          mechanics: activeMechanics,
          isActive: !!s.is_active,
          isVerified: !!s.is_verified,
          health,
          failingChecks,
        };
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// Tab 1 — Profile (also feeds the detail header card).
// ---------------------------------------------------------------------------
export const shopProfile = query({
  args: { token: v.string(), id: v.id("shops") },
  handler: async (ctx, { token, id }) => {
    await requireDirector(ctx, token);
    const shop = await ctx.db.get(id);
    if (!shop) return null;
    const { health, failingChecks } = await shopHealth(ctx, shop);
    const mechanics = await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", id))
      .collect();
    const owner = shop.owner_user_id ? await ctx.db.get(shop.owner_user_id) : null;
    return {
      owner: owner
        ? {
            id: String(owner._id),
            name:
              [owner.first_name, owner.last_name].filter(Boolean).join(" ").trim() ||
              owner.email ||
              "Unknown",
          }
        : null,
      id: shop._id,
      name: shop.name,
      slug: shop.slug ?? null,
      address: shop.address ?? null,
      city: shop.city ?? null,
      state: shop.state ?? null,
      zip: shop.zip ?? null,
      phone: shop.phone ?? null,
      email: shop.email ?? null,
      website: shop.website ?? null,
      timezone: shop.timezone ?? null,
      lat: shop.lat ?? null,
      lng: shop.lng ?? null,
      description: shop.description ?? null,
      laborRate: shop.labor_rate ?? null,
      rating: shop.rating ?? null,
      reviewCount: shop.review_count ?? 0,
      isActive: !!shop.is_active,
      isVerified: !!shop.is_verified,
      stripeAccountId: shop.stripe_connect_account_id ?? null,
      stripeChargesEnabled: !!shop.stripe_charges_enabled,
      stripePayoutsEnabled: !!shop.stripe_payouts_enabled,
      mechanicCount: mechanics.filter((m) => m.is_active !== false).length,
      createdAt: shop._creationTime,
      health,
      failingChecks,
    };
  },
});

// ---------------------------------------------------------------------------
// Tab 2 — Hours (7-day grid from shops_hours.by_shop_id).
// ---------------------------------------------------------------------------
export const shopHours = query({
  args: { token: v.string(), id: v.id("shops") },
  handler: async (ctx, { token, id }) => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("shops_hours")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", id))
      .collect();
    return rows
      .sort((a, b) => a.day_of_week - b.day_of_week)
      .map((h) => ({
        id: h._id,
        dayOfWeek: h.day_of_week,
        dayName: h.day_name,
        openTime: h.open_time ?? null,
        closeTime: h.close_time ?? null,
        isClosed: !!h.is_closed,
      }));
  },
});

// ---------------------------------------------------------------------------
// Tab 3 — Services & Rate (shop_services joined to services; 23 services max).
// ---------------------------------------------------------------------------
export const shopServicesList = query({
  args: { token: v.string(), id: v.id("shops") },
  handler: async (ctx, { token, id }) => {
    await requireDirector(ctx, token);
    const shop = await ctx.db.get(id);
    if (!shop) return null;
    const rows = await ctx.db
      .query("shop_services")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", id))
      .collect();
    const services = await Promise.all(
      rows.map(async (r) => {
        const svc = await ctx.db.get(r.service_id);
        let categoryName: string | null = null;
        if (svc?.service_category_id) {
          const cat = await ctx.db.get(svc.service_category_id);
          categoryName = cat?.name ?? null;
        }
        return {
          id: r._id,
          serviceId: r.service_id,
          name: svc?.name ?? "(deleted service)",
          category: categoryName ?? "Uncategorized",
          isOffered: r.is_offered,
          defaultLaborHours: svc?.default_labor_hours ?? null,
        };
      }),
    );
    services.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    return { laborRate: shop.labor_rate ?? null, services };
  },
});

// Rate change — capability shops.write. Moves >±15% from the current rate
// require a co-signer name, recorded in the audit detail (§4.2 tab 3 rule).
export const setLaborRate = mutation({
  args: {
    token: v.string(),
    reason: v.string(),
    shopId: v.id("shops"),
    newRate: v.number(),
    co_sign_name: v.optional(v.string()),
  },
  handler: async (ctx, { token, reason, shopId, newRate, co_sign_name }) => {
    const actor = await requireDirector(ctx, token, "shops.write");
    if (reason.trim().length < 4) throw new Error("A reason of at least 4 characters is required.");
    if (!Number.isFinite(newRate) || newRate <= 0) throw new Error("Rate must be a positive number.");

    const shop = await ctx.db.get(shopId);
    if (!shop) throw new Error("Shop not found.");
    const current = shop.labor_rate ?? null;

    const bigMove =
      current !== null && current > 0 && Math.abs(newRate - current) / current > 0.15;
    const coSign = (co_sign_name ?? "").trim();
    if (bigMove && coSign.length === 0) {
      throw new Error(
        "This change moves the rate more than ±15% — a co-signer name is required.",
      );
    }

    await ctx.db.patch(shopId, { labor_rate: newRate });
    await logAudit(ctx, actor, {
      entity_type: "shops",
      entity_id: String(shopId),
      action: "labor_rate.change",
      detail:
        `Labor rate ${current === null ? "unset" : `$${current}/hr`} → $${newRate}/hr. ` +
        `Reason: ${reason.trim()}` +
        (bigMove ? ` | >±15% move co-signed by: ${coSign}` : ""),
    });
    return { ok: true, previousRate: current, newRate };
  },
});

// ---------------------------------------------------------------------------
// Tab 4 — Mechanics roster (mechanics.by_shop_id; 4 rows network-wide).
// ---------------------------------------------------------------------------
export const shopMechanics = query({
  args: { token: v.string(), id: v.id("shops") },
  handler: async (ctx, { token, id }) => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", id))
      .collect();
    return rows.map((m) => ({
      id: m._id,
      name: `${m.first_name} ${m.last_name}`.trim(),
      title: m.title ?? null,
      email: m.email ?? null,
      photo: m.photo ?? null,
      rating: m.rating ?? null,
      reviewCount: m.review_count ?? 0,
      isActive: m.is_active !== false,
    }));
  },
});

// ---------------------------------------------------------------------------
// Tab 5 — Calendar. One selectable week, windowed per-day via
// time_slots.by_shop_and_date (never a full-table read). Bay model: a column
// per mechanic; each slot is available (green) / booked (white) / blocked
// (amber) — blocked = block_kind set (manual / auto_day_block /
// reserved_pending), booked = not available and not a block.
// ---------------------------------------------------------------------------
export const shopCalendarWeek = query({
  args: {
    token: v.string(),
    id: v.id("shops"),
    // ISO dates (YYYY-MM-DD), the 7 days of the selected week.
    dates: v.array(v.string()),
  },
  handler: async (ctx, { token, id, dates }) => {
    await requireDirector(ctx, token);
    if (dates.length > 7) throw new Error("At most 7 dates per request.");

    const mechanics = await ctx.db
      .query("mechanics")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", id))
      .collect();

    const slots: Array<{
      id: Id<"time_slots">;
      mechanicId: Id<"mechanics">;
      date: string;
      start: string;
      end: string;
      state: "available" | "booked" | "blocked";
      note: string | null;
      title: string | null;
    }> = [];

    for (const date of dates) {
      const daySlots = await ctx.db
        .query("time_slots")
        .withIndex("by_shop_and_date", (q) => q.eq("shop_id", id).eq("date", date))
        .take(200);
      for (const s of daySlots) {
        const state: "available" | "booked" | "blocked" = s.is_available
          ? "available"
          : s.block_kind
            ? "blocked"
            : "booked";
        slots.push({
          id: s._id,
          mechanicId: s.mechanic_id,
          date: s.date,
          start: s.start_time,
          end: s.end_time,
          state,
          note: s.note ?? null,
          title: s.title ?? null,
        });
      }
    }

    return {
      mechanics: mechanics.map((m) => ({
        id: m._id,
        name: `${m.first_name} ${m.last_name}`.trim(),
        isActive: m.is_active !== false,
      })),
      slots,
    };
  },
});

// ---------------------------------------------------------------------------
// Tab 6 — Bookings (windowed: by_shop_id desc, take 50). Rows deep-link to
// /ops/bookings/:id — booking truth lives in Ops; no second detail here.
// ---------------------------------------------------------------------------
export const shopBookings = query({
  args: { token: v.string(), id: v.id("shops") },
  handler: async (ctx, { token, id }) => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", id))
      .order("desc")
      .take(50);

    return Promise.all(
      rows.map(async (b) => {
        const user = await ctx.db.get(b.user_id);
        const serviceNames = await Promise.all(
          b.service_ids.map(async (sid) => {
            const s = await ctx.db.get(sid);
            return s?.name ?? "—";
          }),
        );
        return {
          id: b._id,
          user: user
            ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || "Unknown"
            : "Unknown",
          user_id: String(b.user_id),
          services: serviceNames,
          status: b.status,
          date: b.scheduled_date ?? null,
          time: b.scheduled_time ?? null,
          total: b.total_cost ?? null,
          createdAt: b.created_at ?? b._creationTime,
        };
      }),
    );
  },
});
