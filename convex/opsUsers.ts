// =============================================================================
// Ops portal — Users list + detail (read-only, P0).
//
// Every query validates the director session via requireDirector (server-side
// token gate; Next.js middleware is not a security boundary for direct Convex
// calls). No mutations live here — deletion restore/processing belongs to the
// Deletion Queue page's module.
//
// Read strategy per build conventions:
//  - users table measured at 22 rows → .order("desc").take(200) window.
//  - Per-user reads use indexes (vehicle_owners.by_user_id, bookings.by_user_id,
//    payments.by_user_id, transactions.by_user_id_created_at) — bounded per
//    user on this deployment.
// =============================================================================
import { v } from "convex/values";
import { query, action, internalQuery, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { requireDirector } from "./directorGate";
import {
  metaMakeModel,
  resolveVehicleDisplay,
  resolveVehicleDisplayById,
} from "./lib/bookingEnrichment";
import {
  summarizeOtoActions,
  resolveBookingOutcome,
  type OtoAction,
  type OtoBookingOutcome,
} from "./lib/otoActivity";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// --- Authored return types -----------------------------------------------------
// Explicit handler return types are load-bearing (see convex/backfillTires.ts
// _listCandidates): without them TS must infer each handler while resolving the
// whole ApiFromModules barrel, which exhausts the checker's instantiation budget
// and silently degrades api.* types to `any` in consumer files.

export type OnboardingState = "completed" | "in_progress" | "tell_us_pending";

export type OpsUserListRow = {
  id: Id<"users">;
  name: string;
  username: string | null;
  email: string | null;
  emailConfirmed: boolean;
  phone: string | null;
  phoneVerified: boolean;
  vehicles: number;
  bookings: number;
  created: number;
  lastActive: number | null;
  onboarding: OnboardingState;
  isPendingDeletion: boolean;
  authProvider: string | null;
  acquisitionSource: string | null;
  /** Lifetime captured spend (dollars). */
  spend: number;
  /** Primary vehicle "year make model" (or first active), for garage context. */
  primaryVehicle: string | null;
};

export type OpsUserProfile = {
  id: Id<"users">;
  name: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  email: string | null;
  emailConfirmed: boolean;
  phone: string | null;
  phoneVerified: boolean;
  photoUrl: string | null;
  authProvider: string | null;
  acquisitionSource: string | null;
  walkInClaimedAt: number | null;
  pushRegistered: boolean;
  pushTokenUpdatedAt: number | null;
  clerkUserId: string;
  language: string | null;
  units: string | null;
  role: string;
  onboarding: OnboardingState;
  onboardingCompleted: boolean;
  essentialOnboardingCompleted: boolean;
  tellUsAboutCompleted: boolean;
  stripeCustomerId: string | null;
  created: number;
  lastUpdated: number | null;
  isPendingDeletion: boolean;
  deletionRequestedAt: number | null;
  deletionSurveyResponse: string | null;
  deletionSurveySkipped: boolean;
};

export type OpsGarageRow = {
  ownerId: Id<"vehicle_owners">;
  vehicleId: Id<"vehicles"> | null;
  vin: string;
  status: string;
  nickname: string | null;
  isPrimary: boolean;
  imageUrl: string | null;
  year: number | null;
  ymm: string;
  trim: string | null;
  engine: string | null;
  mileage: number | null;
  mileageSource: string | null;
  mileageUpdatedAt: number | null;
  addedAt: number;
  removedAt: number | null;
  avgMonthlyDriving: string | null;
  drivingConditions: string | null;
  healthScore: number | null;
  onboardingComplete: boolean;
  vehicleMode: string | null;
  ownerSegment: string | null;
};

export type OpsUserBookingRow = {
  id: Id<"bookings">;
  status: string;
  shop: string;
  shop_id: string | null;
  vehicleYmm: string | null;
  services: string[];
  scheduledDate: string | null;
  created: number;
  total: number | null;
  laborCost: number | null;
  partsCost: number | null;
};

export type OpsUserOtoConversation = {
  id: string;
  started_at: number;
  message_count: number | null;
  mood: string | null;
  vehicleYmm: string | null;
  led_to_booking: boolean;
  bookingOutcome: OtoBookingOutcome;
  actions: OtoAction[];
};

export type OpsUserEngagement = {
  // Notification preferences (from user_settings_preferences.notification_preferences,
  // an unstructured blob) normalized to display rows + push registration.
  notifications: {
    entries: { key: string; enabled: boolean | null; value: string | null }[];
    hasPreferencesRow: boolean;
  };
  pushRegistered: boolean;
  pushTokenUpdatedAt: number | null;
  // Acquisition: how this account originated + referral attribution.
  authProvider: string | null;
  acquisitionSource: string | null;
  walkInClaimedAt: number | null;
  // The referral that brought this user in (they are the referee), if any.
  referredBy: {
    code: string | null;
    status: string;
    referrerId: Id<"users"> | null;
    referrerName: string | null;
    createdAt: number;
    creditedAt: number | null;
  } | null;
  // Referrals this user has made (they are the referrer).
  referralsMade: { total: number; credited: number; pending: number };
  // Saved addresses (home/work/other).
  savedAddresses: {
    id: string;
    type: string;
    label: string;
    address: string;
    isPrimary: boolean;
  }[];
  // Favorited / hidden mechanics.
  mechanicPreferences: {
    id: string;
    mechanicId: string;
    mechanic: string | null;
    isFavorite: boolean;
    isHidden: boolean;
  }[];
  // Onboarding answers (car-knowledge level + intent).
  onboarding: {
    carKnowledgeLevel: string | null;
    hasAnswers: boolean;
    hasIntentions: boolean;
    lastUpdated: number | null;
  } | null;
};

export type OpsUserMoneyResult = {
  payments: {
    id: Id<"payments">;
    bookingId: Id<"bookings">;
    amount: number;
    capturedAmountCents: number | null;
    holdAmountCents: number | null;
    status: string;
    method: string | null;
    origin: string | null;
    stripePaymentIntentId: string | null;
    invoiceNumber: string | null;
    created: number;
  }[];
  transactions: {
    id: Id<"transactions">;
    created: number;
    description: string;
    subDescription: string | null;
    amount: number;
    status: string;
    type: string;
    iconType: string | null;
    bookingId: Id<"bookings"> | null;
  }[];
  // Lifetime money rollups computed from the fetched windows.
  rollups: {
    capturedTotal: number; // dollars captured across payments
    paymentCount: number;
    avgTicket: number | null;
    refundTotal: number; // dollars refunded (negative ledger rows, abs)
    refundRate: number | null; // refundTotal / capturedTotal
  };
  // Loyalty / ownership-credit ledger.
  credits: {
    id: Id<"ownership_credit_transactions">;
    amount: number;
    type: string;
    description: string | null;
    created: number;
    expiresAt: number | null;
  }[];
  creditBalance: number;
};

export type OpsUserFootprint = {
  reviews: {
    id: string;
    rating: number;
    comment: string | null;
    shop: string | null;
    shopId: string | null;
    hidden: boolean;
    at: number;
  }[];
  disputes: {
    id: string;
    bookingId: string;
    reason: string;
    status: string;
    resolution: string | null;
    refund: number | null; // dollars
    filedAt: number;
    resolvedAt: number | null;
  }[];
};

function fullName(u: Doc<"users">): string {
  return `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || u.email || "Unknown";
}

/** Spec §5.2 onboarding pill: Completed / In progress / Tell-us pending. */
function onboardingState(u: Doc<"users">): "completed" | "in_progress" | "tell_us_pending" {
  if (u.onboardingCompleted) return "completed";
  if (u.essentialOnboardingCompleted && !u.tellUsAboutCompleted) return "tell_us_pending";
  return "in_progress";
}

/** Resolve "year make model trim" for a vehicle row (trims→models→makes). */
async function resolveSpecLine(
  ctx: QueryCtx,
  vehicle: Doc<"vehicles"> | null,
): Promise<{ ymm: string; trim: string | null; engine: string | null }> {
  if (!vehicle) return { ymm: "", trim: null, engine: null };
  let makeName: string | undefined;
  let modelName: string | undefined;
  let trimName: string | undefined;
  if (vehicle.trim_id) {
    const trim = await ctx.db.get(vehicle.trim_id);
    if (trim) {
      trimName = trim.name;
      const model = await ctx.db.get(trim.model_id);
      if (model) {
        modelName = model.name;
        const make = await ctx.db.get(model.make_id);
        makeName = make?.name;
      }
    }
  }
  // Manually-input vehicles carry make/model on metadata, not a trim_id chain.
  if (!makeName || !modelName) {
    const meta = metaMakeModel(vehicle.metadata);
    if (!makeName) makeName = meta.make || undefined;
    if (!modelName) modelName = meta.model || undefined;
    if (!trimName) trimName = meta.trim || undefined;
  }
  let engine: string | null = null;
  if (vehicle.engine_id) {
    const e = await ctx.db.get(vehicle.engine_id);
    if (e) {
      engine =
        [
          e.displacement_liters != null ? `${e.displacement_liters}L` : null,
          e.cylinders != null ? `${e.cylinders}-cyl` : null,
          e.engine_code ?? null,
        ]
          .filter(Boolean)
          .join(" ") || null;
    }
  }
  const ymm = [vehicle.year, makeName, modelName].filter(Boolean).join(" ");
  return { ymm, trim: trimName ?? null, engine };
}

/**
 * Lifetime captured spend (dollars) for a user — the money-tab `capturedTotal`
 * rollup factored out so the Users list and the deletion queue can surface a
 * spend figure. Prefers `captured_amount_cents`, else counts succeeded rows.
 */
export async function capturedTotalForUser(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<number> {
  const payments = await ctx.db
    .query("payments")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();
  return payments.reduce((s, p) => {
    if (p.captured_amount_cents != null) return s + p.captured_amount_cents / 100;
    const isCaptured = ["succeeded", "captured", "paid", "completed"].includes(p.status);
    return s + (isCaptured ? p.amount : 0);
  }, 0);
}

// -----------------------------------------------------------------------------
// List — /ops/users (T2). One row per user with vehicle/booking counts.
// -----------------------------------------------------------------------------
export const list = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<OpsUserListRow[]> => {
    await requireDirector(ctx, token);
    const users = await ctx.db.query("users").order("desc").take(200);

    return Promise.all(
      users.map(async (u) => {
        const [owners, bookings] = await Promise.all([
          ctx.db
            .query("vehicle_owners")
            .withIndex("by_user_status", (q) => q.eq("user_id", u._id).eq("status", "active"))
            .collect(),
          ctx.db
            .query("bookings")
            .withIndex("by_user_id", (q) => q.eq("user_id", u._id))
            .collect(),
        ]);
        // Spend + primary vehicle for garage/money context on the row.
        const primaryOwner = owners.find((o) => o.is_primary) ?? owners[0] ?? null;
        const [spend, primaryVeh] = await Promise.all([
          capturedTotalForUser(ctx, u._id),
          primaryOwner ? resolveVehicleDisplay(ctx, primaryOwner.vin) : Promise.resolve(null),
        ]);
        return {
          id: u._id,
          name: fullName(u),
          username: u.username ?? null,
          email: u.email ?? null,
          emailConfirmed: u.emailConfirmed ?? false,
          phone: u.phone ?? null,
          phoneVerified: u.phoneVerified ?? false,
          vehicles: owners.length,
          bookings: bookings.length,
          created: u.createdAt ?? u._creationTime,
          lastActive: u.lastUpdated ?? null,
          onboarding: onboardingState(u),
          isPendingDeletion: u.isPendingDeletion ?? false,
          authProvider: u.auth_provider ?? null,
          acquisitionSource: u.acquisition_source ?? null,
          spend,
          primaryVehicle: primaryVeh?.ymm ?? null,
        };
      }),
    );
  },
});

// -----------------------------------------------------------------------------
// Detail tab 1 — Profile. User fields + deletion state.
// -----------------------------------------------------------------------------
export const profile = query({
  args: { token: v.string(), id: v.id("users") },
  handler: async (ctx, { token, id }): Promise<OpsUserProfile | null> => {
    await requireDirector(ctx, token);
    const u = await ctx.db.get(id);
    if (!u) return null;
    return {
      id: u._id,
      name: fullName(u),
      firstName: u.first_name ?? null,
      lastName: u.last_name ?? null,
      username: u.username ?? null,
      email: u.email ?? null,
      emailConfirmed: u.emailConfirmed ?? false,
      phone: u.phone ?? null,
      phoneVerified: u.phoneVerified ?? false,
      photoUrl: u.profile_photo_url ?? null,
      authProvider: u.auth_provider ?? null,
      acquisitionSource: u.acquisition_source ?? null,
      walkInClaimedAt: u.walkInClaimedAt ?? null,
      pushRegistered: u.push_token != null,
      pushTokenUpdatedAt: u.push_token_updated_at_ms ?? null,
      clerkUserId: u.clerkUserId,
      language: u.language ?? null,
      units: u.units ?? null,
      role: u.role ?? "user",
      onboarding: onboardingState(u),
      onboardingCompleted: u.onboardingCompleted ?? false,
      essentialOnboardingCompleted: u.essentialOnboardingCompleted ?? false,
      tellUsAboutCompleted: u.tellUsAboutCompleted ?? false,
      stripeCustomerId: u.stripe_customer_id ?? null,
      created: u.createdAt ?? u._creationTime,
      lastUpdated: u.lastUpdated ?? null,
      // Deletion state (restore action lives on the Deletion Queue page).
      isPendingDeletion: u.isPendingDeletion ?? false,
      deletionRequestedAt: u.deletionRequestedAt ?? null,
      deletionSurveyResponse: u.deletionSurveyResponse ?? null,
      deletionSurveySkipped: u.deletionSurveySkipped ?? false,
    };
  },
});

// -----------------------------------------------------------------------------
// Detail tab 2 — Garage. vehicle_owners by_user_id (active + removed shown
// separately client-side), vehicles resolved through trims→models→makes.
// -----------------------------------------------------------------------------
export const garage = query({
  args: { token: v.string(), id: v.id("users") },
  handler: async (ctx, { token, id }): Promise<OpsGarageRow[]> => {
    await requireDirector(ctx, token);
    const owners = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_user_id", (q) => q.eq("user_id", id))
      .collect();

    return Promise.all(
      owners.map(async (o) => {
        const vehicle = await ctx.db
          .query("vehicles")
          .withIndex("by_vin", (q) => q.eq("vin", o.vin))
          .first();
        const spec = await resolveSpecLine(ctx, vehicle);
        return {
          ownerId: o._id,
          vehicleId: vehicle?._id ?? null,
          vin: o.vin,
          status: o.status,
          nickname: o.nickname ?? null,
          isPrimary: o.is_primary ?? false,
          imageUrl: vehicle?.image_url ?? null,
          year: vehicle?.year ?? null,
          ymm: spec.ymm || o.vin,
          trim: spec.trim,
          engine: spec.engine,
          mileage: o.mileage ?? null,
          mileageSource: o.mileage_source ?? null,
          mileageUpdatedAt: o.mileage_updated_at ?? null,
          addedAt: o.added_at ?? o._creationTime,
          removedAt: o.removed_at ?? null,
          avgMonthlyDriving: o.avgMonthlyDriving ?? null,
          drivingConditions: o.drivingConditions ?? null,
          healthScore: o.health_score ?? null,
          onboardingComplete: o.onboardingComplete ?? false,
          vehicleMode: o.vehicle_mode ?? null,
          ownerSegment: o.owner_segment ?? null,
        };
      }),
    );
  },
});

// -----------------------------------------------------------------------------
// Detail tab 3 — Bookings. bookings.by_user_id desc, shop + services resolved.
// -----------------------------------------------------------------------------
export const bookings = query({
  args: { token: v.string(), id: v.id("users") },
  handler: async (ctx, { token, id }): Promise<OpsUserBookingRow[]> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("bookings")
      .withIndex("by_user_id", (q) => q.eq("user_id", id))
      .order("desc")
      .take(100);

    // Resolve each DISTINCT vin once (a user reuses the same car across bookings)
    // through the shared resolver — so the Bookings tab shows which car, with the
    // manual-entry metadata fallback applied like every other ops surface.
    const distinctVins = [
      ...new Set(rows.map((b) => b.vin).filter((v): v is string => !!v)),
    ];
    const vehByVin = new Map<string, string | null>();
    await Promise.all(
      distinctVins.map(async (vin) => {
        vehByVin.set(vin, (await resolveVehicleDisplay(ctx, vin)).ymm);
      }),
    );

    return Promise.all(
      rows.map(async (b) => {
        const shop = b.shop_id ? await ctx.db.get(b.shop_id) : null;
        const services = (
          await Promise.all(
            (b.service_ids ?? []).map(async (sid: Id<"services">) => {
              const s = await ctx.db.get(sid);
              return s?.name ?? null;
            }),
          )
        ).filter((n): n is string => n !== null);
        return {
          id: b._id,
          status: b.status,
          shop: shop?.name ?? "—",
          shop_id: b.shop_id ? String(b.shop_id) : null,
          vehicleYmm: b.vin ? (vehByVin.get(b.vin) ?? null) : null,
          services,
          scheduledDate: b.scheduled_date ?? null,
          created: b.created_at ?? b._creationTime,
          total: b.total_cost ?? null,
          laborCost: b.labor_cost ?? null,
          partsCost: b.parts_cost ?? null,
        };
      }),
    );
  },
});

// Recent Oto conversations for this user, enriched with the vehicle display,
// what Oto DID (summarizeOtoActions), and the booking outcome — the same
// shared surfacing as /ops/oto-ai, so the user profile shows recent
// conversations + actions in one place. Capped tight (per-conversation audit
// + telemetry reads) since this is an on-demand profile tab.
export const otoConversations = query({
  args: { token: v.string(), id: v.id("users") },
  handler: async (ctx, { token, id }): Promise<OpsUserOtoConversation[]> => {
    await requireDirector(ctx, token);
    const convos = await ctx.db
      .query("ai_conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", id))
      .order("desc")
      .take(12);

    const vehById = new Map<string, string | null>();
    return Promise.all(
      convos.map(async (c) => {
        let vehicleYmm: string | null = null;
        if (c.vehicle_id) {
          const key = String(c.vehicle_id);
          if (!vehById.has(key)) {
            vehById.set(key, (await resolveVehicleDisplayById(ctx, c.vehicle_id)).ymm);
          }
          vehicleYmm = vehById.get(key) ?? null;
        }
        const [audit, telemetry] = await Promise.all([
          ctx.db
            .query("conversation_audit")
            .withIndex("by_conversation_turn", (q) => q.eq("conversation_id", c._id))
            .take(200),
          ctx.db
            .query("oto_telemetry")
            .withIndex("by_conversation_id", (q) => q.eq("conversation_id", c._id))
            .take(200),
        ]);
        const actions = summarizeOtoActions(audit, telemetry);
        const bookingOutcome = await resolveBookingOutcome(ctx, c, actions);
        return {
          id: String(c._id),
          started_at: c.started_at,
          message_count: c.message_count ?? null,
          mood: c.mood ?? null,
          vehicleYmm,
          led_to_booking: c.led_to_booking === true,
          bookingOutcome,
          actions,
        };
      }),
    );
  },
});

// -----------------------------------------------------------------------------
// Detail tab 4 — Money. Payments (payments.by_user_id) + user-facing
// transactions ledger (transactions.by_user_id_created_at desc) — support
// sees exactly what the user sees in-app.
// -----------------------------------------------------------------------------
export const money = query({
  args: { token: v.string(), id: v.id("users") },
  handler: async (ctx, { token, id }): Promise<OpsUserMoneyResult> => {
    await requireDirector(ctx, token);

    const [payments, transactions, creditRows] = await Promise.all([
      ctx.db
        .query("payments")
        .withIndex("by_user_id", (q) => q.eq("user_id", id))
        .order("desc")
        .take(100),
      ctx.db
        .query("transactions")
        .withIndex("by_user_id_created_at", (q) => q.eq("user_id", id))
        .order("desc")
        .take(100),
      ctx.db
        .query("ownership_credit_transactions")
        .withIndex("by_user_id_created_at", (q) => q.eq("user_id", id))
        .order("desc")
        .take(100),
    ]);
    const creditBalance = creditRows.reduce((s, c) => s + c.amount, 0);

    // Rollups: captured $ (prefer captured_amount_cents, else amount for
    // succeeded rows), refunds from negative ledger rows.
    const capturedTotal = payments.reduce((s, p) => {
      const isCaptured = ["succeeded", "captured", "paid", "completed"].includes(p.status);
      if (p.captured_amount_cents != null) return s + p.captured_amount_cents / 100;
      return s + (isCaptured ? p.amount : 0);
    }, 0);
    const capturedCount = payments.filter((p) =>
      ["succeeded", "captured", "paid", "completed"].includes(p.status),
    ).length;
    const refundTotal = transactions
      .filter((t) => t.amount < 0)
      .reduce((s, t) => s + Math.abs(t.amount), 0);

    return {
      payments: payments.map((p) => ({
        id: p._id,
        bookingId: p.booking_id,
        amount: p.amount, // dollars
        capturedAmountCents: p.captured_amount_cents ?? null,
        holdAmountCents: p.hold_amount_cents ?? null,
        status: p.status,
        method: p.payment_method ?? null,
        origin: p.payment_origin ?? null,
        stripePaymentIntentId: p.stripe_payment_intent_id ?? null,
        invoiceNumber: p.invoice_number ?? null,
        created: p.created_at ?? p._creationTime,
      })),
      rollups: {
        capturedTotal,
        paymentCount: payments.length,
        avgTicket: capturedCount > 0 ? capturedTotal / capturedCount : null,
        refundTotal,
        refundRate: capturedTotal > 0 ? refundTotal / capturedTotal : null,
      },
      transactions: transactions.map((t) => ({
        id: t._id,
        created: t.created_at,
        description: t.description,
        subDescription: t.sub_description ?? null,
        amount: t.amount,
        status: t.status,
        type: t.transaction_type,
        iconType: t.icon_type ?? null,
        bookingId: t.booking_id ?? null,
      })),
      credits: creditRows.map((c) => ({
        id: c._id,
        amount: c.amount,
        type: c.type,
        description: c.description ?? null,
        created: c.created_at ?? c._creationTime,
        expiresAt: c.expires_at ?? null,
      })),
      creditBalance,
    };
  },
});

// -----------------------------------------------------------------------------
// Detail — Engagement. Notification preferences (user_settings_preferences) +
// push registration + acquisition/referral attribution. Answers "how did this
// person get here, and how do we reach them" — none of which the Profile tab
// surfaced before.
// -----------------------------------------------------------------------------
/** Flatten the loose notification_preferences blob into display rows. Handles
 *  the common shapes: { push: true, sms: false, ... } or nested channel maps.
 *  Unknown shapes fall back to a single JSON value row so nothing is hidden. */
function normalizeNotificationPrefs(
  blob: unknown,
): { key: string; enabled: boolean | null; value: string | null }[] {
  if (blob == null || typeof blob !== "object") return [];
  const out: { key: string; enabled: boolean | null; value: string | null }[] = [];
  for (const [key, raw] of Object.entries(blob as Record<string, unknown>)) {
    if (typeof raw === "boolean") {
      out.push({ key, enabled: raw, value: null });
    } else if (typeof raw === "string" || typeof raw === "number") {
      out.push({ key, enabled: null, value: String(raw) });
    } else if (raw != null && typeof raw === "object") {
      // Nested channel map (e.g. { marketing: { push: true, email: false } }).
      for (const [subKey, subRaw] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof subRaw === "boolean") {
          out.push({ key: `${key}.${subKey}`, enabled: subRaw, value: null });
        } else {
          out.push({ key: `${key}.${subKey}`, enabled: null, value: String(subRaw) });
        }
      }
    }
  }
  return out;
}

export const engagement = query({
  args: { token: v.string(), id: v.id("users") },
  handler: async (ctx, { token, id }): Promise<OpsUserEngagement | null> => {
    await requireDirector(ctx, token);
    const u = await ctx.db.get(id);
    if (!u) return null;

    const [prefsRow, referredByRow, referralsMade, addressRows, mechPrefRows, onboardingRow] =
      await Promise.all([
        ctx.db
          .query("user_settings_preferences")
          .withIndex("by_user_id", (q) => q.eq("user_id", id))
          .first(),
        ctx.db
          .query("referrals")
          .withIndex("by_referee", (q) => q.eq("referee_user_id", id))
          .first(),
        ctx.db
          .query("referrals")
          .withIndex("by_referrer", (q) => q.eq("referrer_user_id", id))
          .collect(),
        ctx.db
          .query("user_saved_addresses")
          .withIndex("by_user_id", (q) => q.eq("user_id", id))
          .collect(),
        ctx.db
          .query("user_mechanic_preferences")
          .withIndex("by_user_id", (q) => q.eq("user_id", id))
          .collect(),
        ctx.db
          .query("onboarding_questions_answers")
          .withIndex("by_user_id", (q) => q.eq("user_id", id))
          .first(),
      ]);

    const mechanicPreferences = await Promise.all(
      mechPrefRows.map(async (m) => {
        const mech = await ctx.db.get(m.mechanic_id);
        const mo = mech as { first_name?: string; last_name?: string } | null;
        return {
          id: String(m._id),
          mechanicId: String(m.mechanic_id),
          mechanic: mo ? [mo.first_name, mo.last_name].filter(Boolean).join(" ") || null : null,
          isFavorite: m.is_favorite === true,
          isHidden: m.is_hidden === true,
        };
      }),
    );

    let referredBy: OpsUserEngagement["referredBy"] = null;
    if (referredByRow) {
      const referrer = await ctx.db.get(referredByRow.referrer_user_id);
      referredBy = {
        code: referredByRow.code_used ?? null,
        status: referredByRow.status,
        referrerId: referredByRow.referrer_user_id,
        referrerName: referrer ? fullName(referrer) : null,
        createdAt: referredByRow.created_at,
        creditedAt: referredByRow.credited_at ?? null,
      };
    }

    return {
      notifications: {
        entries: normalizeNotificationPrefs(prefsRow?.notification_preferences),
        hasPreferencesRow: prefsRow != null,
      },
      pushRegistered: u.push_token != null,
      pushTokenUpdatedAt: u.push_token_updated_at_ms ?? null,
      authProvider: u.auth_provider ?? null,
      acquisitionSource: u.acquisition_source ?? null,
      walkInClaimedAt: u.walkInClaimedAt ?? null,
      referredBy,
      referralsMade: {
        total: referralsMade.length,
        credited: referralsMade.filter((r) => r.status === "credited").length,
        pending: referralsMade.filter((r) => r.status === "pending").length,
      },
      savedAddresses: addressRows.map((a) => ({
        id: String(a._id),
        type: a.type,
        label: a.label,
        address: a.address,
        isPrimary: a.is_primary === true,
      })),
      mechanicPreferences,
      onboarding: onboardingRow
        ? {
            carKnowledgeLevel:
              onboardingRow.car_knowledge_level != null
                ? String(onboardingRow.car_knowledge_level)
                : null,
            hasAnswers: onboardingRow.questions_and_answers != null,
            hasIntentions: onboardingRow.user_intentions != null,
            lastUpdated: onboardingRow.last_updated ?? null,
          }
        : null,
    };
  },
});

// -----------------------------------------------------------------------------
// Detail — Footprint. Reviews this user has written + disputes they've filed.
// -----------------------------------------------------------------------------
export const footprint = query({
  args: { token: v.string(), id: v.id("users") },
  handler: async (ctx, { token, id }): Promise<OpsUserFootprint> => {
    await requireDirector(ctx, token);
    const [reviews, disputes] = await Promise.all([
      ctx.db
        .query("reviews")
        .withIndex("by_user_id", (q) => q.eq("user_id", id))
        .order("desc")
        .take(100),
      ctx.db
        .query("booking_disputes")
        .withIndex("by_user_id", (q) => q.eq("user_id", id))
        .order("desc")
        .take(100),
    ]);

    const shopName = new Map<string, string | null>();
    const reviewRows = await Promise.all(
      reviews.map(async (r) => {
        const sid = String(r.shop_id);
        if (!shopName.has(sid)) {
          const s = await ctx.db.get(r.shop_id);
          shopName.set(sid, (s as { name?: string } | null)?.name ?? null);
        }
        return {
          id: String(r._id),
          rating: r.rating,
          comment: r.comment ?? null,
          shop: shopName.get(sid) ?? null,
          shopId: sid,
          hidden: r.hidden_at != null,
          at: r.created_at ?? r._creationTime,
        };
      }),
    );

    return {
      reviews: reviewRows,
      disputes: disputes.map((d) => ({
        id: String(d._id),
        bookingId: String(d.booking_id),
        reason: d.reason,
        status: d.status,
        resolution: d.resolution ?? null,
        refund: d.resolution_refund_cents != null ? d.resolution_refund_cents / 100 : null,
        filedAt: d.filed_at_ms,
        resolvedAt: d.resolved_at_ms ?? null,
      })),
    };
  },
});

// -----------------------------------------------------------------------------
// Detail — Vehicle records. All the per-vehicle history that was dark until now:
// maintenance, odometer, documents, inspections, health, classification,
// driving profile, service states, and check-ins. Lazy-loaded when a garage
// card is expanded. Keyed by vehicle_owner_id (most tables), vin (inspections),
// and vin+user_id (health points) — see the schema field-name gotchas.
// -----------------------------------------------------------------------------
export const vehicleRecords = query({
  args: {
    token: v.string(),
    userId: v.id("users"),
    ownerId: v.id("vehicle_owners"),
    vin: v.string(),
  },
  handler: async (ctx, { token, userId, ownerId, vin }) => {
    await requireDirector(ctx, token);

    const [
      maintenance,
      odometer,
      documentRows,
      inspectionRows,
      healthPoints,
      snapshots,
      classifications,
      drivingProfile,
      serviceStateRows,
      checkins,
    ] = await Promise.all([
      ctx.db.query("maintenance_records").withIndex("by_vehicle_owner", (q) => q.eq("vehicleOwnerId", ownerId)).collect(),
      ctx.db.query("odometer_history").withIndex("by_vehicle_and_date", (q) => q.eq("vehicleOwnerId", ownerId)).order("desc").take(20),
      ctx.db.query("vehicle_documents").withIndex("by_vehicle_owner", (q) => q.eq("vehicle_owner_id", ownerId)).collect(),
      ctx.db.query("vehicle_inspections").withIndex("by_vin", (q) => q.eq("vin", vin)).order("desc").take(20),
      ctx.db.query("vehicle_health_points").withIndex("by_vin_user", (q) => q.eq("vin", vin).eq("user_id", userId)).first(),
      ctx.db.query("vehicle_health_snapshots").withIndex("by_vehicle_owner", (q) => q.eq("vehicleOwnerId", ownerId)).order("desc").take(20),
      ctx.db.query("vehicle_classifications").withIndex("by_vehicle_owner", (q) => q.eq("vehicle_owner_id", ownerId)).collect(),
      ctx.db.query("vehicle_driving_profiles").withIndex("by_vehicle_owner", (q) => q.eq("vehicle_owner_id", ownerId)).first(),
      ctx.db.query("vehicle_service_states").withIndex("by_vehicle_owner", (q) => q.eq("vehicle_owner_id", ownerId)).collect(),
      ctx.db.query("vehicle_checkins").withIndex("by_vehicle_owner_completed", (q) => q.eq("vehicle_owner_id", ownerId)).order("desc").take(20),
    ]);

    // Resolve document + inspection storage ids to URLs.
    const documents = await Promise.all(
      documentRows
        .sort((a, b) => b.uploaded_at - a.uploaded_at)
        .map(async (d) => ({
          id: String(d._id),
          filename: d.original_filename,
          mimeType: d.mime_type,
          source: d.source,
          parseStatus: d.parse_status,
          uploadedAt: d.uploaded_at,
          url: await ctx.storage.getUrl(d.storage_id),
        })),
    );
    const inspections = await Promise.all(
      inspectionRows.map(async (i) => ({
        id: String(i._id),
        bookingId: String(i.booking_id),
        templateVersion: i.template_version,
        attention: (i.findings_attention ?? []).length,
        monitor: (i.findings_monitor ?? []).length,
        createdAt: i.created_at,
        pdfUrl: i.pdf_storage_id ? await ctx.storage.getUrl(i.pdf_storage_id) : null,
      })),
    );

    // Latest classification (prefer active, else newest computed).
    const classification =
      classifications.sort(
        (a, b) =>
          (b.status === "active" ? 1 : 0) - (a.status === "active" ? 1 : 0) ||
          (b.computed_at ?? 0) - (a.computed_at ?? 0),
      )[0] ?? null;

    // Surfaced service states, service names resolved.
    const svcName = new Map<string, string>();
    const serviceStates = await Promise.all(
      serviceStateRows
        .filter((s) => s.is_surfaced !== false)
        .slice(0, 30)
        .map(async (s) => {
          const key = String(s.service_id);
          if (!svcName.has(key)) {
            const svc = await ctx.db.get(s.service_id);
            svcName.set(key, svc?.name ?? "(service)");
          }
          return {
            service: svcName.get(key) ?? "(service)",
            urgency: s.urgency ?? null,
            dueAtMileage: s.due_at_mileage ?? null,
            dueAtDate: s.due_at_date ?? null,
          };
        }),
    );

    return {
      maintenance: maintenance.map((m) => ({
        id: String(m._id),
        type: m.type,
        lastServiceDate: m.lastServiceDate != null ? String(m.lastServiceDate) : null,
        lastServiceMileage: m.lastServiceMileage ?? null,
        serviceSource: m.serviceSource ?? null,
        confidence: m.confidence ?? null,
      })),
      odometer: odometer.map((o) => ({
        id: String(o._id),
        distance: o.distance,
        unit: o.unit,
        recordedAt: o.recordedAt,
      })),
      documents,
      inspections,
      healthPoints: healthPoints ? { points: healthPoints.points, updatedAt: healthPoints.updated_at } : null,
      snapshots: snapshots.map((s) => ({
        id: String(s._id),
        type: s.snapshotType,
        source: s.source ?? null,
        recordedAt: s.recordedAt,
      })),
      classification: classification
        ? {
            vehicleMode: classification.vehicle_mode,
            ownerSegment: classification.owner_segment ?? null,
            annualMileage: classification.annual_mileage_estimated ?? null,
            status: classification.status ?? null,
            computedAt: classification.computed_at ?? null,
          }
        : null,
      drivingProfile: drivingProfile
        ? {
            currentMileage: drivingProfile.current_mileage ?? null,
            annualMileageBand: drivingProfile.annual_mileage_band ?? null,
            usagePattern: drivingProfile.usage_pattern ?? null,
            ownershipDuration: drivingProfile.ownership_duration ?? null,
            lastServiceWhat: Array.isArray(drivingProfile.last_service_what)
              ? drivingProfile.last_service_what.join(", ")
              : drivingProfile.last_service_what ?? null,
          }
        : null,
      serviceStates,
      checkins: checkins.map((c) => ({
        id: String(c._id),
        status: c.status ?? null,
        mileageReported: c.mileage_reported ?? null,
        symptoms: c.symptoms_text ?? null,
        completedAt: c.completed_at ?? null,
      })),
    };
  },
});

// =============================================================================
// Signup-method backfill — the Clerk webhook now persists auth_provider going
// forward, but existing users predate that. This one-shot, director-gated
// action fetches each user's Clerk record (raw Backend API + CLERK_SECRET_KEY,
// the same access pattern as convex/cleanup.ts) and derives the provider.
// =============================================================================

/** Real-Clerk users still missing a signup method (stub ids are skipped — they
 *  have no Clerk record to fetch). */
export const usersMissingAuthProvider = internalQuery({
  args: { limit: v.number() },
  handler: async (
    ctx,
    { limit },
  ): Promise<{ id: Id<"users">; clerkUserId: string }[]> => {
    const users = await ctx.db.query("users").order("desc").take(2000);
    return users
      .filter(
        (u) =>
          !u.auth_provider &&
          u.clerkUserId &&
          !u.clerkUserId.startsWith("shop-created-") &&
          !u.clerkUserId.startsWith("presignup-"),
      )
      .slice(0, limit)
      .map((u) => ({ id: u._id, clerkUserId: u.clerkUserId }));
  },
});

/** First-touch patch — only sets auth_provider if still empty. */
export const setAuthProvider = internalMutation({
  args: { id: v.id("users"), authProvider: v.string() },
  handler: async (ctx, { id, authProvider }) => {
    const u = await ctx.db.get(id);
    if (u && !u.auth_provider) {
      await ctx.db.patch(id, { auth_provider: authProvider });
    }
  },
});

export const logAuthProviderBackfill = internalMutation({
  args: {
    actorId: v.id("director_users"),
    actorName: v.string(),
    scanned: v.number(),
    updated: v.number(),
  },
  handler: async (ctx, { actorId, actorName, scanned, updated }) => {
    await ctx.db.insert("audit_log", {
      entity_type: "system",
      entity_id: "auth_provider_backfill",
      action: "backfill_auth_providers",
      actor: actorName,
      actor_id: actorId,
      detail: `Backfilled signup method for ${updated}/${scanned} users via Clerk API`,
      created_at: Date.now(),
    });
  },
});

export const backfillAuthProviders = action({
  args: { token: v.string(), limit: v.optional(v.number()) },
  handler: async (
    ctx,
    { token, limit },
  ): Promise<{ scanned: number; updated: number; skipped: number }> => {
    const session = await ctx.runQuery(api.director_auth.validateSession, { token });
    if (!session) throw new Error("unauthorized: invalid or expired director session");
    const secret = process.env.CLERK_SECRET_KEY;
    if (!secret) throw new Error("CLERK_SECRET_KEY not set in Convex env");

    const users = await ctx.runQuery(internal.opsUsers.usersMissingAuthProvider, {
      limit: Math.min(500, Math.max(1, limit ?? 200)),
    });

    let updated = 0;
    let skipped = 0;
    for (const u of users) {
      try {
        const res = await fetch(`https://api.clerk.com/v1/users/${u.clerkUserId}`, {
          headers: { Authorization: `Bearer ${secret}` },
        });
        if (!res.ok) {
          skipped++;
          continue;
        }
        const data = (await res.json()) as {
          external_accounts?: { provider?: string }[];
          password_enabled?: boolean;
          phone_numbers?: unknown[];
        };
        const ext = data.external_accounts?.[0]?.provider;
        const provider = ext
          ? String(ext)
          : data.password_enabled
            ? "password"
            : data.phone_numbers?.length
              ? "phone"
              : null;
        if (!provider) {
          skipped++;
          continue;
        }
        await ctx.runMutation(internal.opsUsers.setAuthProvider, {
          id: u.id,
          authProvider: provider,
        });
        updated++;
      } catch {
        skipped++;
      }
    }

    await ctx.runMutation(internal.opsUsers.logAuthProviderBackfill, {
      actorId: session.userId,
      actorName: session.name,
      scanned: users.length,
      updated,
    });
    return { scanned: users.length, updated, skipped };
  },
});
