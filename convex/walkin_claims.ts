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
import { action, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { isPseudoVin } from "./lib/vinIdentity";

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
/**
 * Resolve a tracker link to the job it points at.
 *
 * ONE resolver for every entry point — `resolveClaimToken`, `getTrackerData`,
 * `_vinForClaimToken` and `claimByToken` all used to re-derive this, and each
 * copy of "most recent walk-in for this user" is a place they can disagree
 * about which job a link means.
 *
 * Two schemes, checked in order:
 *
 *  1. `bookings.tracker_token` — the current one. Points at exactly one job,
 *     which is what makes a link stable for a customer with several walk-ins
 *     open at the same shop.
 *  2. `users.claim_token` — legacy, kept because links are already out there
 *     in customers' text messages. Resolves to their most recent walk-in,
 *     which is what it always did. It expires on its own; nothing to migrate.
 */
type TokenTarget =
  | { kind: "expired" }
  | { kind: "unknown" }
  | { kind: "ok"; booking: any | null; user: Doc<"users">; legacy: boolean };

async function resolveTrackerToken(ctx: any, token: string): Promise<TokenTarget> {
  if (!token) return { kind: "unknown" };
  const now = Date.now();

  const booking = await ctx.db
    .query("bookings")
    .withIndex("by_tracker_token", (q: any) => q.eq("tracker_token", token))
    .first();
  if (booking) {
    const expiresAt = (booking as any).tracker_token_expires_at as number | undefined;
    if (!expiresAt || expiresAt < now) return { kind: "expired" };
    const user = (await ctx.db.get((booking as any).user_id)) as Doc<"users"> | null;
    if (!user) return { kind: "unknown" };
    return { kind: "ok", booking, user, legacy: false };
  }

  const user = await ctx.db
    .query("users")
    .withIndex("by_claim_token", (q: any) => q.eq("claim_token", token))
    .first();
  if (!user) return { kind: "unknown" };
  const expiresAt = (user as any).claim_token_expires_at as number | undefined;
  if (!expiresAt || expiresAt < now) return { kind: "expired" };

  const recent = await ctx.db
    .query("bookings")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
    .order("desc")
    .take(5);
  const walkin = recent.find((b: any) => b.source === "mechanic_walk_in") ?? null;
  return { kind: "ok", booking: walkin, user, legacy: true };
}

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

    // A customer who already has an Otopair account STILL gets a link.
    //
    // This used to return `{ token: null }` for them, and the portal rendered
    // "No tracker link — they'll see this booking the next time they open the
    // app". Ahmad, 2026-09-10: "obviously we need one even for existing
    // users." He is right — "next time they open the app" is a hope, not a
    // handoff, and the link is the only thing a mechanic can actually give
    // someone standing at the counter.
    //
    // For them the link is a TRACKER link rather than a claim: the account
    // exists, the job is already theirs, and `claimByToken` no-ops. For a
    // shop-built stub it is both.
    const now = Date.now();
    const existing = (booking as any).tracker_token as string | undefined;
    const existingExpiry = (booking as any).tracker_token_expires_at as number | undefined;
    // Idempotent, like the user-level mint it replaces: re-sending a booking's
    // link must not invalidate the one already in the customer's messages.
    if (existing && existingExpiry && existingExpiry > now) {
      return { token: existing, expiresAtMs: existingExpiry };
    }

    const token = randomToken();
    const expiresAtMs = now + CLAIM_TOKEN_TTL_MS;
    await ctx.db.patch(args.bookingId, {
      tracker_token: token,
      tracker_token_expires_at: expiresAtMs,
    } as any);

    // Also seed the account-claim token when the customer has no account yet,
    // so the claim path keeps working exactly as before.
    if (!(user as any).walkInClaimedAt) {
      await mintClaimToken(ctx, userId);
    }

    return { token, expiresAtMs };
  },
});

export const resolveClaimToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const target = await resolveTrackerToken(ctx, args.token);
    if (target.kind === "unknown") return null;
    if (target.kind === "expired") return { expired: true } as const;
    const { user } = target;
    const walkin = target.booking;

    // `alreadyClaimed` is a FLAG now, not a dead end.
    //
    // It used to short-circuit to `{ alreadyClaimed: true }` and nothing else,
    // and the app rendered that as "This job is already claimed. Sign in and
    // you'll find it in your Garage." — a wall, for the customer whose job it
    // actually is. They still get the full payload; the flag only tells the
    // app to take them to the tracker instead of through a claim flow they
    // have no need for.
    const alreadyClaimed = Boolean((user as any).walkInClaimedAt);

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
      alreadyClaimed,
      email: (user as any).email ?? null,
      // E.164 phone the shop already has on file — the mobile claim flow
      // masks it on the verify-phone screen. Null when the shop never
      // captured a number.
      phone: (user as any).phone ?? null,
      firstName: (user as any).first_name ?? null,
      lastName: (user as any).last_name ?? null,
      shopName,
      vehicleSummary,
      // True when the shop entered this car without a valid VIN, so it's living
      // on a placeholder identity (Off-Catalog Work spec, §5). The claim page can
      // set the expectation before sign-up; the actual repair happens afterwards
      // through walkinVinRepair.submitVinForMyVehicle, which needs an
      // authenticated owner to authorise it.
      //
      // Deliberately not a blocker on claiming — a driver who skips it still gets
      // their account and their history. The car just stays on a placeholder
      // until someone supplies the VIN.
      vehicleNeedsVin: walkin?.vin ? isPseudoVin(walkin.vin) : false,
    };
  },
});

