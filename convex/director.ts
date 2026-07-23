import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireDirector } from "./directorGate";
import { metaMakeModel } from "./lib/bookingEnrichment";

// All queries for the director panel. Token-gated server-side via requireDirector.

export const sidebarCounts = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const [bugs, feedback, otoFeedback, refunds, pendingVerifications, pendingDeletions, reviews, errorLogs] = await Promise.all([
      ctx.db.query("bugs").collect(),
      ctx.db.query("app_feedback").collect(),
      ctx.db.query("ai_feedback").collect(),
      ctx.db.query("bookings").withIndex("by_status", (q) => q.eq("status", "refunded")).collect(),
      ctx.db.query("mechanic_verifications").withIndex("by_status", (q) => q.eq("status", "pending")).collect(),
      // Ops surfaces folded in: deletion-queue SLA, reviews needs-eyes, client errors.
      ctx.db.query("users").withIndex("by_isPendingDeletion", (q) => q.eq("isPendingDeletion", true)).collect(),
      ctx.db.query("reviews").take(500),
      ctx.db.query("client_logs").withIndex("by_level", (q) => q.eq("level", "error")).order("desc").take(200),
    ]);
    const openBugStatuses   = new Set(["new", "triaged", "assigned", "in_progress"]);
    const openFbStatuses    = new Set(["new", "reviewed", "triaged"]);
    const openOtoFbStatuses = new Set(["new", "reviewed", "actionable"]);
    return {
      bugs:          bugs.filter((b) => openBugStatuses.has(b.status)).length,
      feedback:      feedback.filter((f) => openFbStatuses.has(f.status)).length,
      otoFeedback:   otoFeedback.filter((f) => !f.archived && openOtoFbStatuses.has(f.review_status ?? "new")).length,
      stripe:        refunds.length,
      mechanicEdits: pendingVerifications.length,
      deletionQueue: pendingDeletions.length,
      // "Needs eyes": visible low-rating reviews awaiting moderation.
      reviews:       reviews.filter((r) => r.hidden_at == null && r.rating <= 3).length,
      systemHealth:  errorLogs.filter((l) => l.timestamp >= sevenDaysAgo).length,
    };
  },
});

export const overviewCounters = query({
  args: { token: v.string(), period: v.optional(v.union(v.literal("today"), v.literal("7d"), v.literal("30d"))) },
  handler: async (ctx, { token, period = "today" }) => {
    await requireDirector(ctx, token);
    const todayStr = new Date().toISOString().split("T")[0];
    const periodMs = period === "30d" ? 30 * 24 * 60 * 60 * 1000 : period === "7d" ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const sinceStr = new Date(Date.now() - periodMs).toISOString().split("T")[0];

    const [allBookings, allShops, allUsers, allBugs, allFeedback] = await Promise.all([
      ctx.db.query("bookings").collect(),
      ctx.db.query("shops").collect(),
      ctx.db.query("users").collect(),
      ctx.db.query("bugs").collect(),
      ctx.db.query("app_feedback").collect(),
    ]);
    const activeStatuses  = new Set(["confirmed", "in_progress", "pending"]);
    const openBugStatuses = new Set(["new", "triaged", "assigned", "in_progress"]);
    const openFbStatuses  = new Set(["new", "reviewed", "triaged"]);

    const bookingsInPeriod = period === "today"
      ? allBookings.filter((b) => b.scheduled_date === todayStr).length
      : allBookings.filter((b) => !!b.scheduled_date && b.scheduled_date >= sinceStr && b.scheduled_date <= todayStr).length;

    return {
      active_bookings:        allBookings.filter((b) => activeStatuses.has(b.status)).length,
      bookings_today:         bookingsInPeriod,
      total_bookings:         allBookings.length,
      active_shops:           allShops.filter((s) => s.is_active === true).length,
      active_users:           allUsers.filter((u) => (u.createdAt ?? 0) >= Date.now() - periodMs).length,
      open_bugs:              allBugs.filter((b) => openBugStatuses.has(b.status)).length,
      unassigned_bugs:        allBugs.filter((b) => openBugStatuses.has(b.status) && !b.assignee).length,
      open_feedback:          allFeedback.filter((f) => openFbStatuses.has(f.status)).length,
      negative_feedback:      allFeedback.filter((f) => openFbStatuses.has(f.status) && f.sentiment === "negative").length,
      untagged_refunds:       allBookings.filter((b) => b.status === "refunded").length,
      pending_mechanic_edits: 0,
    };
  },
});

