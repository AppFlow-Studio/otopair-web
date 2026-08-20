/**
 * walkin_claims.ts — Token-based deep links for mechanic-created walk-in
 * clients to claim their pre-built Otopair account.
 *
 * mintClaimToken is a plain helper callable from inside other Convex
 * mutations (e.g. enqueueWalkinClientUpdate in bookings.ts) — it is
 * idempotent: if the user already has an unexpired token, that token is
 * reused so the same URL keeps working across multiple SMS/email sends.
 *
 * resolveClaimToken is the public query the /claim/[token] landing page
 * calls to render shop + vehicle context before handing the user off to
 * Clerk SignUp.
 */

import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

const CLAIM_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function randomToken(): string {
  // 24 random bytes → 32-char base64url (no padding).
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Idempotent: returns the existing valid token if one is set, else mints
 * a new one and patches the user row. Callable from inside any mutation
 * that has a writable ctx (no auth check — caller is responsible).
 */
export async function mintClaimToken(
  ctx: any,
  userId: Id<"users">,
): Promise<string | null> {
  const user = (await ctx.db.get(userId)) as Doc<"users"> | null;
  if (!user) return null;
  // Don't mint for already-claimed users — caller should suppress.
  if (user.walkInClaimedAt) return null;

  const now = Date.now();
  const existing = (user as any).claim_token as string | undefined;
  const expiresAt = (user as any).claim_token_expires_at as number | undefined;
  if (existing && expiresAt && expiresAt > now) {
    return existing;
  }

  const token = randomToken();
  await ctx.db.patch(userId, {
    claim_token: token,
    claim_token_expires_at: now + CLAIM_TOKEN_TTL_MS,
  } as any);
  return token;
}

// Local auth helpers — duplicated from bookings.ts/schedule.ts's pattern to
// keep this file's dependency footprint small.
async function currentUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();
}

async function requireShopStaff(ctx: any, userId: any, shopId: any) {
  const shopUser = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", userId).eq("shop_id", shopId),
    )
    .first();
  if (shopUser && shopUser.is_active) return shopUser;
  const owned = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .filter((q: any) => q.eq(q.field("_id"), shopId))
    .first();
  if (owned) return { role: "owner", is_active: true };
  throw new Error("Not authorized for this shop");
}

/**
 * Auth helper for vehicle-pipeline's shop-scoped variant. Verifies the caller
 * is shop staff for the booking's shop AND the booking is a walk-in with a
 * user_id stub attached. Returns { userId, shopId } for the action to use;
 * throws otherwise. Kept in walkin_claims.ts because the concern is walk-in
 * specific — vehicle_pipeline stays vehicle-agnostic.
 */
export const _walkinBookingCustomerForShopStaff = internalQuery({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const staff = await currentUser(ctx);
    if (!staff) throw new Error("Sign in required");
    const booking = (await ctx.db.get(args.bookingId)) as any;
    if (!booking) throw new Error("Booking not found");
    if (!booking.shop_id) throw new Error("Booking has no shop");
    await requireShopStaff(ctx, staff._id, booking.shop_id);
    if (booking.source !== "mechanic_walk_in") {
      throw new Error("Not a walk-in booking");
    }
    if (!booking.user_id) throw new Error("Booking has no customer");
    return {
      userId: booking.user_id as Id<"users">,
      shopId: booking.shop_id,
    };
  },
});

/**
 * Mint (or return) a claim token from a bookingId. Called by the walk-in
 * intake page right after createByShop lands, so the mechanic can hand the
 * customer a working /t/[token] URL before Telnyx is wired for SMS.
 *
 * Idempotent — returns the same token the next time it's called for the
 * same user_id, as long as the token hasn't expired.
 *
 * Returns { token, expiresAtMs } or throws if unauthorized / no user_id.
 * Returns { token: null } if the user has already claimed their account
 * (nothing to hand out).
 */
