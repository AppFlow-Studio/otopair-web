import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// All queries for the director panel. No auth — access-controlled at middleware level.

export const sidebarCounts = query({
  args: {},
  handler: async (ctx) => {
    const [bugs, feedback, refunds, pendingVerifications] = await Promise.all([
      ctx.db.query("bugs").collect(),
      ctx.db.query("app_feedback").collect(),
      ctx.db.query("bookings").withIndex("by_status", (q) => q.eq("status", "refunded")).collect(),
      ctx.db.query("mechanic_verifications").withIndex("by_status", (q) => q.eq("status", "pending")).collect(),
    ]);
    const openBugStatuses = new Set(["new", "triaged", "assigned", "in_progress"]);
    const openFbStatuses  = new Set(["new", "reviewed", "triaged"]);
    return {
      bugs:          bugs.filter((b) => openBugStatuses.has(b.status)).length,
      feedback:      feedback.filter((f) => openFbStatuses.has(f.status)).length,
      stripe:        refunds.length,
      mechanicEdits: pendingVerifications.length,
    };
  },
});

export const overviewCounters = query({
  args: { period: v.optional(v.union(v.literal("today"), v.literal("7d"), v.literal("30d"))) },
  handler: async (ctx, { period = "today" }) => {
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
  args: { period: v.optional(v.union(v.literal("today"), v.literal("7d"), v.literal("30d"))) },
  handler: async (ctx, { period = "today" }) => {
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
  args: {},
  handler: async (ctx) => {
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
  args: { id: v.id("shops") },
  handler: async (ctx, { id }) => {
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

    const recentBookings = await ctx.db
      .query("bookings")
      .withIndex("by_shop_id", (q) => q.eq("shop_id", id))
      .order("desc")
      .take(5);

    const bookingsWithUser = await Promise.all(recentBookings.map(async (b) => {
      const user = await ctx.db.get(b.user_id);
      return {
        id:     b._id,
        user:   user ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || "Unknown" : "Unknown",
        status: b.status,
        total:  b.total_cost ?? 0,
        date:   b.scheduled_date ?? "—",
      };
    }));

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
    };
  },
});

export const userDetail = query({
  args: { id: v.id("users") },
  handler: async (ctx, { id }) => {
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
      if (!vehicle) return { vin: o.vin, ymm: o.vin, nickname: o.nickname };

      let ymm = o.vin;
      if (vehicle.trim_id) {
        const trim = await ctx.db.get(vehicle.trim_id);
        if (trim) {
          const model = await ctx.db.get(trim.model_id);
          if (model) {
            const make = await ctx.db.get(model.make_id);
            ymm = [vehicle.year, make?.name, model.name].filter(Boolean).join(" ");
          }
        }
      } else if (vehicle.year) {
        ymm = String(vehicle.year);
      }

      return { vin: o.vin, ymm, nickname: o.nickname, mileage: o.mileage };
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
  args: {},
  handler: async (ctx) => {
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
  args: {},
  handler: async (ctx) => {
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
      return {
        id:        b._id,
        user:      user ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || "Unknown" : "Unknown",
        shop:      shop?.name ?? "—",
        services,
        scheduled: b.scheduled_date ?? "—",
        time:      b.scheduled_time ?? "—",
        status:    b.status,
        total:     b.total_cost ?? 0,
      };
    }));
  },
});

export const bookingDetail = query({
  args: { id: v.id("bookings") },
  handler: async (ctx, { id }) => {
    const booking = await ctx.db.get(id);
    if (!booking) return null;

    const [user, shop] = await Promise.all([
      ctx.db.get(booking.user_id),
      booking.shop_id ? ctx.db.get(booking.shop_id) : null,
    ]);

    const services = await Promise.all(
      booking.service_ids.map(async (sid) => { const s = await ctx.db.get(sid); return s?.name ?? "—"; })
    );

    const [statusHistory, payment, review] = await Promise.all([
      ctx.db.query("booking_status_history").withIndex("by_booking_id", (q) => q.eq("booking_id", id)).order("asc").collect(),
      ctx.db.query("payments").withIndex("by_booking_id", (q) => q.eq("booking_id", id)).first(),
      ctx.db.query("reviews").withIndex("by_booking_id", (q) => q.eq("booking_id", id)).first(),
    ]);

    const mechanic = booking.mechanic_id ? await ctx.db.get(booking.mechanic_id) : null;

    return {
      id:        booking._id,
      user:      user ? `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || user.email || "Unknown" : "Unknown",
      shop:      shop?.name ?? "—",
      services,
      scheduled: booking.scheduled_date ?? "—",
      time:      booking.scheduled_time ?? "—",
      status:    booking.status,
      total:     booking.total_cost ?? 0,
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
      mechanic: mechanic ? {
        name:  `${mechanic.first_name} ${mechanic.last_name}`.trim(),
        title: mechanic.title,
      } : null,
      review: review ? {
        rating:  review.rating,
        comment: review.comment,
      } : null,
    };
  },
});

export const refundedBookingsList = query({
  args: {},
  handler: async (ctx) => {
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