export const todaysBookingsList = query({
  args: { token: v.string(), period: v.optional(v.union(v.literal("today"), v.literal("7d"), v.literal("30d"))) },
  handler: async (ctx, { token, period = "today" }) => {
    await requireDirector(ctx, token);
    const todayStr = new Date().toISOString().split("T")[0];
    let bookings;
    if (period === "today") {
      bookings = await ctx.db
        .query("bookings")
        .withIndex("by_scheduled_date", (q) => q.eq("scheduled_date", todayStr))
        .order("asc")
        .take(15);
    } else {
      const days = period === "7d" ? 7 : 30;
      const sinceStr = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      const raw = await ctx.db
        .query("bookings")
        .withIndex("by_scheduled_date", (q) => q.gte("scheduled_date", sinceStr))
        .order("asc")
        .take(100);
      bookings = raw.filter((b) => b.scheduled_date && b.scheduled_date <= todayStr);
    }
    return Promise.all(bookings.map(async (b) => {
      const [user, shop] = await Promise.all([
        ctx.db.get(b.user_id),
        b.shop_id ? ctx.db.get(b.shop_id) : null,
      ]);
      const serviceNames = await Promise.all(
        b.service_ids.map(async (sid) => { const s = await ctx.db.get(sid); return s?.name ?? "—"; })
      );
      return {
        id:      b._id,
        user:    user ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || "Unknown" : "Unknown",
        shop:    shop?.name ?? "—",
        service: serviceNames.join(", ") || "—",
        time:    b.scheduled_time ?? "—",
        status:  b.status,
        total:   b.total_cost ?? 0,
      };
    }));
  },
});

export const shopsList = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const shops = await ctx.db.query("shops").collect();
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split("T")[0];
    const allBookings = await ctx.db.query("bookings").collect();

    return Promise.all(shops.map(async (s) => {
      const shopUsers = await ctx.db
        .query("shop_users")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", s._id))
        .filter((q) => q.eq(q.field("is_active"), true))
        .collect();
      const mechanicCount = shopUsers.filter((u) =>
        ["shop_mechanic", "mechanic", "shop_owner", "owner"].includes(u.role)
      ).length;
      const bookings7d = allBookings.filter(
        (b) => b.shop_id === s._id && b.scheduled_date && b.scheduled_date >= sevenDaysAgoStr
      ).length;
      return {
        id:             s._id,
        name:           s.name,
        city:           [s.city, s.state].filter(Boolean).join(", ") || "—",
        status:         s.is_active ? "active" : "inactive",
        stripe:         !!s.stripe_charges_enabled,
        stripeAccountId: s.stripe_connect_account_id,
        stripePayoutsEnabled: !!s.stripe_payouts_enabled,
        mechanics:      mechanicCount,
        bookings7d,
        rating:         s.rating,
        reviewCount:    s.review_count,
        address:        s.address,
        phone:          s.phone,
        email:          s.email,
        website:        s.website,
        isVerified:     s.is_verified,
        laborRate:      s.labor_rate,
      };
    }));
  },
});

