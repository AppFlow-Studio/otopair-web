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
import { action, internalQuery, query } from "./_generated/server";
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
    if (!args.token) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_claim_token", (q: any) => q.eq("claim_token", args.token))
      .first();
    if (!user) return null;
    const recent = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .order("desc")
      .take(5);
    const booking = recent.find((b: any) => b.source === "mechanic_walk_in") as any;
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
