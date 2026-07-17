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
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";
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
  services: string[];
  scheduledDate: string | null;
  created: number;
  total: number | null;
  laborCost: number | null;
  partsCost: number | null;
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

// -----------------------------------------------------------------------------
// Detail tab 4 — Money. Payments (payments.by_user_id) + user-facing
// transactions ledger (transactions.by_user_id_created_at desc) — support
// sees exactly what the user sees in-app.
// -----------------------------------------------------------------------------
export const money = query({
  args: { token: v.string(), id: v.id("users") },
  handler: async (ctx, { token, id }): Promise<OpsUserMoneyResult> => {
    await requireDirector(ctx, token);

    const [payments, transactions] = await Promise.all([
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
    ]);

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
    };
  },
});
