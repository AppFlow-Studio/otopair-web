/**
 * Multi-point inspection — read + owner-profile write helpers.
 *
 * The inspection itself is persisted through bookings.startWithPrejob /
 * savePrejob / commitInspectionAndAwaitEstimate (which upsert vehicle_inspections
 * alongside the derived prejob_report). This module adds:
 *   - getByBooking            — load a saved inspection for resume / PDF.
 *   - deleteInspectionPhoto   — remove a zone association and storage object.
 *   - getOwnerProfileForBooking — the booking customer's owner record, so the
 *                                 OWNER zone can compute which onboarding
 *                                 questions were SKIPPED.
 *   - saveOwnerProfileAnswers  — mechanic-scoped write of those skipped answers
 *                                 back onto the customer's vehicle_owners row.
 *
 * onboarding_questions_answers.saveQuestionAnswer is ctx.auth/current-user only
 * (it writes for the signed-in user). Here the signed-in user is the MECHANIC
 * writing for the CUSTOMER, so we need a user_id-targeted mutation guarded by
 * shop-staff membership.
 */

import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  formatZonesForPdf,
  INSPECTION_TEMPLATE_VERSION,
} from "../lib/inspection-template";
import { OWNER_PROFILE_QUESTIONS } from "../lib/owner-profile-questions";
import { jobRecommendationInputValidator } from "./lib/vehicle_passports";
import { submitRecommendationsForBooking } from "./jobRecommendations";

// ---------------------------------------------------------------------------
// Auth helpers (inline — mirrors the pattern used across convex modules).
// ---------------------------------------------------------------------------

async function getCurrentUser(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Your session has expired. Please sign in again.");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
    .unique();
  if (!user) throw new Error("We couldn't find your account. Try signing in again.");
  return user;
}

async function requireShopStaff(ctx: any, userId: any, shopId: any) {
  const shopUser = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", userId).eq("shop_id", shopId),
    )
    .first();
  if (shopUser && shopUser.is_active) return shopUser;

  const ownedShop = await ctx.db
    .query("shops")
    .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", userId))
    .filter((q: any) => q.eq(q.field("_id"), shopId))
    .first();
  if (ownedShop) return { user_id: userId, shop_id: shopId, role: "owner", is_active: true };

  throw new Error("Not authorized for this shop");
}

async function findOwnerForBooking(ctx: any, booking: any) {
  // Prefer the exact vin+user pairing; fall back to any owner row for this user.
  const byVinUser = await ctx.db
    .query("vehicle_owners")
    .withIndex("by_vin_user", (q: any) =>
      q.eq("vin", booking.vin).eq("user_id", booking.user_id),
    )
    .first();
  if (byVinUser) return byVinUser;

  return await ctx.db
    .query("vehicle_owners")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", booking.user_id))
    .first();
}

// Fields the OWNER zone may write. Mirrors lib/owner-profile-questions.ts keys.
const OWNER_PROFILE_FIELDS = [
  "ownershipType",
  "ownedSinceNew",
  "annualMileageBand",
  "usagePattern",
  "lastServiceWhen",
  "lastServiceWhat",
  "garageRole",
  "knownIssues",
] as const;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const getByBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const inspection = await ctx.db
      .query("vehicle_inspections")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", args.bookingId))
      .first();
    if (!inspection) return null;

    const storageIds = Array.from(
      new Set(inspection.zones.flatMap((zone) => zone.photo_ids ?? [])),
    );
    const photo_urls = Object.fromEntries(
      await Promise.all(
        storageIds.map(async (storageId) => [
          storageId,
          await ctx.storage.getUrl(storageId),
        ]),
      ),
    );
    return { ...inspection, photo_urls };
  },
});

/**
 * Returns the booking customer's owner-profile fields so the dialog can compute
 * which onboarding questions were skipped. Only the relevant subset is exposed.
 */
