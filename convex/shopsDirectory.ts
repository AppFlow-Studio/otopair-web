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
import { listAvailableWindowsForShopDate } from "./lib/timeSlotAvailability";
import { SLOT_GRID_MINUTES } from "./lib/schedule_overlap";
import { userDisplayName } from "./lib/bookingEnrichment";

// Booking statuses that no longer occupy a bay (mirrors the availability
// engine's TERMINAL_BOOKING_STATUSES so the portal calendar agrees with what
// the booking flow actually treats as "open").
const TERMINAL_BOOKING_STATUSES = new Set([
  "cancelled",
  "completed",
  "no_show",
  "declined",
]);

/** "HH:MM" + minutes → "HH:MM" (24h, clamped to 23:59). */
function addMinutesHHMM(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = Math.min(h * 60 + (m || 0) + minutes, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Coalesce contiguous 15-min availability windows (end == next start) into a
 *  few "open HH:MM–HH:MM" ranges so the calendar shows ranges, not 32 pills. */
function coalesceWindows(
  windows: { start_time: string; end_time: string }[],
): { start: string; end: string }[] {
  const sorted = [...windows].sort((a, b) => a.start_time.localeCompare(b.start_time));
  const out: { start: string; end: string }[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && last.end === w.start_time) last.end = w.end_time;
    else out.push({ start: w.start_time, end: w.end_time });
  }
  return out;
}

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
    const activeMechanics = mechanics.filter((m) => m.is_active !== false);

    // NEW (optimistic) model: availability is DERIVED — a bay is open unless a
    // booking or a manual block occupies it, bounded by shop hours. time_slots
    // rows are now only blocks. So each cell is built from three live layers:
    //   available = coalesced free windows from the availability engine
    //   booked    = live non-terminal bookings for that mechanic/day
    //   blocked   = time_slots rows with block_kind set
    const slots: Array<{
      id: string;
      mechanicId: Id<"mechanics">;
      date: string;
      start: string;
      end: string;
      state: "available" | "booked" | "blocked";
      note: string | null;
      title: string | null;
    }> = [];

    for (const date of dates) {
      // Manual blocks (time_slots with block_kind) + live bookings for the day.
      const [dayBlocks, dayBookings] = await Promise.all([
        ctx.db
          .query("time_slots")
          .withIndex("by_shop_and_date", (q) => q.eq("shop_id", id).eq("date", date))
          .take(200),
        ctx.db
          .query("bookings")
          .withIndex("by_shop_and_date", (q) =>
            q.eq("shop_id", id).eq("scheduled_date", date),
          )
          .take(200),
      ]);

      for (const m of activeMechanics) {
        // Derived open windows (15-min grid), coalesced to ranges.
        const windows = await listAvailableWindowsForShopDate(ctx, {
          shopId: id,
          date,
          mechanicId: m._id,
          durationMinutes: SLOT_GRID_MINUTES,
        });
        for (const r of coalesceWindows(windows)) {
          slots.push({
            id: `avail:${String(m._id)}:${date}:${r.start}`,
            mechanicId: m._id,
            date,
            start: r.start,
            end: r.end,
            state: "available",
            note: null,
            title: null,
          });
        }

        // Manual blocks for this mechanic.
        for (const b of dayBlocks) {
          if (b.is_available || !b.block_kind) continue;
          if (String(b.mechanic_id) !== String(m._id)) continue;
          slots.push({
            id: String(b._id),
            mechanicId: m._id,
            date,
            start: b.start_time,
            end: b.end_time,
            state: "blocked",
            note: b.note ?? null,
            title: b.title ?? b.block_kind,
          });
        }

        // Live bookings assigned to this mechanic (non-terminal, timed).
        for (const bk of dayBookings) {
          if (TERMINAL_BOOKING_STATUSES.has(bk.status)) continue;
          if (!bk.scheduled_time) continue;
          if (String(bk.mechanic_id) !== String(m._id)) continue;
          const dur = bk.estimated_labor_minutes ?? 60;
          slots.push({
            id: `bk:${String(bk._id)}`,
            mechanicId: m._id,
            date,
            start: bk.scheduled_time,
            end: addMinutesHHMM(bk.scheduled_time, dur),
            state: "booked",
            note: bk.status,
            title: null,
          });
        }
      }
    }

    return {
      mechanics: activeMechanics.map((m) => ({
        id: m._id,
        name: `${m.first_name} ${m.last_name}`.trim(),
        isActive: true,
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

// ---------------------------------------------------------------------------
// Tab 7 — Insights. Reviews, rate-change history (audit_log), fixed-price
// overrides, and quality rates (cancellation / no-show / disputes) — the
// "how is this shop actually doing" read the profile never had.
// ---------------------------------------------------------------------------
export const shopInsights = query({
  args: { token: v.string(), id: v.id("shops") },
  handler: async (ctx, { token, id }) => {
    await requireDirector(ctx, token);

    const [reviewRows, auditRows, fixedPriceRows, bookings, disputes] = await Promise.all([
      ctx.db
        .query("reviews")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", id))
        .take(100),
      ctx.db
        .query("audit_log")
        .withIndex("by_entity", (q) => q.eq("entity_type", "shops").eq("entity_id", String(id)))
        .collect(),
      ctx.db
        .query("shop_service_fixed_prices")
        .withIndex("by_shop", (q) => q.eq("shop_id", id))
        .collect(),
      ctx.db
        .query("bookings")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", id))
        .take(500),
      ctx.db
        .query("payment_disputes")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", id))
        .take(100),
    ]);

    // Reviews (visible + hidden), reviewer + mechanic resolved.
    const userName = new Map<string, string | null>();
    const mechName = new Map<string, string | null>();
    const reviews = await Promise.all(
      reviewRows
        .sort((a, b) => (b.created_at ?? b._creationTime) - (a.created_at ?? a._creationTime))
        .slice(0, 50)
        .map(async (r) => {
          const uid = String(r.user_id);
          if (!userName.has(uid)) userName.set(uid, userDisplayName(await ctx.db.get(r.user_id)));
          let mechanic: string | null = null;
          if (r.mechanic_id) {
            const mid = String(r.mechanic_id);
            if (!mechName.has(mid)) {
              const m = await ctx.db.get(r.mechanic_id);
              const mo = m as { first_name?: string; last_name?: string } | null;
              mechName.set(mid, mo ? [mo.first_name, mo.last_name].filter(Boolean).join(" ") || null : null);
            }
            mechanic = mechName.get(mid) ?? null;
          }
          return {
            id: String(r._id),
            rating: r.rating,
            comment: r.comment ?? null,
            reviewer: userName.get(uid) ?? null,
            reviewerId: uid,
            mechanic,
            hidden: r.hidden_at != null,
            at: r.created_at ?? r._creationTime,
          };
        }),
    );

    // Rate-change history from the audit trail.
    const rateHistory = auditRows
      .filter((a) => a.action === "labor_rate.change")
      .sort((a, b) => b.created_at - a.created_at)
      .map((a) => ({ actor: a.actor, detail: a.detail ?? null, at: a.created_at }));

    // Fixed-price overrides, service names resolved.
    const svcName = new Map<string, string>();
    const fixedPrices = await Promise.all(
      fixedPriceRows.map(async (f) => {
        const sid = String(f.service_id);
        if (!svcName.has(sid)) {
          const s = await ctx.db.get(f.service_id);
          svcName.set(sid, s?.name ?? "(service)");
        }
        return {
          service: svcName.get(sid) ?? "(service)",
          tier: f.tier,
          price: f.price_cents / 100,
        };
      }),
    );

    // Quality rates.
    const total = bookings.length;
    const completed = bookings.filter((b) => b.status === "completed").length;
    const cancelled = bookings.filter((b) => b.status === "cancelled").length;
    const noShow = bookings.filter((b) => b.status === "no_show").length;

    return {
      reviews,
      rateHistory,
      fixedPrices,
      stats: {
        total,
        completed,
        cancelled,
        noShow,
        cancelRate: total > 0 ? cancelled / total : null,
        noShowRate: total > 0 ? noShow / total : null,
        disputeCount: disputes.length,
      },
    };
  },
});