export const mintForBooking = mutation({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const staff = await currentUser(ctx);
    if (!staff) throw new Error("Sign in required");

    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");
    if (!(booking as any).shop_id) throw new Error("Booking has no shop");
    await requireShopStaff(ctx, staff._id, (booking as any).shop_id);

    const userId = (booking as any).user_id as Id<"users"> | undefined;
    if (!userId) throw new Error("Booking has no customer user_id");

    const user = (await ctx.db.get(userId)) as Doc<"users"> | null;
    if (!user) throw new Error("Customer user not found");
    if ((user as any).walkInClaimedAt) {
      return { token: null as string | null, expiresAtMs: null as number | null };
    }

    const token = await mintClaimToken(ctx, userId);
    if (!token) return { token: null, expiresAtMs: null };

    const refreshed = (await ctx.db.get(userId)) as Doc<"users"> | null;
    const expiresAtMs =
      (refreshed as any)?.claim_token_expires_at ?? null;
    return { token, expiresAtMs };
  },
});

export const resolveClaimToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    if (!args.token) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_claim_token", (q: any) => q.eq("claim_token", args.token))
      .first();
    if (!user) return null;

    const expiresAt = (user as any).claim_token_expires_at as number | undefined;
    if (!expiresAt || expiresAt < Date.now()) {
      return { expired: true } as const;
    }

    if ((user as any).walkInClaimedAt) {
      return { alreadyClaimed: true } as const;
    }

    // Pull the most recent walk-in booking for shop + vehicle context.
    const recentBookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .order("desc")
      .take(5);

    const walkin = recentBookings.find(
      (b: any) => b.source === "mechanic_walk_in",
    );

    let shopName: string | null = null;
    if (walkin?.shop_id) {
      const shop = await ctx.db.get(walkin.shop_id);
      shopName = (shop as any)?.name ?? null;
    }

    let vehicleSummary: string | null = null;
    if (walkin?.vin) {
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q: any) => q.eq("vin", walkin.vin))
        .first();
      if (vehicle) {
        const v: any = vehicle;
        const parts = [
          v.year,
          v.metadata?.make,
          v.metadata?.model,
          v.metadata?.trim,
        ].filter(Boolean);
        if (parts.length) vehicleSummary = parts.join(" ");
      }
    }

    return {
      email: (user as any).email ?? null,
      phone: (user as any).phone ?? null,
      firstName: (user as any).first_name ?? null,
      lastName: (user as any).last_name ?? null,
      shopName,
      vehicleSummary,
    };
  },
});

/**
 * Public query for the /t/[token] read-only tracker webview. Returns the
 * booking's current live_stage plus a timeline derived from the booking
 * timestamps we already write (created_at, vehicle_arrived_at_ms,
 * completed_at_ms) — no new tables, no auth.
 *
 * Response shape is small on purpose: the tracker page is bystander-safe
 * and shouldn't leak PII beyond what the customer already knows about
 * their own visit (their first name, their car, the shop, the mechanic
 * assigned).
 */
