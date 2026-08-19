/**
 * notifications.ts — Customer-facing notification feed
 *
 * Reads from the existing `notification_outbox` table (defined in
 * `schema.ts`). Shop-side mutations like `proposeReschedule` already
 * enqueue rows with the customer's `user_id` populated (see
 * `enqueueNotificationOutbox` in `bookings.ts`). This module exposes
 * the customer view: list pending rows, count unread, mark read.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentNotificationScope } from "./lib/notificationScope";

async function getCurrentUserOrNull(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", identity.subject),
    )
    .unique();
}

export const getMyNotifications = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return [];

    // The feed reads the RESOLVE axis, not delivery status — a delivered push
    // stays until it's resolved by an action or a booking state change.
    const rows = await ctx.db
      .query("notification_outbox")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .collect();

    const mine = rows
      .filter((row: any) => row.resolved_at == null)
      .sort((a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0))
      .slice(0, 50);

    // Enrich each booking-bound row with the short handle, customer name,
    // vehicle label, and shop name so banners can render descriptive copy
    // without a second roundtrip per row.
    const RESCHEDULE_TTL_MS = 24 * 60 * 60 * 1000;

    const enriched = await Promise.all(
      mine.map(async (row: any) => {
        let customerName: string | null = null;
        let vehicleLabel: string | null = null;
        let shopName: string | null = null;
        let scheduledDate: string | null = null;
        let scheduledTime: string | null = null;
        let shortHandle: string | null = null;
        let rescheduleExpiresAt: number | null = null;
        let assignedMechanicId: string | null = null;
        if (row.booking_id) {
          const booking: any = await ctx.db.get(row.booking_id);
          if (booking) {
            scheduledDate = booking.scheduled_date ?? null;
            scheduledTime = booking.scheduled_time ?? null;
            assignedMechanicId = booking.mechanic_id ?? null;
            if (
              (row.category === "booking_reschedule_proposed" ||
                row.category === "booking_forced_delay_proposed") &&
              typeof booking.reschedule_proposed_at === "number" &&
              booking.status === "pending_customer_acceptance"
            ) {
              rescheduleExpiresAt =
                booking.reschedule_proposed_at + RESCHEDULE_TTL_MS;
            }
            const inv = (booking.invoice_number ?? "").trim();
            shortHandle = inv
              ? inv.startsWith("#")
                ? inv
                : `#${inv}`
              : `#${String(booking._id).slice(-6).toUpperCase()}`;
            if (booking.user_id) {
              const cust: any = await ctx.db.get(booking.user_id);
              const composed = [cust?.first_name, cust?.last_name]
                .filter(Boolean)
                .join(" ");
              customerName =
                cust?.name ||
                (composed.length > 0 ? composed : null) ||
                cust?.email ||
                null;
            }
            if (booking.vehicle_id) {
              const veh: any = await ctx.db.get(booking.vehicle_id);
              if (veh) {
                const meta = veh.metadata ?? {};
                const parts = [veh.year ?? meta.year, meta.make, meta.model].filter(
                  Boolean,
                );
                vehicleLabel =
                  parts.length > 0
                    ? parts.join(" ")
                    : veh.vin
                      ? `VIN …${String(veh.vin).slice(-6)}`
                      : null;
              }
            }
          }
        }
        if (row.shop_id) {
          const shop: any = await ctx.db.get(row.shop_id);
          shopName = shop?.name ?? null;
        }
        return {
          _id: row._id,
          category: row.category,
          payload: row.payload,
          booking_id: row.booking_id ?? null,
          shop_id: row.shop_id ?? null,
          created_at: row.created_at,
          status: row.status,
          read_at: row.read_at ?? null,
          customerName,
          vehicleLabel,
          shopName,
          shortHandle,
          scheduledDate,
          scheduledTime,
          rescheduleExpiresAt,
          assignedMechanicId,
        };
      }),
    );
    return enriched;
  },
});

export const getMyUnreadCount = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return 0;

    const rows = await ctx.db
      .query("notification_outbox")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .collect();

    // Unread = still open (resolved_at == null) AND not yet seen (read_at == null).
    return rows.filter(
      (row: any) => row.resolved_at == null && row.read_at == null,
    ).length;
  },
});

// ============================================================================
// Shop-staff notification feed (new bookings, quote requests)
// ============================================================================

const STAFF_CATEGORIES = ["new_booking", "new_quote_request", "booking_never_started", "settlement_shortfall", "hold_expiring"] as const;

/**
 * Alerts that used to be written with `channel: "slack"` and then sat pending
 * forever, because no Slack dispatcher exists in this codebase — blockers,
 * damage reports, and a shortcut created for work we already sell.
 *
 * They don't need one. This feed already reads notification_outbox by shop, so
 * the fix is to let these categories through rather than to build an
 * integration: the people who need to see a stopped job are the people already
 * looking at this list.
 *
 * A prefix test rather than an enum because blocker categories are minted per
 * kind (`job_blocked_parts_delay`, …) and a fixed list would silently drop the
 * next kind someone adds to KIND_POLICY.
 */