/**
 * Public query for the read-only walk-in tracker. Returns the booking's
 * current live_stage plus a timeline derived from the booking timestamps we
 * already write (created_at, vehicle_arrived_at_ms, completed_at_ms) — no new
 * tables, no auth.
 *
 * Response shape is small on purpose: the tracker link is shareable and
 * bystander-safe, so it never leaks PII beyond what the customer already knows
 * about their own visit (their first name, their car, the shop, the mechanic
 * assigned). The VIN in particular stays server-side — see _vinForClaimToken.
 */
export const getTrackerData = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const target = await resolveTrackerToken(ctx, args.token);
    if (target.kind === "unknown") return null;
    if (target.kind === "expired") return { expired: true } as const;
    const { user } = target;
    // A booking-scoped token names its job outright. The legacy user-scoped
    // one falls back to the most recent walk-in, and non-walk-in bookings
    // still must not reach the tracker URL — that contract is inside
    // `resolveTrackerToken`.
    const booking = target.booking as any;
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
    // Cached VDB photo. The VIN itself stays server-side — the tracker link is
    // shareable, so a bystander shouldn't get a full VIN — but the image it
    // resolves to is safe to hand out. Falls back to the YMMT-level cache on
    // vehicle_configs, so a Malibu whose own row has no photo yet can borrow
    // one already fetched for the same year/make/model/trim.
    let imageUrl: string | null = null;
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
        imageUrl = (veh as any).image_url ?? null;
        if (!imageUrl) {
          const configId = (veh as any).vehicle_config_id;
          const configRow = configId ? await ctx.db.get(configId) : null;
          imageUrl = (configRow as any)?.image_url ?? null;
        }
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
    // client renders these as the stepper in the design.
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
        imageUrl,
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

/**
 * The VIN behind a claim token, for server-side use only. Never returned to a
 * client — `getTrackerData` deliberately withholds it because the tracker link
 * is shareable, and a full VIN is more than a bystander should get.
 */
export const _vinForClaimToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const target = await resolveTrackerToken(ctx, args.token);
    if (target.kind !== "ok") return null;
    const booking = target.booking as any;
    if (!booking?.vin) return null;

    const veh = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
      .first();
    return {
      vin: booking.vin as string,
      year: (veh as any)?.year ?? undefined,
      make: (veh as any)?.metadata?.make ?? undefined,
      model: (veh as any)?.metadata?.model ?? undefined,
      trim: (veh as any)?.metadata?.trim ?? undefined,
    };
  },
});

/**
 * Fetch and cache the car's photo for a claim token.
 *
 * The app can't do this itself: VDB needs either the VIN or a verbose trim
 * string, and the tracker payload carries neither. This resolves the VIN
 * server-side and hands it to the existing `resolveVehicleImage`, which checks
 * both cache levels before touching VDB and writes the result back to the
 * vehicle row — so `getTrackerData.vehicle.imageUrl` populates and every later
 * read is a cache hit.
 *
 * Public because the walk-in has no account yet. The token is the capability,
 * same as the rest of this module.
 */
export const ensureTrackerImage = action({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const info: any = await ctx.runQuery(
      (internal as any).walkin_claims._vinForClaimToken,
      { token: args.token },
    );
    if (!info?.vin) return null;
    return await ctx.runAction(
      (internal as any).lib.vehicle_image.resolveVehicleImage,
      { vin: info.vin, year: info.year, make: info.make, model: info.model, trim: info.trim },
    );
  },
});

/**
 * Claim a walk-in onto the CURRENTLY SIGNED-IN account.
 *
 * The gap this fills. `users.getOrCreateMe` adopts a stub only when it is
 * inserting a brand-new user — that covers a customer who has never used
 * Otopair. It does nothing for someone who ALREADY has an account, because
 * that mutation finds them by `clerkUserId` and returns before it ever looks
 * for a stub. And an existing customer is the ordinary case: they walk into a
 * shop, the shop takes a name and phone that don't match what Otopair holds,
 * so a fresh stub is created alongside their real account.
 *
 * Ahmad, 2026-09-07: signed in already, followed the claim link, landed on the
 * Cars tab with no new car. `(walk-in)/create-account.tsx` bounces a signed-in
 * user straight to the garage, so nothing was ever claimed.
 *
 * Adoption cannot be used here. It patches the stub's `clerkUserId` to the real
 * one, and the real account already holds that value — `by_clerkUserId` is read
 * with `.unique()`, so a second row carrying it makes every one of those reads
 * throw. This MERGES instead: the stub's rows are repointed at the signed-in
 * user and the stub is retired.
 */