export const shopDetail = query({
  args: { token: v.string(), id: v.id("shops") },
  handler: async (ctx, { token, id }) => {
    await requireDirector(ctx, token);
    const shop = await ctx.db.get(id);
    if (!shop) return null;

    const shopUsers = await ctx.db
      .query("shop_users")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", id))
      .filter((q) => q.eq(q.field("is_active"), true))
      .collect();

    const members = await Promise.all(shopUsers.map(async (su) => {
      const user = await ctx.db.get(su.user_id);
      return {
        name: user ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || "Unknown" : "Unknown",
        role: su.role,
        email: user?.email,
      };
    }));

    // Pull more recent bookings (we'll surface 20 in detail + use the full
    // set to compute per-service stats).
    const allShopBookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", id))
      .order("desc")
      .take(500);

    const recentBookings = allShopBookings.slice(0, 20);
    const bookingsWithUser = await Promise.all(recentBookings.map(async (b) => {
      const user = await ctx.db.get(b.user_id);
      const serviceNames = await Promise.all(
        b.service_ids.map(async (sid) => { const s = await ctx.db.get(sid); return s?.name ?? "—"; })
      );
      return {
        id:        b._id,
        user:      user ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || "Unknown" : "Unknown",
        userId:    b.user_id,
        status:    b.status,
        total:     b.total_cost ?? 0,
        labor:     b.labor_cost ?? 0,
        parts:     b.parts_cost ?? 0,
        date:      b.scheduled_date ?? "—",
        time:      b.scheduled_time ?? "—",
        services:  serviceNames,
        vin:       b.vin,
        createdAt: b.created_at,
      };
    }));

    // Per-service breakdown across this shop's full history (capped 500 above).
    // For each service performed at this shop: count, total revenue, last
    // performed, average ticket. Helps directors see which services this shop
    // actually does and how much they earn from each.
    const serviceStats = new Map<string, {
      serviceId: import("./_generated/dataModel").Id<"services">;
      name: string;
      count: number;
      totalRevenue: number;
      lastPerformed?: number;
      completedCount: number;
    }>();

    for (const b of allShopBookings) {
      const ts = b.created_at ?? 0;
      const completed = b.status === "completed";
      const perBookingRevenue = (b.total_cost ?? 0) / Math.max(b.service_ids.length, 1);
      for (const sid of b.service_ids) {
        const key = String(sid);
        let row = serviceStats.get(key);
        if (!row) {
          const s = await ctx.db.get(sid);
          row = {
            serviceId: sid,
            name: s?.name ?? "—",
            count: 0,
            totalRevenue: 0,
            lastPerformed: undefined,
            completedCount: 0,
          };
          serviceStats.set(key, row);
        }
        row.count += 1;
        if (completed) {
          row.completedCount += 1;
          row.totalRevenue += perBookingRevenue;
        }
        if (!row.lastPerformed || ts > row.lastPerformed) row.lastPerformed = ts;
      }
    }
    const serviceBreakdown = Array.from(serviceStats.values()).sort((a, b) => b.count - a.count);

    // Status mix snapshot for the strip in the modal.
    const statusMix: Record<string, number> = {};
    for (const b of allShopBookings) {
      statusMix[b.status] = (statusMix[b.status] ?? 0) + 1;
    }

    const totalRevenue = allShopBookings
      .filter((b) => b.status === "completed")
      .reduce((sum, b) => sum + (b.total_cost ?? 0), 0);

    return {
      id:                   shop._id,
      name:                 shop.name,
      city:                 [shop.city, shop.state].filter(Boolean).join(", ") || "—",
      address:              shop.address,
      phone:                shop.phone,
      email:                shop.email,
      website:              shop.website,
      status:               shop.is_active ? "active" : "inactive",
      isVerified:           shop.is_verified,
      laborRate:            shop.labor_rate,
      rating:               shop.rating,
      reviewCount:          shop.review_count,
      stripe:               !!shop.stripe_charges_enabled,
      stripeAccountId:      shop.stripe_connect_account_id,
      stripePayoutsEnabled: !!shop.stripe_payouts_enabled,
      members,
      recentBookings:       bookingsWithUser,
      bookings7d:           allShopBookings.filter((b) =>
        b.created_at && Date.now() - b.created_at < 7 * 24 * 60 * 60 * 1000,
      ).length,
      bookings30d:          allShopBookings.filter((b) =>
        b.created_at && Date.now() - b.created_at < 30 * 24 * 60 * 60 * 1000,
      ).length,
      totalBookings:        allShopBookings.length,
      totalRevenue,
      statusMix,
      serviceBreakdown,
    };
  },
});