function isStaffCategory(category: unknown): boolean {
  if (typeof category !== "string") return false;
  if ((STAFF_CATEGORIES as readonly string[]).includes(category)) return true;
  // Owner-audience blockers only. The driver-audience twin is suffixed
  // `_driver` and is not the shop's notification.
  if (category.startsWith("job_blocked_") && !category.endsWith("_driver")) {
    return true;
  }
  return category === "custom_shortcut_override";
}
const MECHANIC_CATEGORIES = ["new_job_assigned"] as const;
const OWNER_MANAGER_ROLES = new Set(["owner", "shop_owner", "admin"]);
const FRONT_DESK_ROLES = new Set(["front_desk"]);
const MECHANIC_ROLES = new Set(["shop_mechanic", "mechanic"]);

async function getShopMembership(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", identity.subject),
    )
    .unique();
  if (!user) return null;

  const membership = await ctx.db
    .query("shop_users")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
    .filter((q: any) => q.eq(q.field("is_active"), true))
    .first();

  return membership ? { user, membership } : null;
}

export const getShopStaffUnreadCount = query({
  args: {},
  handler: async (ctx) => {
    const info = await getShopMembership(ctx);
    if (!info) return 0;
    const { user, membership } = info;

    const rows = (
      await ctx.db
        .query("notification_outbox")
        .withIndex("by_shop_id", (q: any) => q.eq("shop_id", membership.shop_id))
        .collect()
    ).filter((r: any) => r.resolved_at == null);

    if (MECHANIC_ROLES.has(membership.role)) {
      return rows.filter(
        (r: any) =>
          String(r.mechanic_id) === String(user._id) &&
          MECHANIC_CATEGORIES.includes(r.category),
      ).length;
    }

    if (
      OWNER_MANAGER_ROLES.has(membership.role) ||
      FRONT_DESK_ROLES.has(membership.role)
    ) {
      return rows.filter((r: any) => isStaffCategory(r.category)).length;
    }

    return 0;
  },
});

