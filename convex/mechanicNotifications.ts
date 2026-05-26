import { query, mutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { bookingVisibleUnderScope, getCurrentNotificationScope } from "./lib/notificationScope";

// ---------------------------------------------------------------------------
// Local auth + formatting helpers
//
// These mirror the private helpers in convex/bookings.ts (formatCustomerName,
// getCurrentUserOrNull, getPrimaryAuthorizedShop) but stay self-contained so
// this module doesn't depend on internals of bookings.ts.
// ---------------------------------------------------------------------------

async function getCurrentUserOrNull(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", identity.subject)
    )
    .unique();
  return user ?? null;
}

type ShopUserRow = {
  _id: Id<"shop_users">;
  shop_id: Id<"shops">;
  role: string;
  is_active?: boolean;
  notifications_last_seen_at?: number;
};

async function getPrimaryAuthorizedShopUser(
  ctx: any,
  userId: Id<"users">
): Promise<{ shopUser: ShopUserRow | null; shopId: Id<"shops"> | null; role: string | null }> {
  const activeMembership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .first();

  if (activeMembership) {
    return {
      shopUser: activeMembership as ShopUserRow,
      shopId: activeMembership.shop_id as Id<"shops">,
      role: activeMembership.role as string,
    };
  }

  const ownedShop = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .first();

  if (ownedShop) {
    return { shopUser: null, shopId: ownedShop._id, role: "owner" };
  }
  return { shopUser: null, shopId: null, role: null };
}

function formatCustomerName(customer: any): { full: string; short: string } {
  const first = (customer?.first_name ?? "").trim();
  const last = (customer?.last_name ?? "").trim();
  const full =
    `${first} ${last}`.trim() || customer?.email || "Unknown customer";
  const short = last ? `${first} ${last[0]}.`.trim() : first || full;
  return { full, short };
}

async function resolveVehicleShort(
  ctx: any,
  vin: string
): Promise<{ full: string; short: string }> {
  if (!vin) return { full: "", short: "" };
  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", vin))
    .first();
  if (!vehicle) return { full: vin, short: vin };
  const meta =
    (vehicle.metadata as { make?: string; model?: string } | undefined) ??
    undefined;
  const year = typeof vehicle.year === "number" ? vehicle.year : null;
  const parts = [year, meta?.make, meta?.model].filter(Boolean);
  const full = parts.join(" ") || vin;
  const shortParts = [
    year,
    meta?.make ? `${meta.make[0]}.` : "",
    meta?.model,
  ].filter(Boolean);
  const short = shortParts.join(" ") || vin;
  return { full, short };
}

function formatScheduled(
  date: string | undefined,
  time: string | undefined
): string | null {
  if (!date && !time) return null;
  let label = "";
  if (date) {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    if (date === todayStr) label = "Today";
    else if (date === tomorrowStr) label = "Tomorrow";
    else {
      const [y, m, d] = date.split("-").map(Number);
      if (y && m && d) {
        const dt = new Date(Date.UTC(y, m - 1, d));
        label = dt.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        });
      } else label = date;
    }
  }
  if (time) {
    const [hRaw, mRaw] = time.split(":");
    const h = Number(hRaw);
    const m = Number(mRaw);
    if (Number.isFinite(h) && Number.isFinite(m)) {
      const period = h >= 12 ? "PM" : "AM";
      const h12 = ((h + 11) % 12) + 1;
      const mm = String(m).padStart(2, "0");
      const t = `${h12}:${mm} ${period}`;
      label = label ? `${label} · ${t}` : t;
    }
  }
  return label || null;
}

function deriveUrgency(
  scheduledDate: string | undefined,
  scheduledTime: string | undefined
): "urgent" | null {
  if (!scheduledDate || !scheduledTime) return null;
  const [y, mo, d] = scheduledDate.split("-").map(Number);
  const [h, mi] = scheduledTime.split(":").map(Number);
  if (![y, mo, d, h, mi].every((n) => Number.isFinite(n))) return null;
  const target = new Date(y, mo - 1, d, h, mi).getTime();
  const hoursAway = (target - Date.now()) / 3_600_000;
  return hoursAway >= 0 && hoursAway <= 4 ? "urgent" : null;
}

// ---------------------------------------------------------------------------
// Public queries / mutations
// ---------------------------------------------------------------------------