export const userDetail = query({
  args: { token: v.string(), id: v.id("users") },
  handler: async (ctx, { token, id }) => {
    await requireDirector(ctx, token);
    const user = await ctx.db.get(id);
    if (!user) return null;

    // Vehicles via vehicle_owners → vehicles → trims → models → makes
    const ownerships = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_id", (q) => q.eq("user_id", id))
      .filter((q) => q.neq(q.field("status"), "removed"))
      .collect();

    const vehicles = await Promise.all(ownerships.map(async (o) => {
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", o.vin))
        .first();
      if (!vehicle) return { vehicleId: null, vin: o.vin, ymm: o.vin, nickname: o.nickname };

      let make = "";
      let model = "";
      if (vehicle.trim_id) {
        const trim = await ctx.db.get(vehicle.trim_id);
        if (trim) {
          const m = await ctx.db.get(trim.model_id);
          if (m) {
            model = m.name ?? "";
            const mk = await ctx.db.get(m.make_id);
            if (mk) make = mk.name ?? "";
          }
        }
      }
      // Manually-input vehicles carry make/model on metadata, not a trim_id chain.
      if (!make || !model) {
        const meta = metaMakeModel(vehicle.metadata);
        if (!make) make = meta.make;
        if (!model) model = meta.model;
      }
      const ymm =
        [vehicle.year, make, model].filter(Boolean).join(" ") || o.vin;

      return { vehicleId: vehicle._id, vin: o.vin, ymm, nickname: o.nickname, mileage: o.mileage };
    }));

    // Recent bookings
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q) => q.eq("user_id", id))
      .order("desc")
      .take(5);

    const recentBookings = await Promise.all(bookings.map(async (b) => {
      const shop = b.shop_id ? await ctx.db.get(b.shop_id) : null;
      return {
        id:        b._id,
        shop:      shop?.name ?? "—",
        scheduled: b.scheduled_date ?? "—",
        status:    b.status,
        total:     b.total_cost ?? 0,
      };
    }));

    // Transactions
    const transactions = await ctx.db
      .query("transactions")
      .withIndex("by_user_id_created_at", (q) => q.eq("user_id", id))
      .order("desc")
      .take(5);

    return {
      id:           user._id,
      name:         `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || "Unknown",
      email:        user.email ?? "—",
      phone:        user.phone ?? "—",
      joined:       user.createdAt
        ? new Date(user.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : "—",
      role:         user.role ?? "user",
      isPendingDeletion: user.isPendingDeletion ?? false,
      vehicles,
      recentBookings,
      transactions:  transactions.map((t) => ({
        id:          t._id,
        date:        new Date(t.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        description: t.description,
        amount:      t.amount,
        status:      t.status,
        type:        t.transaction_type,
      })),
    };
  },
});

export const softDeleteUser = mutation({
  args: { id: v.id("users"), reason: v.string(), actorName: v.string(), actorId: v.optional(v.id("director_users")) },
  handler: async (ctx, { id, reason, actorName, actorId }) => {
    await ctx.db.patch(id, {
      isPendingDeletion: true,
      deletionRequestedAt: Date.now(),
      deletionSurveyResponse: reason,
    });
    await ctx.db.insert("audit_log", {
      entity_type: "user",
      entity_id: String(id),
      action: "status_change",
      actor: actorName,
      actor_id: actorId,
      detail: `Soft delete requested. Reason: ${reason}`,
      created_at: Date.now(),
    });
  },
});

export const usersList = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const users = await ctx.db.query("users").order("desc").take(100);
    return Promise.all(users.map(async (u) => {
      const [bookings, vehicles] = await Promise.all([
        ctx.db.query("bookings").withIndex("by_user_id", (q) => q.eq("user_id", u._id)).collect(),
        ctx.db.query("vehicle_owners").withIndex("by_user_id", (q) => q.eq("user_id", u._id))
          .filter((q) => q.neq(q.field("status"), "removed")).collect(),
      ]);
      const lastBooking = bookings
        .filter((b) => b.scheduled_date)
        .sort((a, b) => (b.scheduled_date! > a.scheduled_date! ? 1 : -1))[0];
      return {
        id:          u._id,
        name:        `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || u.email || "Unknown",
        email:       u.email ?? "—",
        phone:       u.phone ?? "—",
        joined:      u.createdAt
          ? new Date(u.createdAt).toLocaleDateString("en-US", { month: "short", year: "numeric" })
          : "—",
        vehicles:    vehicles.length,
        bookings:    bookings.length,
        lastBooking: lastBooking?.scheduled_date ?? "—",
        loyalty:     "standard" as const,
        isPendingDeletion: u.isPendingDeletion ?? false,
      };
    }));
  },
});