export const getShopStaffNotifications = query({
  args: {},
  handler: async (ctx) => {
    const info = await getShopMembership(ctx);
    if (!info) return [];
    const { user, membership } = info;

    const rows = (
      await ctx.db
        .query("notification_outbox")
        .withIndex("by_shop_id", (q: any) => q.eq("shop_id", membership.shop_id))
        .collect()
    ).filter((r: any) => r.resolved_at == null);

    let filtered: any[];
    if (MECHANIC_ROLES.has(membership.role)) {
      filtered = rows.filter(
        (r: any) =>
          String(r.mechanic_id) === String(user._id) &&
          MECHANIC_CATEGORIES.includes(r.category),
      );
    } else if (
      OWNER_MANAGER_ROLES.has(membership.role) ||
      FRONT_DESK_ROLES.has(membership.role)
    ) {
      filtered = rows.filter((r: any) => isStaffCategory(r.category));
    } else {
      return [];
    }

    const sorted = filtered
      .sort((a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0))
      .slice(0, 30);

    const enriched = await Promise.all(
      sorted.map(async (row: any) => {
        let customerName: string | null = null;
        let vehicleLabel: string | null = null;
        let shortHandle: string | null = null;
        let scheduledDate: string | null = null;
        let scheduledTime: string | null = null;

        if (row.booking_id) {
          const booking: any = await ctx.db.get(row.booking_id);
          if (booking) {
            scheduledDate = booking.scheduled_date ?? null;
            scheduledTime = booking.scheduled_time ?? null;
            const inv = (booking.invoice_number ?? "").trim();
            shortHandle = inv
              ? inv.startsWith("#")
                ? inv
                : `#${inv}`
              : `#${String(booking._id).slice(-6).toUpperCase()}`;
            if (booking.user_id) {
              const cust: any = await ctx.db.get(booking.user_id);
              const composed = [cust?.first_name, cust?.last_name]
                .filter(Boolean)
                .join(" ");
              customerName =
                cust?.name ||
                (composed.length > 0 ? composed : null) ||
                cust?.email ||
                null;
            }
            if (booking.vehicle_id) {
              const veh: any = await ctx.db.get(booking.vehicle_id);
              if (veh) {
                const meta = veh.metadata ?? {};
                const parts = [
                  veh.year ?? meta.year,
                  meta.make,
                  meta.model,
                ].filter(Boolean);
                vehicleLabel =
                  parts.length > 0
                    ? parts.join(" ")
                    : veh.vin
                      ? `VIN …${String(veh.vin).slice(-6)}`
                      : null;
              }
            }
          }
        }

        return {
          _id: row._id,
          category: row.category as string,
          booking_id: row.booking_id ?? null,
          shop_id: row.shop_id ?? null,
          created_at: row.created_at,
          status: row.status,
          customerName,
          vehicleLabel,
          shortHandle,
          scheduledDate,
          scheduledTime,
        };
      }),
    );

    return enriched;
  },
});

// ---------------------------------------------------------------------------
// Activity history — recent outbox rows (open AND resolved) for the full
// /notifications page "History" tab. Scope mirrors the live feed:
//   - shop_wide (owner/manager/front-desk) → every staff-relevant event
//   - mechanic → only events directed at that mechanic
// Read-only; carries `status` so the UI can render an Open/Resolved pill.
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 40;
const HISTORY_STAFF_CATEGORIES = [
  ...STAFF_CATEGORIES,
  ...MECHANIC_CATEGORIES,
] as readonly string[];

export const getShopStaffNotificationHistory = query({
  args: {},
  handler: async (ctx) => {
    const scope = await getCurrentNotificationScope(ctx);
    if (!scope) return [];

    const rows = await ctx.db
      .query("notification_outbox")
      .withIndex("by_shop_id", (q: any) => q.eq("shop_id", scope.shopId))
      .collect();

    let filtered: any[];
    if (scope.kind === "mechanic") {
      filtered = rows.filter(
        (r: any) =>
          r.mechanic_id != null &&
          String(r.mechanic_id) === String(scope.mechanicId) &&
          MECHANIC_CATEGORIES.includes(r.category),
      );
    } else {
      filtered = rows.filter((r: any) =>
        HISTORY_STAFF_CATEGORIES.includes(r.category),
      );
    }

    const sorted = filtered
      .sort((a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0))
      .slice(0, HISTORY_LIMIT);

    const enriched = await Promise.all(
      sorted.map(async (row: any) => {
        let customerName: string | null = null;
        let vehicleLabel: string | null = null;
        let shortHandle: string | null = null;
        let scheduledDate: string | null = null;
        let scheduledTime: string | null = null;

        if (row.booking_id) {
          const booking: any = await ctx.db.get(row.booking_id);
          if (booking) {
            scheduledDate = booking.scheduled_date ?? null;
            scheduledTime = booking.scheduled_time ?? null;
            const inv = (booking.invoice_number ?? "").trim();
            shortHandle = inv
              ? inv.startsWith("#")
                ? inv
                : `#${inv}`
              : `#${String(booking._id).slice(-6).toUpperCase()}`;
            if (booking.user_id) {
              const cust: any = await ctx.db.get(booking.user_id);
              const composed = [cust?.first_name, cust?.last_name]
                .filter(Boolean)
                .join(" ");
              customerName =
                cust?.name ||
                (composed.length > 0 ? composed : null) ||
                cust?.email ||
                null;
            }
            if (booking.vehicle_id) {
              const veh: any = await ctx.db.get(booking.vehicle_id);
              if (veh) {
                const meta = veh.metadata ?? {};
                const parts = [
                  veh.year ?? meta.year,
                  meta.make,
                  meta.model,
                ].filter(Boolean);
                vehicleLabel =
                  parts.length > 0
                    ? parts.join(" ")
                    : veh.vin
                      ? `VIN …${String(veh.vin).slice(-6)}`
                      : null;
              }
            }
          }
        }

        return {
          _id: row._id,
          category: row.category as string,
          channel: row.channel as string,
          booking_id: row.booking_id ?? null,
          shop_id: row.shop_id ?? null,
          created_at: row.created_at,
          processed_at: row.processed_at ?? null,
          // Open vs resolved is the RESOLVE axis now, independent of delivery
          // status: resolved_at == null → still open.
          resolved_at: row.resolved_at ?? null,
          status: row.status as string,
          customerName,
          vehicleLabel,
          shortHandle,
          scheduledDate,
          scheduledTime,
        };
      }),
    );

    return enriched;
  },
});