export const claimByToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const me = await currentUser(ctx);
    if (!me) throw new Error("Not authenticated");

    // Accepts either token scheme — a booking-scoped tracker link or a legacy
    // user-scoped claim link. `resolveTrackerToken` is the single place that
    // knows the difference.
    const target = await resolveTrackerToken(ctx, args.token);
    if (target.kind === "unknown") return { ok: false as const, reason: "not_found" as const };
    if (target.kind === "expired") return { ok: false as const, reason: "expired" as const };
    const stub = target.user;

    // The car this link is about. Returned so the app can open the garage ON
    // that vehicle instead of whichever one happens to be primary.
    //
    // `getTrackerData` deliberately withholds the VIN — that query is public
    // and the link is shareable, so a bystander must not get one. Here the
    // caller is authenticated AND owns the booking, so there is nothing to
    // withhold.
    const vin = ((target.booking as any)?.vin as string | undefined) ?? null;

    // Already on this account — the deep link was opened twice, the signup
    // path adopted it first, or this is a returning customer opening a tracker
    // link for a job that was always theirs. Not an error; nothing to move.
    if (stub._id === me._id) return { ok: true as const, alreadyMine: true as const, vin };

    const now = Date.now();
    // A stub this caller has ALREADY absorbed can be merged again.
    //
    // Retiring a stub leaves the row in place, and the shop portal's customer
    // lookup still finds it by phone or email — so a later walk-in for the
    // same person can land on it before `createByShop` learns to follow the
    // forwarding pointer. Refusing here would strand that job on a dead row
    // with no way back. Merging again is idempotent and lands it where it
    // belongs.
    //
    // Scoped to the caller it was merged INTO, so this is not a general
    // re-claim: anyone else still gets `already_claimed`.
    const mergedInto = (stub as any).merged_into_user_id as Id<"users"> | undefined;
    const isRepeatForSameOwner = mergedInto === me._id;
    if ((stub as any).walkInClaimedAt && !isRepeatForSameOwner) {
      return { ok: false as const, reason: "already_claimed" as const };
    }
    // Only a shop-built stub is ever mergeable. Without this the token would be
    // a way to absorb a real person's account into your own.
    if (!String(stub.clerkUserId ?? "").startsWith("shop-created-")) {
      return { ok: false as const, reason: "not_claimable" as const };
    }

    // ── Vehicles ────────────────────────────────────────────────────────────
    // Repointed rather than recreated, so the maintenance_records hanging off
    // each `vehicle_owners._id` come across with the car.
    const stubOwnerships = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", stub._id))
      .collect();

    let vehiclesMoved = 0;
    for (const ownership of stubOwnerships) {
      const mine = await ctx.db
        .query("vehicle_owners")
        .withIndex("by_vin_user", (q: any) =>
          q.eq("vin", ownership.vin).eq("user_id", me._id),
        )
        .first();
      if (mine) {
        // The car is already in their garage. Retiring the stub's row rather
        // than moving it keeps the carousel from showing the same VIN twice;
        // the driver's own row is the one with their history on it.
        await ctx.db.patch(ownership._id, { status: "inactive" } as any);
        continue;
      }
      await ctx.db.patch(ownership._id, {
        user_id: me._id,
        // Never steal primary from a car they already had.
        is_primary: stubOwnerships.length > 0 && (await hasNoActiveVehicles(ctx, me._id)),
      } as any);
      vehiclesMoved++;
    }

    // ── Bookings ────────────────────────────────────────────────────────────
    const stubBookings = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", stub._id))
      .collect();
    for (const booking of stubBookings) {
      await ctx.db.patch(booking._id, { user_id: me._id } as any);
    }

    // ── Retire the stub ─────────────────────────────────────────────────────
    // Kept, not deleted: it may be referenced by rows this merge does not know
    // about, and a dangling id is worse than a parked row. The token is cleared
    // so the link cannot be replayed onto a different account.
    await ctx.db.patch(stub._id, {
      walkInClaimedAt: now,
      claim_token: undefined,
      claim_token_expires_at: undefined,
      isPendingDeletion: true,
      // Where the customer actually lives now. `createByShop` follows this so
      // their next walk-in never lands back on this row.
      merged_into_user_id: me._id,
      lastUpdated: now,
    } as any);

    return {
      ok: true as const,
      vin,
      vehiclesMoved,
      bookingsMoved: stubBookings.length,
    };
  },
});

/** True when the user has no active vehicle yet, so a merged-in car is allowed
 *  to become their primary. */
async function hasNoActiveVehicles(ctx: any, userId: Id<"users">): Promise<boolean> {
  const existing = await ctx.db
    .query("vehicle_owners")
    .withIndex("by_user_status", (q: any) => q.eq("user_id", userId).eq("status", "active"))
    .first();
  return !existing;
}