export const recentBookingsList = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_created_at")
      .order("desc")
      .take(50);
    return Promise.all(bookings.map(async (b) => {
      const [user, shop] = await Promise.all([
        ctx.db.get(b.user_id),
        b.shop_id ? ctx.db.get(b.shop_id) : null,
      ]);
      const services = await Promise.all(
        b.service_ids.map(async (sid) => { const s = await ctx.db.get(sid); return s?.name ?? "—"; })
      );
      // Pricing v2 fallback summary — mirrors the per-service classification
      // BookingDetailModal already does, so list + modal stay in sync without
      // a second round-trip when the director scans the table. Fixed-price
      // modes (fixed_price_override, ccb_absolute_pricing) are set prices,
      // not estimates — explicitly excluded from the fallback counters.
      const flagRows = b.service_quote_flags ?? [];
      let catches = 0;
      let corrected = 0;
      let refused = 0;
      let laborFloored = 0;
      let laborAbove = 0;
      for (const row of flagRows) {
        const f = row.flags ?? [];
        if (f.includes("fixed_price_override") || f.includes("ccb_absolute_pricing")) continue;
        if (f.includes("fallback_catch")) catches++;
        if (f.includes("engine_corrected_parts")) corrected++;
        if (f.includes("fallback_only")) refused++;
        if (f.includes("labor_below_tier_floor")) laborFloored++;
        if (f.includes("labor_above_tier_expected")) laborAbove++;
      }
      // Booking-level "labor cost above engine" — server soft-flagged because
      // the customer's labor cost landed >8% above the engine's expected
      // cost (paying more is consensual, but worth surfacing).
      const aboveEngine = (b.quote_flags ?? []).includes(
        "labor_cost_above_engine",
      )
        ? 1
        : 0;
      const aboveEngineDeltaDollars = aboveEngine
        ? b.labor_cost_delta_above_engine_dollars ?? null
        : null;
      return {
        id:        b._id,
        user:      user ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || "Unknown" : "Unknown",
        shop:      shop?.name ?? "—",
        services,
        scheduled: b.scheduled_date ?? "—",
        time:      b.scheduled_time ?? "—",
        status:    b.status,
        total:     b.total_cost ?? 0,
        fallback: {
          catches,
          corrected,
          refused,
          aboveEngine,
          aboveEngineDeltaDollars,
          laborFloored,
          laborAbove,
          total: flagRows.length,
        },
      };
    }));
  },
});

