// =============================================================================
// Oto AI — Due Services query
// =============================================================================
//
// Backs the `get_due_services` AI tool. Reads vehicle_service_states (the
// maintenance pipeline's per-service projections) for the active vehicle and
// returns the overdue + due-soon rows joined with the services catalog.
//
// Mirrors the same id-resolution pattern as vehicleHealth.ts: the AI tool's
// `vehicle_id` arg is a Convex `vehicles._id` (NOT a VIN), resolved via
// ctx.db.get → vehicle.vin + user._id → vehicle_owners row.
//
// Skips rows where `is_applicable === false` (e.g. timing-belt on a
// chain-driven engine). Sort: overdue first, then by due_at_date ascending,
// then urgency_score descending.
// =============================================================================

import { query } from "../_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";

export interface OtoDueService {
  service_slug: string | null;
  service_name: string;
  urgency: string;
  due_at_mileage: number | null;
  due_at_date: number | null;
  last_service_mileage: number | null;
  last_service_date: number | null;
}

const URGENCY_RANK: Record<string, number> = {
  overdue: 0,
  due_soon: 1,
  ok: 2,
};

export const getDueServices = query({
  args: { vehicle_id: v.string() },
  handler: async (ctx, { vehicle_id }): Promise<OtoDueService[]> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");

    const user: Doc<"users"> | null = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("user not found in Convex");

    const vehicle: Doc<"vehicles"> | null = await ctx.db.get(
      vehicle_id as Id<"vehicles">,
    );
    if (!vehicle) throw new Error(`vehicle not found: ${vehicle_id}`);

    const owner: Doc<"vehicle_owners"> | null = await ctx.db
      .query("vehicle_owners")
      .withIndex("by_vin_user", (q: any) =>
        q.eq("vin", vehicle.vin).eq("user_id", user._id),
      )
      .unique();
    if (!owner) throw new Error(`vehicle_owner not found for vehicle ${vehicle_id}`);

    const states = await ctx.db
      .query("vehicle_service_states")
      .withIndex("by_vehicle_owner", (q: any) => q.eq("vehicle_owner_id", owner._id))
      .collect();

    // Filter: applicable services with non-ok urgency only. The chat AI is
    // surfacing "what needs attention" — surfacing on_time rows is just noise.
    const filtered = states.filter((s) => {
      if (s.is_applicable === false) return false;
      const u = (s.urgency || "").toLowerCase();
      return u === "overdue" || u === "due_soon";
    });

    filtered.sort((a, b) => {
      const ra = URGENCY_RANK[(a.urgency || "").toLowerCase()] ?? 9;
      const rb = URGENCY_RANK[(b.urgency || "").toLowerCase()] ?? 9;
      if (ra !== rb) return ra - rb;
      const da = a.due_at_date ?? Number.MAX_SAFE_INTEGER;
      const db = b.due_at_date ?? Number.MAX_SAFE_INTEGER;
      if (da !== db) return da - db;
      // urgency_score is descending = more urgent first
      return (b.urgency_score ?? 0) - (a.urgency_score ?? 0);
    });

    return await Promise.all(
      filtered.map(async (s) => {
        const svc: Doc<"services"> | null = await ctx.db.get(s.service_id);
        return {
          service_slug: svc?.slug ?? null,
          service_name: svc?.name ?? "Unknown service",
          urgency: (s.urgency || "unknown").toLowerCase(),
          due_at_mileage: s.due_at_mileage ?? null,
          due_at_date: s.due_at_date ?? null,
          last_service_mileage: s.last_service_mileage ?? null,
          last_service_date: s.last_service_date ?? null,
        };
      }),
    );
  },
});