export const getFeed = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;

    const primary = await getPrimaryAuthorizedShopUser(ctx, user._id);
    if (!primary.shopId) return null;

    const shopId = primary.shopId;
    const lastSeenAt = primary.shopUser?.notifications_last_seen_at ?? 0;
    const scope = await getCurrentNotificationScope(ctx);

    // 1. Bookings needing shop confirmation.
    //    The UI labels both "pending" and "pending_shop_acceptance" as
    //    "Awaiting shop review" (see components/booking-detail-panel.tsx), so
    //    surface both in the feed.
    const [pendingPlain, pendingExplicit] = await Promise.all([
      ctx.db
        .query("bookings")
        .withIndex("by_shop_and_status", (q: any) =>
          q.eq("shop_id", shopId).eq("status", "pending")
        )
        .order("desc")
        .collect(),
      ctx.db
        .query("bookings")
        .withIndex("by_shop_and_status", (q: any) =>
          q.eq("shop_id", shopId).eq("status", "pending_shop_acceptance")
        )
        .order("desc")
        .collect(),
    ]);
    const pendingConfirmAll = [...pendingPlain, ...pendingExplicit];
    const pendingConfirm = scope
      ? pendingConfirmAll.filter((b: any) =>
          bookingVisibleUnderScope(scope, b.mechanic_id ?? null),
        )
      : pendingConfirmAll;

    // 2. Open tire-quote-request bookings (shop_id may be null until acceptance,
    //    so we scan globally by status and filter to bookings this shop hasn't
    //    quoted on yet — mirrors listOpenTireQuoteRequestsForShop.).
    const [pendingQuote, quotesReady] = await Promise.all([
      ctx.db
        .query("bookings")
        .withIndex("by_status", (q: any) => q.eq("status", "pending_quote"))
        .collect(),
      ctx.db
        .query("bookings")
        .withIndex("by_status", (q: any) => q.eq("status", "quotes_ready"))
        .collect(),
    ]);

    const tireCandidates = [...pendingQuote, ...quotesReady].filter(
      (b: any) => b.tire_specs != null
    );

    const tireRequests = (
      await Promise.all(
        tireCandidates.map(async (booking: any) => {
          const existing = await ctx.db
            .query("tire_quote_responses")
            .withIndex("by_booking_and_shop", (q: any) =>
              q.eq("booking_id", booking._id).eq("shop_id", shopId)
            )
            .filter((q: any) => q.eq(q.field("superseded_at"), undefined))
            .first();
          return existing ? null : booking;
        })
      )
    ).filter((b): b is NonNullable<typeof b> => b != null);

    // Hydrate cards for both kinds.
    const confirmItems = await Promise.all(
      pendingConfirm.map(async (booking: any) => {
        const customer = await ctx.db.get(booking.user_id);
        const vehicle = await resolveVehicleShort(ctx, booking.vin);
        const serviceNames: string[] = [];
        if (booking.service_ids?.length) {
          const services = await Promise.all(
            booking.service_ids.map((id: any) => ctx.db.get(id))
          );
          for (const s of services) {
            if (s && (s as any).name) serviceNames.push((s as any).name);
          }
        }
        const createdAt = booking.created_at ?? booking._creationTime ?? 0;
        return {
          kind: "booking" as const,
          bookingId: booking._id as Id<"bookings">,
          createdAt,
          isUnread: createdAt > lastSeenAt,
          customer: formatCustomerName(customer),
          vehicle,
          services: serviceNames,
          scheduledDate: booking.scheduled_date ?? null,
          scheduledTime: booking.scheduled_time ?? null,
          scheduledLabel: formatScheduled(
            booking.scheduled_date,
            booking.scheduled_time
          ),
          // Quoted set price the customer agreed to (single value). Falls
          // back to the legacy total_cost for pre-feature bookings without
          // a quote snapshot.
          price:
            booking.quoted_set_price_cents != null
              ? booking.quoted_set_price_cents / 100
              : (booking.total_cost ?? null),
          note: booking.customer_notes ?? null,
          urgency: deriveUrgency(
            booking.scheduled_date,
            booking.scheduled_time
          ),
          tireSpecs: null,
        };
      })
    );

    const tireItems = await Promise.all(
      tireRequests.map(async (booking: any) => {
        const customer = await ctx.db.get(booking.user_id);
        const vehicle = await resolveVehicleShort(ctx, booking.vin);
        const createdAt = booking.created_at ?? booking._creationTime ?? 0;
        return {
          kind: "tire_quote" as const,
          bookingId: booking._id as Id<"bookings">,
          createdAt,
          isUnread: createdAt > lastSeenAt,
          customer: formatCustomerName(customer),
          vehicle,
          services: [],
          scheduledDate: null,
          scheduledTime: null,
          scheduledLabel: null,
          price: null,
          note: booking.customer_notes ?? null,
          urgency: null,
          tireSpecs: booking.tire_specs ?? null,
        };
      })
    );

    const items = [...confirmItems, ...tireItems].sort(
      (a, b) => b.createdAt - a.createdAt
    );

    const counts = {
      confirm: confirmItems.length,
      tireQuote: tireItems.length,
    };

    const unreadCount = items.reduce(
      (n, item) => (item.isUnread ? n + 1 : n),
      0
    );

    return {
      unreadCount,
      counts,
      items,
      lastSeenAt,
    };
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;

    const primary = await getPrimaryAuthorizedShopUser(ctx, user._id);
    if (!primary.shopUser) return null;

    await ctx.db.patch(primary.shopUser._id, {
      notifications_last_seen_at: Date.now(),
    });
    return null;
  },
});