export const bookingDetail = query({
  args: { token: v.string(), id: v.id("bookings") },
  handler: async (ctx, { token, id }) => {
    await requireDirector(ctx, token);
    const booking = await ctx.db.get(id);
    if (!booking) return null;

    const [user, shop] = await Promise.all([
      ctx.db.get(booking.user_id),
      booking.shop_id ? ctx.db.get(booking.shop_id) : null,
    ]);

    // Service rows — keep id + description so we can show the form filled
    // per-service (selected option, tire spec, etc.). Joins Pricing v2
    // per-service flags so the director modal can render a "Fallback catch"
    // pill next to lines the engine flagged.
    const serviceFlagsByServiceId = new Map<
      string,
      NonNullable<typeof booking.service_quote_flags>[number]
    >();
    for (const row of booking.service_quote_flags ?? []) {
      serviceFlagsByServiceId.set(String(row.service_id), row);
    }
    const services = await Promise.all(
      booking.service_ids.map(async (sid) => {
        const s = await ctx.db.get(sid);
        let category: string | undefined;
        if (s?.service_category_id) {
          const cat = await ctx.db.get(s.service_category_id);
          category = cat?.name;
        }
        const flagRow = serviceFlagsByServiceId.get(String(sid));
        return {
          id:          sid,
          name:        s?.name ?? "—",
          slug:        s?.slug,
          description: s?.description,
          category,
          quoteFlags:  flagRow?.flags ?? [],
          engineBand: flagRow
            ? {
                partsLow:    flagRow.engine_parts_low ?? null,
                partsHigh:   flagRow.engine_parts_high ?? null,
                laborHours:  flagRow.engine_labor_hours ?? null,
                laborSource: flagRow.engine_labor_source ?? null,
                partsSource: flagRow.parts_source ?? null,
              }
            : null,
          bookingLinePartsCost: flagRow?.booking_line_parts_cost ?? null,
        };
      })
    );

    // Resolve recommended-service name if the mechanic recommended something.
    let recommendedService: string | null = null;
    if (booking.recommended_service_id) {
      const rs = await ctx.db.get(booking.recommended_service_id);
      recommendedService = rs?.name ?? null;
    }

    // Resolve selected service-option labels in case the snapshot is missing
    // them on older bookings.
    const selectedOptions = await Promise.all(
      (booking.selected_service_options ?? []).map(async (o) => {
        let label = o.option_label;
        let type  = o.option_type;
        if (!label) {
          const opt = await ctx.db.get(o.option_id);
          label = opt?.option_label ?? "—";
          type  = opt?.option_type ?? type;
        }
        const svc = await ctx.db.get(o.service_id);
        return {
          serviceName: svc?.name ?? "—",
          serviceId:   o.service_id,
          label,
          type,
        };
      })
    );

    // Vehicle YMM (most directors recognize a car by year+make+model).
    let vehicleYmm: string | null = null;
    let vehicleId: import("./_generated/dataModel").Id<"vehicles"> | null = null;
    if (booking.vin) {
      const veh = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", booking.vin))
        .first();
      if (veh) {
        vehicleId = veh._id;
        let make = "", model = "";
        if (veh.trim_id) {
          const trim = await ctx.db.get(veh.trim_id);
          if (trim) {
            const m = await ctx.db.get(trim.model_id);
            if (m) {
              model = m.name ?? "";
              const mk = await ctx.db.get(m.make_id);
              if (mk) make = mk.name ?? "";
            }
          }
        }
        // Manually-input vehicles carry make/model on metadata, not a trim_id chain.
        if (!make || !model) {
          const meta = metaMakeModel(veh.metadata);
          if (!make) make = meta.make;
          if (!model) model = meta.model;
        }
        vehicleYmm = [veh.year, make, model].filter(Boolean).join(" ") || veh.vin;
      }
    }

    const [statusHistory, payment, review, payments] = await Promise.all([
      ctx.db.query("booking_status_history").withIndex("by_booking_id", (q) => q.eq("booking_id", id)).order("asc").collect(),
      ctx.db.query("payments").withIndex("by_booking_id", (q) => q.eq("booking_id", id)).first(),
      ctx.db.query("reviews").withIndex("by_booking_id", (q) => q.eq("booking_id", id)).first(),
      ctx.db.query("payments").withIndex("by_booking_id", (q) => q.eq("booking_id", id)).collect(),
    ]);

    const mechanic = booking.mechanic_id ? await ctx.db.get(booking.mechanic_id) : null;

    return {
      id:        booking._id,
      user:      user ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || "Unknown" : "Unknown",
      userId:    booking.user_id,
      userEmail: user?.email,
      userPhone: user?.phone,
      shop:      shop?.name ?? "—",
      shopId:    booking.shop_id ?? null,
      shopAddress: shop?.address,
      shopPhone:   shop?.phone,
      shopEmail:   shop?.email,
      services,
      scheduled: booking.scheduled_date ?? "—",
      time:      booking.scheduled_time ?? "—",
      status:    booking.status,
      total:     booking.total_cost ?? 0,
      labor:     booking.labor_cost ?? 0,
      parts:     booking.parts_cost ?? 0,
      laborMinutesEstimate: booking.estimated_labor_minutes,
      invoiceNumber:        booking.invoice_number,
      liveStage:            booking.live_stage,
      createdAt:            booking.created_at,
      vin:                  booking.vin,
      vehicleYmm,
      vehicleId,

      // The "forms the user filled out"
      customerNotes:       booking.customer_notes,
      diagnosticSystem:    booking.diagnostic_system,
      diagnosticChecklist: booking.diagnostic_checklist ?? [],
      diagnosticChecklistCompletedAt: booking.diagnostic_checklist_completed_at_ms,
      diagnosticFindingsNote: booking.diagnostic_findings_note,
      diagnosticFollowupState: booking.diagnostic_followup_state,
      awaitingInfoNote:    booking.awaiting_info_note,
      outOfScopeCategory:  booking.out_of_scope_category,
      outOfScopeNote:      booking.out_of_scope_note,
      tireSpecs:           booking.tire_specs,
      selectedOptions,
      recommendedService,
      recommendedServiceNote: booking.recommended_service_note,
      recommendationState:    booking.recommendation_state,
      recommendationSentAt:   booking.recommendation_sent_at_ms,
      recommendationDecidedAt: booking.recommendation_decided_at_ms,
      recommendedScheduledDate: booking.recommended_scheduled_date,
      recommendedScheduledTime: booking.recommended_scheduled_time,
      parentJobId:         booking.parent_job_id,
      refundReason:        booking.refund_reason,
      quoteFlags:          booking.quote_flags ?? [],
      quoteFallbackLow:    booking.quote_fallback_low ?? null,
      quoteFallbackHigh:   booking.quote_fallback_high ?? null,
      laborCostDeltaAboveEngineDollars:
        booking.labor_cost_delta_above_engine_dollars ?? null,

      statusHistory: statusHistory.map((h) => ({
        status:    h.new_status,
        changedAt: h.changed_at,
        changedBy: h.changed_by,
        reason:    h.reason,
      })),
      payment: payment ? {
        amount:               payment.amount,
        stripePaymentIntentId: payment.stripe_payment_intent_id,
        paymentMethod:        payment.payment_method,
        status:               payment.status,
      } : null,
      allPayments: payments.map((p) => ({
        id:                    p._id,
        amount:                p.amount,
        status:                p.status,
        stripePaymentIntentId: p.stripe_payment_intent_id,
        paymentMethod:         p.payment_method,
        createdAt:             p.created_at,
      })),
      mechanic: mechanic ? {
        id:    mechanic._id,
        name:  `${mechanic.first_name} ${mechanic.last_name}`.trim(),
        title: mechanic.title,
        email: mechanic.email,
      } : null,
      review: review ? {
        rating:  review.rating,
        comment: review.comment,
      } : null,
    };
  },
});