export const markShopStaffNotificationRead = mutation({
  args: { notificationId: v.id("notification_outbox") },
  handler: async (ctx, args) => {
    const info = await getShopMembership(ctx);
    if (!info) throw new Error("Your session has expired. Please sign in again.");

    const row = await ctx.db.get(args.notificationId);
    if (!row) return;
    if (String((row as any).shop_id) !== String(info.membership.shop_id)) {
      throw new Error("Not your notification");
    }

    // Staff "mark read" dismisses the alert from the live feed — resolve it.
    const now = Date.now();
    await ctx.db.patch(args.notificationId, {
      status: "resolved",
      read_at: now,
      resolved_at: now,
      resolved_reason: "user_action",
      processed_at: now,
      updated_at: now,
    } as any);
  },
});

export const markShopNotificationsReadForBooking = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const info = await getShopMembership(ctx);
    if (!info) return;

    const rows = await ctx.db
      .query("notification_outbox")
      .withIndex("by_booking_id", (q: any) =>
        q.eq("booking_id", args.bookingId),
      )
      .collect();

    const now = Date.now();
    await Promise.all(
      rows
        .filter(
          (r: any) =>
            r.resolved_at == null &&
            String(r.shop_id) === String(info.membership.shop_id) &&
            (STAFF_CATEGORIES as readonly string[]).includes(r.category),
        )
        .map((r: any) =>
          ctx.db.patch(r._id, {
            status: "resolved",
            read_at: now,
            resolved_at: now,
            resolved_reason: "user_action",
            processed_at: now,
            updated_at: now,
          } as any),
        ),
    );
  },
});

export const markNotificationRead = mutation({
  args: { notificationId: v.id("notification_outbox") },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Your session has expired. Please sign in again.");

    const row = await ctx.db.get(args.notificationId);
    if (!row) return;
    if ((row as any).user_id !== user._id) {
      throw new Error("Not your notification");
    }

    // Mark SEEN — not resolved. The row stays in the feed (styled read) until
    // it's resolved by an action (resolveNotification) or a booking state
    // change. Idempotent.
    if ((row as any).read_at != null) return;
    const now = Date.now();
    await ctx.db.patch(args.notificationId, {
      read_at: now,
      updated_at: now,
    } as any);
  },
});

/**
 * Customer resolves (archives) a notification — either after completing its
 * action or dismissing an informational one. Sets the RESOLVE axis so the row
 * drops out of the feed; also stamps read_at if it wasn't already seen.
 */
export const resolveNotification = mutation({
  args: { notificationId: v.id("notification_outbox") },
  handler: async (ctx, args) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Your session has expired. Please sign in again.");

    const row = await ctx.db.get(args.notificationId);
    if (!row) return;
    if ((row as any).user_id !== user._id) {
      throw new Error("Not your notification");
    }
    if ((row as any).resolved_at != null) return;

    const now = Date.now();
    await ctx.db.patch(args.notificationId, {
      status: "resolved",
      read_at: (row as any).read_at ?? now,
      resolved_at: now,
      resolved_reason: "user_action",
      processed_at: now,
      updated_at: now,
    } as any);
  },
});