export const getOwnerProfileForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const owner = await findOwnerForBooking(ctx, booking);
    if (!owner) return {} as Record<string, unknown>;

    const out: Record<string, unknown> = {};
    for (const key of OWNER_PROFILE_FIELDS) {
      out[key] = (owner as any)[key] ?? null;
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const inspectionPhotoZoneValidator = v.union(
  v.literal("FL"),
  v.literal("FR"),
  v.literal("RL"),
  v.literal("RR"),
  v.literal("ENG"),
  v.literal("FRT"),
  v.literal("UND"),
);

const PHOTO_UPLOAD_WINDOW_MS = 10 * 60 * 1000;
const PHOTO_UPLOAD_TOKEN_KEY = "_inspection_photo_upload_token";
const PHOTO_UPLOAD_STARTED_KEY = "_inspection_photo_upload_started_at";
const PHOTO_UPLOAD_USER_KEY = "_inspection_photo_upload_user_id";

function withoutPhotoUploadGrant(
  select: Record<string, unknown> | null | undefined,
) {
  const next = { ...(select ?? {}) };
  delete next[PHOTO_UPLOAD_TOKEN_KEY];
  delete next[PHOTO_UPLOAD_STARTED_KEY];
  delete next[PHOTO_UPLOAD_USER_KEY];
  return next;
}

function hasValidPhotoUploadGrant(
  zone: { select?: unknown },
  userId: unknown,
  uploadToken: string,
  storageCreatedAt: number,
) {
  const select = (zone.select ?? {}) as Record<string, unknown>;
  const startedAt = select[PHOTO_UPLOAD_STARTED_KEY];
  return (
    select[PHOTO_UPLOAD_TOKEN_KEY] === uploadToken &&
    select[PHOTO_UPLOAD_USER_KEY] === String(userId) &&
    typeof startedAt === "number" &&
    Date.now() - startedAt <= PHOTO_UPLOAD_WINDOW_MS &&
    storageCreatedAt >= startedAt
  );
}

export const prepareInspectionPhotoUpload = mutation({
  args: {
    bookingId: v.id("bookings"),
    zoneId: inspectionPhotoZoneValidator,
    uploadToken: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking.");
    await requireShopStaff(ctx, user._id, booking.shop_id);
    if (!args.uploadToken.trim()) throw new Error("Invalid photo upload token.");

    const inspection = await ctx.db
      .query("vehicle_inspections")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", args.bookingId))
      .first();
    const now = Date.now();
    const grant = {
      [PHOTO_UPLOAD_TOKEN_KEY]: args.uploadToken,
      [PHOTO_UPLOAD_STARTED_KEY]: now,
      [PHOTO_UPLOAD_USER_KEY]: String(user._id),
    };
    if (!inspection) {
      await ctx.db.insert("vehicle_inspections", {
        booking_id: args.bookingId,
        vin: booking.vin,
        shop_id: booking.shop_id,
        mechanic_id: booking.mechanic_id,
        template_version: INSPECTION_TEMPLATE_VERSION,
        zones: [
          {
            zone_id: args.zoneId,
            done: false,
            select: grant,
          },
        ],
        findings_attention: [],
        findings_monitor: [],
        created_at: now,
        updated_at: now,
      });
    } else {
      const existingZone = inspection.zones.find(
        (zone) => zone.zone_id === args.zoneId,
      );
      const zones = existingZone
        ? inspection.zones.map((zone) =>
            zone.zone_id === args.zoneId
              ? {
                  ...zone,
                  select: {
                    ...((zone.select ?? {}) as Record<string, unknown>),
                    ...grant,
                  },
                }
              : zone,
          )
        : [
            ...inspection.zones,
            {
              zone_id: args.zoneId,
              done: false,
              select: grant,
            },
          ];
      await ctx.db.patch(inspection._id, { zones, updated_at: now });
    }
    return await ctx.storage.generateUploadUrl();
  },
});

export const attachInspectionPhoto = mutation({
  args: {
    bookingId: v.id("bookings"),
    zoneId: inspectionPhotoZoneValidator,
    storageId: v.id("_storage"),
    uploadToken: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking.");
    await requireShopStaff(ctx, user._id, booking.shop_id);
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (!metadata) {
      throw new Error("We couldn't find that uploaded photo.");
    }

    const inspection = await ctx.db
      .query("vehicle_inspections")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", args.bookingId))
      .first();
    const zone = inspection?.zones.find(
      (item) => item.zone_id === args.zoneId,
    );
    if (
      !inspection ||
      !zone ||
      !hasValidPhotoUploadGrant(
        zone,
        user._id,
        args.uploadToken,
        metadata._creationTime,
      )
    ) {
      throw new Error("That upload is not authorized for this inspection.");
    }
    const alreadyAssociated = (
      await ctx.db.query("vehicle_inspections").collect()
    ).some((candidate) =>
      candidate.zones.some((candidateZone) =>
        (candidateZone.photo_ids ?? []).includes(args.storageId),
      ),
    );
    if (alreadyAssociated) {
      throw new Error("That photo is already attached to an inspection.");
    }
    const now = Date.now();
    const zones = inspection.zones.map((item) =>
      item.zone_id === args.zoneId
        ? {
            ...item,
            done: false,
            select: withoutPhotoUploadGrant(
              (item.select ?? {}) as Record<string, unknown>,
            ),
            photo_ids: Array.from(
              new Set([...(item.photo_ids ?? []), args.storageId]),
            ),
          }
        : item,
    );
    await ctx.db.patch(inspection._id, { zones, updated_at: now });
  },
});

export const deleteInspectionPhoto = mutation({
  args: {
    bookingId: v.id("bookings"),
    storageId: v.id("_storage"),
    zoneId: v.optional(inspectionPhotoZoneValidator),
    uploadToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const inspection = await ctx.db
      .query("vehicle_inspections")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", args.bookingId))
      .first();
    const belongsToBooking = inspection?.zones.some((zone) =>
      (zone.photo_ids ?? []).includes(args.storageId),
    );
    if (!inspection || !belongsToBooking) {
      const metadata = await ctx.db.system.get("_storage", args.storageId);
      const pendingZone = inspection?.zones.find(
        (zone) => zone.zone_id === args.zoneId,
      );
      if (
        !metadata ||
        !pendingZone ||
        !args.uploadToken ||
        !hasValidPhotoUploadGrant(
          pendingZone,
          user._id,
          args.uploadToken,
          metadata._creationTime,
        )
      ) {
        throw new Error("That photo does not belong to this inspection.");
      }
      if (!inspection) {
        throw new Error("That photo does not belong to this inspection.");
      }
      const associatedElsewhere = (
        await ctx.db.query("vehicle_inspections").collect()
      ).some((candidate) =>
        candidate.zones.some((zone) =>
          (zone.photo_ids ?? []).includes(args.storageId),
        ),
      );
      if (associatedElsewhere) {
        throw new Error("That photo belongs to another inspection.");
      }
      const zones = inspection.zones.map((zone) =>
        zone.zone_id === args.zoneId
          ? {
              ...zone,
              select: withoutPhotoUploadGrant(
                (zone.select ?? {}) as Record<string, unknown>,
              ),
            }
          : zone,
      );
      await ctx.db.patch(inspection._id, {
        zones,
        updated_at: Date.now(),
      });
      await ctx.storage.delete(args.storageId);
      return;
    }

    const zones = inspection.zones.map((zone) => ({
      ...zone,
      done: (zone.photo_ids ?? []).includes(args.storageId) ? false : zone.done,
      photo_ids: (zone.photo_ids ?? []).filter(
        (storageId) => storageId !== args.storageId,
      ),
    }));
    await ctx.db.patch(inspection._id, {
      zones,
      updated_at: Date.now(),
    });
    await ctx.storage.delete(args.storageId);
  },
});

export const saveOwnerProfileAnswers = mutation({
  args: {
    bookingId: v.id("bookings"),
    // Map of vehicle_owners field -> answer. Strings, booleans, and string
    // arrays only (matches OWNER_PROFILE_FIELDS). v.any() keeps the union loose;
    // we whitelist keys + coerce below.
    answers: v.any(),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    const answers = (args.answers ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of OWNER_PROFILE_FIELDS) {
      if (!(key in answers)) continue;
      const value = answers[key];
      if (value == null) continue;

      if (key === "lastServiceWhat") {
        // multi-select -> string[]
        const arr = Array.isArray(value)
          ? value.filter((s) => typeof s === "string")
          : [];
        if (arr.length) patch[key] = arr;
      } else if (key === "ownedSinceNew") {
        if (typeof value === "boolean") patch[key] = value;
      } else {
        // single-select / text -> non-empty string
        const str = typeof value === "string" ? value.trim() : "";
        if (str) patch[key] = str;
      }
    }

    // Mirror usagePattern into the snake-case `usage_pattern` field the
    // maintenance pipeline actually reads for the Driving Condition Modifier,
    // mapping to its vocabulary (highway / city / mixed).
    if (typeof patch.usagePattern === "string") {
      const map: Record<string, string> = {
        mostly_highway: "highway",
        mostly_local: "city",
        mixed: "mixed",
      };
      const mapped = map[patch.usagePattern as string];
      if (mapped) patch.usage_pattern = mapped;
    }

    if (Object.keys(patch).length === 0) return null;

    const owner = await findOwnerForBooking(ctx, booking);
    const now = Date.now();

    let ownerId;
    if (owner) {
      await ctx.db.patch(owner._id, patch);
      ownerId = owner._id;
    } else {
      // No owner row yet — create a minimal one tied to this customer + vehicle.
      ownerId = await ctx.db.insert("vehicle_owners", {
        vin: booking.vin,
        user_id: booking.user_id,
        status: "active",
        added_at: now,
        ...patch,
      });
    }

    // Owner-profile answers feed the VHS interval modifiers (history confidence,
    // driving condition). Recompute via a full pipeline run.
    await ctx.scheduler.runAfter(0, internal.maintenance_pipeline.runPipeline, {
      vehicleOwnerId: ownerId,
      triggeredBy: "checkin",
    });

    return ownerId;
  },
});

/**
 * Create follow-up recommendations from inspection findings. The dialog derives
 * candidate services from threshold measurements (worn pads, low tread, rotor
 * below min, weak battery), the mechanic confirms them, and they're created via
 * the same path as post-job recommendations — so dedupe, driver follow-ups, and
 * the Vehicle Health Score rec-penalty all apply automatically.
 */
export const submitInspectionRecommendations = mutation({
  args: {
    bookingId: v.id("bookings"),
    recommendations: v.array(jobRecommendationInputValidator),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("We couldn't find that booking.");
    await requireShopStaff(ctx, user._id, booking.shop_id);

    if (!booking.mechanic_id) {
      throw new Error("Assign a mechanic to this booking before adding recommendations.");
    }
    if (args.recommendations.length === 0) return [];

    // Latest job_actual for this booking (the prejob save creates one).
    const actuals = await ctx.db
      .query("job_actuals")
      .withIndex("by_booking_id", (q: any) => q.eq("booking_id", args.bookingId))
      .collect();
    const jobActual = actuals.sort(
      (a: any, b: any) => (b.created_at ?? 0) - (a.created_at ?? 0),
    )[0];
    if (!jobActual) {
      throw new Error("Save the inspection before adding recommendations.");
    }

    // Attribution shown to the driver, e.g. "Based on last inspection @ Temur Auto & Motor".
    const shop = booking.shop_id ? await ctx.db.get(booking.shop_id) : null;
    const shopName = (shop as any)?.name ?? "the shop";
    const authorLabel = `Based on last inspection @ ${shopName}`;

    return await submitRecommendationsForBooking(ctx, {
      booking: {
        _id: booking._id,
        shop_id: booking.shop_id,
        mechanic_id: booking.mechanic_id,
        vin: booking.vin,
      },
      jobActualId: jobActual._id,
      mechanicId: booking.mechanic_id,
      source: "inspection",
      authorLabel,
      recommendations: args.recommendations as any,
      now: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// PDF support — internal helpers called by convex/inspections_node.ts (the
// "use node" action that renders the inspection sheet). Mirrors the invoice
// pipeline split (assemble in V8, render in Node).
// ---------------------------------------------------------------------------

/** Authorize the action caller: must be active shop staff for this booking. */
export const _isCallerAuthorizedShopUser = internalQuery({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) return false;
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return false;
    try {
      await requireShopStaff(ctx, user._id, booking.shop_id);
      return true;
    } catch {
      return false;
    }
  },
});

export const _assembleInspectionData = internalQuery({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return null;

    const inspection = await ctx.db
      .query("vehicle_inspections")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", args.bookingId))
      .first();
    if (!inspection) return null;

    const [vehicle, passport, shop] = await Promise.all([
      ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
        .unique()
        .catch(() => null),
      ctx.db
        .query("vehicle_passports")
        .withIndex("by_vin", (q: any) => q.eq("vin", booking.vin))
        .unique()
        .catch(() => null),
      booking.shop_id ? ctx.db.get(booking.shop_id) : null,
    ]);

    const mechanic = booking.mechanic_id ? await ctx.db.get(booking.mechanic_id) : null;
    const mechanicName = mechanic
      ? [(mechanic as any).first_name, (mechanic as any).last_name]
          .filter(Boolean)
          .join(" ") || null
      : null;
    const owner = await findOwnerForBooking(ctx, booking);

    // vehicles stores make/model/trim inside the free-form `metadata` blob
    // (the typed columns are just year + the spec foreign keys).
    const meta = (vehicle as any)?.metadata ?? {};
    const vehicleLabel =
      [vehicle?.year, meta.make, meta.model, meta.trim]
        .filter(Boolean)
        .join(" ") || booking.vin;

    // Owner-profile section — only fields the customer has now answered.
    const ownerRows = OWNER_PROFILE_QUESTIONS.map((q) => {
      const raw = owner ? (owner as any)[q.key] : null;
      if (raw == null || (Array.isArray(raw) && raw.length === 0)) return null;
      let value: string;
      if (Array.isArray(raw)) {
        value = raw
          .map((v: string) => q.options?.find((o) => o.value === v)?.label ?? v)
          .join(", ");
      } else if (typeof raw === "boolean") {
        value = raw ? "Yes" : "No";
      } else {
        value = q.options?.find((o) => o.value === raw)?.label ?? String(raw);
      }
      return { label: q.question, value };
    }).filter(Boolean) as { label: string; value: string }[];

    return {
      inspectionId: inspection._id,
      vehicleLabel,
      vin: booking.vin,
      odometer:
        typeof passport?.mileage === "number" ? passport.mileage : null,
      shopName: shop?.name ?? null,
      mechanicName,
      generatedAtMs: Date.now(),
      zones: formatZonesForPdf(inspection.zones ?? []),
      ownerRows,
      findingsAttention: inspection.findings_attention ?? [],
      findingsMonitor: inspection.findings_monitor ?? [],
    };
  },
});

export const _patchInspectionPdf = internalMutation({
  args: {
    inspectionId: v.id("vehicle_inspections"),
    pdfStorageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.inspectionId, {
      pdf_storage_id: args.pdfStorageId,
      updated_at: Date.now(),
    });
  },
});