export const refundedBookingsList = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireDirector(ctx, token);
    const bookings = await ctx.db
      .query("bookings")
      .withIndex("by_status", (q) => q.eq("status", "refunded"))
      .order("desc")
      .take(100);
    return Promise.all(bookings.map(async (b) => {
      const [user, shop] = await Promise.all([
        ctx.db.get(b.user_id),
        b.shop_id ? ctx.db.get(b.shop_id) : null,
      ]);
      return {
        id:           b._id,
        user:         user ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || "Unknown" : "Unknown",
        shop:         shop?.name ?? "—",
        scheduled:    b.scheduled_date ?? "—",
        total:        b.total_cost ?? 0,
        refundReason: b.refund_reason ?? null,
      };
    }));
  },
});

export const setShopActive = mutation({
  args: { id: v.id("shops"), active: v.boolean(), reason: v.string(), actorName: v.string(), actorId: v.optional(v.id("director_users")) },
  handler: async (ctx, { id, active, reason, actorName, actorId }) => {
    await ctx.db.patch(id, { is_active: active });
    await ctx.db.insert("audit_log", {
      entity_type: "shop",
      entity_id:   String(id),
      action:      "status_change",
      actor:       actorName,
      actor_id:    actorId,
      detail:      `Shop ${active ? "reactivated" : "deactivated"}. Reason: ${reason}`,
      created_at:  Date.now(),
    });
  },
});

export const setShopVerified = mutation({
  args: { id: v.id("shops"), verified: v.boolean(), reason: v.string(), actorName: v.string(), actorId: v.optional(v.id("director_users")) },
  handler: async (ctx, { id, verified, reason, actorName, actorId }) => {
    await ctx.db.patch(id, { is_verified: verified });
    await ctx.db.insert("audit_log", {
      entity_type: "shop",
      entity_id:   String(id),
      action:      "field_edit",
      actor:       actorName,
      actor_id:    actorId,
      detail:      `Verification ${verified ? "granted" : "removed"}. Reason: ${reason}`,
      created_at:  Date.now(),
    });
  },
});

export const tagRefund = mutation({
  args: { id: v.id("bookings"), reason: v.string(), actorName: v.string(), actorId: v.optional(v.id("director_users")) },
  handler: async (ctx, { id, reason, actorName, actorId }) => {
    await ctx.db.patch(id, { refund_reason: reason });
    await ctx.db.insert("audit_log", {
      entity_type: "booking",
      entity_id:   String(id),
      action:      "refund_tagged",
      actor:       actorName,
      actor_id:    actorId,
      detail:      `Refund tagged: ${reason}`,
      created_at:  Date.now(),
    });
  },
});

export const logView = mutation({
  args: { entity_type: v.string(), entity_id: v.string(), actorName: v.string(), actorId: v.optional(v.id("director_users")) },
  handler: async (ctx, { entity_type, entity_id, actorName, actorId }) => {
    await ctx.db.insert("audit_log", {
      entity_type, entity_id,
      action: "view",
      actor: actorName,
      actor_id: actorId,
      detail: `Viewed by ${actorName}`,
      created_at: Date.now(),
    });
  },
});