export const getTrackerData = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    if (!args.token) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_claim_token", (q: any) => q.eq("claim_token", args.token))
      .first();
    if (!user) return null;

    const expiresAt = (user as any).claim_token_expires_at as number | undefined;
    if (!expiresAt || expiresAt < Date.now()) {
      return { expired: true } as const;
    }

    // Most recent walk-in booking for this user. Non-walk-in bookings
    // shouldn't reach the tracker URL — this guard keeps that contract.
    const recent = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .order("desc")
      .take(5);
    const booking = recent.find(
      (b: any) => b.source === "mechanic_walk_in",
    ) as any;
    if (!booking) return null;

    // Shop
    let shopName: string | null = null;
    if (booking.shop_id) {
      const shop = await ctx.db.get(booking.shop_id);
      shopName = (shop as any)?.name ?? null;
    }

    // Vehicle — VIN table lookup so year/make/model reflect any post-booking
    // decode/enrichment updates rather than the mechanic's initial keystrokes.
    let vehicleYear: number | null = null;
    let vehicleMake: string | null = null;
    let vehicleModel: string | null = null;
    let vehicleTrim: string | null = null;
    let plateLast4: string | null = null;
    if (booking.vin) {
      const veh: any = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
        .first();
      if (veh) {
        vehicleYear = veh.year ?? null;
        vehicleMake = veh.metadata?.make ?? null;
        vehicleModel = veh.metadata?.model ?? null;
        vehicleTrim = veh.metadata?.trim ?? null;
        plateLast4 = veh.license_plate
          ? String(veh.license_plate).slice(-4)
          : null;
      }
    }

    // Primary service — first preset, else first custom.
    let primaryService: string | null = null;
    if (Array.isArray(booking.service_ids) && booking.service_ids.length > 0) {
      const svc: any = await ctx.db.get(booking.service_ids[0]);
      primaryService = svc?.name ?? null;
    } else if (
      Array.isArray(booking.custom_services) &&
      booking.custom_services.length > 0
    ) {
      primaryService = booking.custom_services[0]?.name ?? null;
    }

    // Mechanic — first name + last initial for the "who's working on it" card.
    let mechanicDisplayName: string | null = null;
    let mechanicYearsAtShop: number | null = null;
    let mechanicAseCertified: boolean = false;
    if (booking.mechanic_id) {
      const mech: any = await ctx.db.get(booking.mechanic_id);
      if (mech) {
        const first = String(mech.first_name ?? "").trim();
        const last = String(mech.last_name ?? "").trim();
        const initial = last ? `${last[0]}.` : "";
        mechanicDisplayName = [first, initial].filter(Boolean).join(" ") || null;
        mechanicAseCertified = Boolean(mech.ase_certified);
        if (mech.started_at_ms) {
          const years = Math.floor(
            (Date.now() - mech.started_at_ms) / (365.25 * 24 * 60 * 60 * 1000),
          );
          mechanicYearsAtShop = years > 0 ? years : null;
        }
      }
    }

    // ETA — scheduled_time + estimated_labor_minutes. Bystander-safe.
    let estimatedReadyIso: string | null = null;
    if (booking.scheduled_date && booking.scheduled_time && booking.estimated_labor_minutes) {
      const [y, mo, d] = String(booking.scheduled_date).split("-").map(Number);
      const [h, mi] = String(booking.scheduled_time).split(":").map(Number);
      if (y && mo && d && !Number.isNaN(h)) {
        const start = new Date(y, mo - 1, d, h, mi ?? 0).getTime();
        const end = start + booking.estimated_labor_minutes * 60_000;
        estimatedReadyIso = new Date(end).toISOString();
      }
    }

    // Timeline — derived from timestamps we already have. Each entry has
    // { key, label, atMs (null if not reached), reached }. Kept simple; the
    // web renders these as the stepper in the design.
    const now = Date.now();
    const stage = String(booking.live_stage ?? "");
    const stageReached: Record<string, boolean> = {
      created: true,
      arrived: !!booking.vehicle_arrived_at_ms,
      in_service:
        !!booking.vehicle_arrived_at_ms &&
        (stage === "service_in_progress" ||
          stage === "vehicle_ready" ||
          !!booking.completed_at_ms),
      quality_check:
        stage === "vehicle_ready" || !!booking.completed_at_ms,
      ready: !!booking.completed_at_ms,
    };
    const timeline = [
      {
        key: "created",
        label: "Booking created",
        atMs: booking.created_at ?? booking._creationTime ?? null,
        reached: stageReached.created,
      },
      {
        key: "arrived",
        label: "Checked in at the shop",
        atMs: booking.vehicle_arrived_at_ms ?? null,
        reached: stageReached.arrived,
      },
      {
        key: "in_service",
        label: primaryService
          ? `In the bay · ${primaryService.toLowerCase()}`
          : "In the bay",
        atMs: null,
        reached: stageReached.in_service,
      },
      {
        key: "quality_check",
        label: "Quality check",
        atMs: null,
        reached: stageReached.quality_check,
      },
      {
        key: "ready",
        label: "Ready for pickup",
        atMs: booking.completed_at_ms ?? null,
        reached: stageReached.ready,
      },
    ];

    const firstName = (user as any).first_name ?? null;
    const displayStatus =
      stage === "vehicle_ready" || booking.completed_at_ms
        ? "READY"
        : stage === "service_in_progress"
          ? "IN SERVICE"
          : booking.vehicle_arrived_at_ms
            ? "CHECKED IN"
            : "SCHEDULED";

    return {
      alreadyClaimed: Boolean((user as any).walkInClaimedAt),
      shopName,
      firstName,
      vehicle: {
        year: vehicleYear,
        make: vehicleMake,
        model: vehicleModel,
        trim: vehicleTrim,
        plateLast4,
      },
      primaryService,
      estimatedReadyIso,
      mechanic: mechanicDisplayName
        ? {
            displayName: mechanicDisplayName,
            aseCertified: mechanicAseCertified,
            yearsAtShop: mechanicYearsAtShop,
          }
        : null,
      displayStatus,
      timeline,
      generatedAtMs: now,
    };
  },
});
