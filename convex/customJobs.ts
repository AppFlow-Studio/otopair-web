/**
 * customJobs.ts — the extraction spine for off-catalog work (Off-Catalog Work
 * spec, §7).
 *
 * `bookings.custom_services[]` stays as the lightweight display and scheduling
 * copy of what's on a booking. This module owns the structured record behind it:
 * one `custom_jobs` row per piece of off-catalog work, carrying the two things
 * nothing else in the schema captures — the complaint that caused the work, and
 * whether the work resolved it.
 *
 * Labor minutes, prices and parts already land in labor_quote_snapshots /
 * parts_quote_snapshots. Those tables answer "how long and how much". They
 * can't answer "why", and "why" is what turns a cluster of names into a service
 * we could actually build.
 *
 * ── INVARIANT ────────────────────────────────────────────────────────────────
 * Nothing here may influence the Vehicle Health Score. No maintenance_records
 * write, no interval reset, no rec penalty. See the CUSTOM JOB INVARIANT
 * comments in bookings.ts and jobRecommendations.ts.
 */

import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  normalizeServiceName,
  serviceMatchKey,
} from "./lib/serviceMatch";
import { requireCustomJobTaxonomy } from "../lib/custom-job-taxonomy";
import { fuzzyNameSimilarity } from "./lib/fuzzyServiceName";
import {
  recordShortcutUse,
  recordShortcutActual,
} from "./shopCustomServices";

/**
 * Bump (or open) the cross-shop dedupe ledger row for a proposed service name.
 *
 * Shared by the custom-job path and the advisory-recommendation path so both
 * feed one ledger — a name typed as work-performed and the same name typed as a
 * recommendation are the same signal about a catalog gap, and splitting them
 * across two counters would understate every cluster.
 *
 * Keyed on normalizeServiceName (NOT serviceMatchKey) because that is what
 * existing rows are keyed on. See the serviceMatch.ts header.
 */
export async function bumpPendingServiceSubmission(
  ctx: any,
  args: {
    name: string;
    reason?: string | null;
    mechanicId: Id<"mechanics">;
    bookingId: Id<"bookings">;
    vin: string;
    now: number;
  },
): Promise<Id<"pending_service_submissions"> | undefined> {
  const trimmed = args.name.trim();
  if (!trimmed) return undefined;
  const normalized = normalizeServiceName(trimmed);

  const existing = await ctx.db
    .query("pending_service_submissions")
    .withIndex("by_normalized_name", (q: any) =>
      q.eq("normalized_name", normalized),
    )
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, {
      appearance_count: (existing.appearance_count ?? 0) + 1,
      last_seen_at: args.now,
    });
    return existing._id;
  }

  return await ctx.db.insert("pending_service_submissions", {
    proposed_name: trimmed,
    normalized_name: normalized,
    proposed_reason: args.reason?.trim() || undefined,
    submitted_by_mechanic_id: args.mechanicId,
    submitted_via_booking_id: args.bookingId,
    vehicle_vin: args.vin,
    appearance_count: 1,
    status: "pending",
    created_at: args.now,
    last_seen_at: args.now,
  });
}

/** Best-effort config lookup so labor/price evidence is fitment-scoped. */
async function resolveVehicleConfigId(
  ctx: any,
  vin: string,
): Promise<Id<"vehicle_configs"> | undefined> {
  if (!vin) return undefined;
  const vehicle = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", vin))
    .first();
  return (vehicle as any)?.vehicle_config_id ?? undefined;
}

export type CustomJobInput = {
  name: string;
  /** Where on the car. Ordered — [0] is the primary system. Required. */
  system_tags?: string[] | null;
  /** What was done to it. Required. */
  work_type?: string | null;
  /** Parts quoted against this line, denormalised from the booking's
   *  priced_parts_snapshot. See the schema note on custom_jobs.parts. */
  parts?: Array<{
    part_name: string;
    oem_number?: string;
    brand?: string;
    quantity: number;
    unit_price_cents?: number;
    line_total_cents?: number;
  }> | null;
  quoted_parts_cents?: number | null;
  /** Legacy catalog category. No longer collected; see schema.ts. */
  category_id?: Id<"service_categories"> | null;
  complaint?: string | null;
  estimated_minutes?: number | null;
  quoted_price_cents?: number | null;
  /** Set when the mechanic pressed a shop shortcut instead of typing. */
  shop_custom_service_id?: Id<"shop_custom_services"> | null;
};

/**
 * Create the structured rows for a booking's custom services. Called from
 * inside the booking-creation mutation so the rows and the booking land in one
 * transaction — a custom job that exists without its booking, or vice versa,
 * is a reporting lie.
 *
 * Idempotent per (booking, match_key): re-entry patches rather than duplicating,
 * so a booking edit that re-sends the same custom line doesn't double-count the
 * cluster.
 */
/**
 * Group a booking's priced_parts_snapshot rows onto the custom lines they
 * belong to, keyed by serviceMatchKey so a line renamed between the parts
 * editor and the service list still finds its parts.
 *
 * The snapshot stays the billing record. This is the denormalised copy that
 * lands on custom_jobs — see the schema note there for why the duplication is
 * deliberate.
 */
export function customPartsFromSnapshot(snapshot: unknown): Map<
  string,
  {
    parts: Array<{
      part_name: string;
      oem_number?: string;
      brand?: string;
      quantity: number;
      unit_price_cents?: number;
      line_total_cents?: number;
    }>;
    totalCents: number;
  }
> {
  const out = new Map<string, { parts: any[]; totalCents: number }>();
  if (!Array.isArray(snapshot)) return out;
  for (const row of snapshot) {
    const name = row?.custom_service_name;
    if (typeof name !== "string" || !name.trim()) continue;
    const key = serviceMatchKey(name);
    if (!key) continue;
    let bucket = out.get(key);
    if (!bucket) {
      bucket = { parts: [], totalCents: 0 };
      out.set(key, bucket);
    }
    const quantity = typeof row.quantity === "number" ? row.quantity : 1;
    const line =
      typeof row.line_total_cents === "number" ? row.line_total_cents : 0;
    bucket.parts.push({
      part_name: String(row.part_name ?? "").trim() || "Part",
      oem_number: row.oem_number ? String(row.oem_number) : undefined,
      brand: row.brand ? String(row.brand) : undefined,
      quantity,
      unit_price_cents:
        typeof row.unit_price_cents === "number"
          ? row.unit_price_cents
          : undefined,
      line_total_cents: line || undefined,
    });
    bucket.totalCents += line;
  }
  return out;
}

export async function recordCustomJobsForBooking(
  ctx: any,
  args: {
    booking: {
      _id: Id<"bookings">;
      shop_id?: Id<"shops">;
      vin: string;
    };
    mechanicId?: Id<"mechanics">;
    customJobs: CustomJobInput[];
    source: string;
    now: number;
  },
): Promise<Id<"custom_jobs">[]> {
  if (!args.booking.shop_id) return [];
  if (args.customJobs.length === 0) return [];

  const configId = await resolveVehicleConfigId(ctx, args.booking.vin);
  const existing = await ctx.db
    .query("custom_jobs")
    .withIndex("by_booking", (q: any) => q.eq("booking_id", args.booking._id))
    .collect();

  const ids: Id<"custom_jobs">[] = [];
  for (const input of args.customJobs) {
    const name = input.name.trim();
    if (!name) continue;
    const matchKey = serviceMatchKey(name);

    // The single enforcement point for the taxonomy. Deliberately here rather
    // than in each mutation's arg validator: the guarantee we want is "no
    // custom_jobs row exists without a system and a work type", and per-entry-
    // point checks are exactly how a fourth entry point later ships without one.
    const taxonomy = requireCustomJobTaxonomy({
      system_tags: input.system_tags,
      work_type: input.work_type,
      jobName: name,
    });

    const prior = existing.find((r: any) => r.match_key === matchKey);
    if (prior) {
      await ctx.db.patch(prior._id, {
        name,
        system_tags: taxonomy.system_tags,
        work_type: taxonomy.work_type,
        parts: input.parts ?? prior.parts,
        quoted_parts_cents:
          input.quoted_parts_cents ?? prior.quoted_parts_cents,
        category_id: input.category_id ?? prior.category_id,
        complaint: input.complaint?.trim() || prior.complaint,
        estimated_minutes:
          input.estimated_minutes ?? prior.estimated_minutes,
        quoted_price_cents:
          input.quoted_price_cents ?? prior.quoted_price_cents,
        vehicle_config_id: configId ?? prior.vehicle_config_id,
        updated_at: args.now,
      });
      ids.push(prior._id);
      continue;
    }

    // Only bump the ledger for genuinely new rows — otherwise editing a booking
    // would inflate the cluster count that drives the roadmap read.
    const pendingId = args.mechanicId
      ? await bumpPendingServiceSubmission(ctx, {
          name,
          reason: input.complaint ?? null,
          mechanicId: args.mechanicId,
          bookingId: args.booking._id,
          vin: args.booking.vin,
          now: args.now,
        })
      : undefined;

    const id = await ctx.db.insert("custom_jobs", {
      booking_id: args.booking._id,
      shop_id: args.booking.shop_id,
      mechanic_id: args.mechanicId,
      vehicle_vin: args.booking.vin,
      vehicle_config_id: configId,
      name,
      normalized_name: normalizeServiceName(name),
      match_key: matchKey,
      system_tags: taxonomy.system_tags,
      work_type: taxonomy.work_type,
      parts: input.parts && input.parts.length > 0 ? input.parts : undefined,
      quoted_parts_cents: input.quoted_parts_cents ?? undefined,
      category_id: input.category_id ?? undefined,
      complaint: input.complaint?.trim() || undefined,
      estimated_minutes: input.estimated_minutes ?? undefined,
      quoted_price_cents: input.quoted_price_cents ?? undefined,
      pending_service_submission_id: pendingId,
      shop_custom_service_id: input.shop_custom_service_id ?? undefined,
      source: args.source,
      status: "planned",
      created_at: args.now,
    });
    ids.push(id);

    // A pressed shortcut is the whole reason repeats are exactly countable
    // rather than fuzzy-matched, so the counter has to move in the same
    // transaction as the job it belongs to.
    if (input.shop_custom_service_id) {
      await recordShortcutUse(ctx, {
        shortcutId: input.shop_custom_service_id,
        complaint: input.complaint ?? null,
        now: args.now,
      });
    }
  }
  return ids;
}

/**
 * Close out a booking's custom jobs at completion: actual minutes, what was
 * charged, what was done, and whether it fixed the complaint.
 *
 * Matched by match_key rather than array index — the mechanic may have added or
 * removed lines between booking and completion, and index-matching would silently
 * write one job's outcome onto another.
 */
/**
 * Group the mechanic's post-job parts by the custom line they were fitted to.
 *
 * This is the ACTUALS counterpart to customPartsFromSnapshot, which reads what
 * was quoted at booking time. Work added mid-job never went through that path —
 * Flag Issue writes the custom_jobs row and the money rides the mid-job
 * approval, so the row closed with an outcome and no parts at all, even when a
 * named part had been fitted and billed.
 *
 * "Not used" rows are dropped: the mechanic is telling us the part didn't go in.
 */
function actualPartsByMatchKey(parts: unknown): Map<
  string,
  { parts: any[]; totalCents: number }
> {
  const out = new Map<string, { parts: any[]; totalCents: number }>();
  if (!Array.isArray(parts)) return out;
  for (const part of parts) {
    const name = part?.custom_service_name;
    if (typeof name !== "string" || !name.trim()) continue;
    if (part?.not_used === true) continue;
    const key = serviceMatchKey(name);
    if (!key) continue;
    let bucket = out.get(key);
    if (!bucket) {
      bucket = { parts: [], totalCents: 0 };
      out.set(key, bucket);
    }
    const quantity =
      typeof part.quantity === "number" && part.quantity > 0
        ? Math.round(part.quantity)
        : 1;
    const unitCents = Math.round(Number(part.cost ?? 0) * 100);
    const lineCents = unitCents * quantity;
    bucket.parts.push({
      part_name: String(part.part_name ?? "").trim() || "Part",
      oem_number: part.oem_number ? String(part.oem_number) : undefined,
      brand: part.brand ? String(part.brand) : undefined,
      quantity,
      unit_price_cents: unitCents || undefined,
      line_total_cents: lineCents || undefined,
    });
    bucket.totalCents += lineCents;
  }
  return out;
}

export async function completeCustomJobsForBooking(
  ctx: any,
  args: {
    bookingId: Id<"bookings">;
    jobActualId?: Id<"job_actuals">;
    /** The mechanic's confirmed post-job parts, so a line added mid-job ends
     *  up recording what actually went into it. */
    partsUsed?: unknown;
    /** The booking's priced_parts_snapshot, used only where the actuals say
     *  nothing about a line. Quoted parts are weaker evidence than fitted ones
     *  — but they beat recording that a job which plainly consumed a part
     *  consumed none. */
    quotedSnapshot?: unknown;
    outcomes: Array<{
      name: string;
      actual_minutes?: number | null;
      charged_price_cents?: number | null;
      resolution?: string | null;
      resolved_complaint?: boolean | null;
    }>;
    now: number;
  },
): Promise<number> {
  const rows = await ctx.db
    .query("custom_jobs")
    .withIndex("by_booking", (q: any) => q.eq("booking_id", args.bookingId))
    .collect();
  if (rows.length === 0) return 0;

  const byKey = new Map<string, any>();
  for (const row of rows) byKey.set(row.match_key, row);

  // Actuals beat the quote. A line quoted with one part and finished with
  // another should record the one that went in.
  const actualParts = actualPartsByMatchKey(args.partsUsed);
  const quotedParts = customPartsFromSnapshot(args.quotedSnapshot);
  /** Fitted beats quoted; quoted beats nothing. */
  const partsFor = (matchKey: string) =>
    actualParts.get(matchKey) ?? quotedParts.get(matchKey);

  let touched = 0;
  for (const outcome of args.outcomes) {
    const row = byKey.get(serviceMatchKey(outcome.name));
    if (!row) continue;
    const actualMinutes = outcome.actual_minutes ?? row.actual_minutes;
    const fitted = partsFor(row.match_key);
    await ctx.db.patch(row._id, {
      status: "completed",
      parts: fitted && fitted.parts.length > 0 ? fitted.parts : row.parts,
      charged_price_cents:
        outcome.charged_price_cents ??
        (fitted ? fitted.totalCents : undefined) ??
        row.charged_price_cents,
      job_actual_id: args.jobActualId ?? row.job_actual_id,
      actual_minutes: actualMinutes,
      resolution: outcome.resolution?.trim() || row.resolution,
      resolved_complaint:
        outcome.resolved_complaint ?? row.resolved_complaint,
      updated_at: args.now,
    });

    // Feed the shortcut's labor distribution. This is what makes drift visible:
    // a button whose actuals keep landing far from its own default is either
    // covering several different jobs or is genuinely config-dependent, and the
    // complaint texts are what distinguish those.
    if (row.shop_custom_service_id && typeof actualMinutes === "number") {
      await recordShortcutActual(ctx, {
        shortcutId: row.shop_custom_service_id,
        actualMinutes,
        now: args.now,
      });
    }
    touched += 1;
  }

  // Any custom job still "planned" after completion was on the booking but
  // never reported on. Mark it completed with no outcome rather than leaving it
  // planned forever, so the director view can tell "no outcome recorded" apart
  // from "still open".
  for (const row of rows) {
    if (row.status !== "planned") continue;
    if (row.updated_at === args.now) continue;
    // No outcome reported, but parts may still have been fitted — record them
    // rather than closing the row emptier than the evidence allows.
    const fitted = partsFor(row.match_key);
    await ctx.db.patch(row._id, {
      status: "completed",
      job_actual_id: args.jobActualId ?? row.job_actual_id,
      parts: fitted && fitted.parts.length > 0 ? fitted.parts : row.parts,
      charged_price_cents:
        fitted && fitted.totalCents > 0
          ? fitted.totalCents
          : row.charged_price_cents,
      updated_at: args.now,
    });
  }

  return touched;
}

/**
 * Shared gate for the mid-job edit surface (add / rename / remove).
 *
 * Same three questions each entry point has to answer before it touches a line:
 * is the caller a real user, do they belong to (or own) the booking's shop, and
 * is the job actually running. Kept as one helper so a fourth entry point can't
 * later ship without one of them.
 */
async function authorizeMidJobEdit(
  ctx: any,
  bookingId: Id<"bookings">,
): Promise<{ user: any; booking: any }> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkUserId", (q: any) =>
      q.eq("clerkUserId", identity.subject),
    )
    .unique();
  if (!user) throw new Error("User not found");

  const booking = await ctx.db.get(bookingId);
  if (!booking) throw new Error("Booking not found");
  if (!booking.shop_id) throw new Error("Booking has no shop");

  const shopUser = await ctx.db
    .query("shop_users")
    .withIndex("by_user_and_shop", (q: any) =>
      q.eq("user_id", user._id).eq("shop_id", booking.shop_id),
    )
    .first();
  if (!shopUser?.is_active) {
    const owned = await ctx.db
      .query("shops")
      .withIndex("by_owner_user_id", (q: any) => q.eq("owner_user_id", user._id))
      .filter((q: any) => q.eq(q.field("_id"), booking.shop_id))
      .first();
    if (!owned) throw new Error("Not authorized for this shop");
  }

  // Same gate the mid-job approval cycle enforces — changing work on a job that
  // isn't running would land money on a booking nobody is standing at.
  if (booking.status !== "in_progress") {
    throw new Error("Work can only be changed while the booking is in progress.");
  }

  return { user, booking };
}

/**
 * Add off-catalog work to a job that's already underway — the "while I was in
 * there" case (Off-Catalog Work spec, §4).
 *
 * This is the entry point that matters most for a shop running its whole day
 * through the portal, because it's how this work actually shows up: the customer
 * approves an extra thing at 11am. Before this, that meant editing the booking.
 *
 * Deliberately does NOT re-quote or change any money. It appends the line and
 * records the structured row; the mechanic then submits the change through the
 * existing mid-job approval cycle (booking_approvals.submitMidJobChange), which
 * already owns re-quoting, the customer's approval, and the payment ceiling.
 * Duplicating any of that here would give us two sources of truth for a total.
 */
export const addMidJobCustomService = mutation({
  args: {
    bookingId: v.id("bookings"),
    name: v.string(),
    complaint: v.optional(v.string()),
    // Required in practice — recordCustomJobsForBooking throws without them.
    // Left as plain strings here so the taxonomy can gain a slug without a
    // schema migration; the shared validator is the source of truth.
    systemTags: v.optional(v.array(v.string())),
    workType: v.optional(v.string()),
    estimatedMinutes: v.optional(v.number()),
    shopCustomServiceId: v.optional(v.id("shop_custom_services")),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) =>
        q.eq("clerkUserId", identity.subject),
      )
      .unique();
    if (!user) throw new Error("User not found");

    const booking = await ctx.db.get(args.bookingId);
    if (!booking) throw new Error("Booking not found");
    if (!booking.shop_id) throw new Error("Booking has no shop");

    const shopUser = await ctx.db
      .query("shop_users")
      .withIndex("by_user_and_shop", (q: any) =>
        q.eq("user_id", user._id).eq("shop_id", booking.shop_id),
      )
      .first();
    if (!shopUser?.is_active) {
      const owned = await ctx.db
        .query("shops")
        .withIndex("by_owner_user_id", (q: any) =>
          q.eq("owner_user_id", user._id),
        )
        .filter((q: any) => q.eq(q.field("_id"), booking.shop_id))
        .first();
      if (!owned) throw new Error("Not authorized for this shop");
    }

    // Same gate the mid-job approval cycle enforces — adding work to a job that
    // isn't running would land money on a booking nobody is standing at.
    if (booking.status !== "in_progress") {
      throw new Error(
        "Work can only be added while the booking is in progress.",
      );
    }

    const name = args.name.trim();
    if (!name) throw new Error("A name is required");

    const now = Date.now();
    const existingLines = Array.isArray((booking as any).custom_services)
      ? [...(booking as any).custom_services]
      : [];
    const matchKey = serviceMatchKey(name);
    const alreadyThere = existingLines.some(
      (c: any) => serviceMatchKey(String(c.name)) === matchKey,
    );

    if (!alreadyThere) {
      existingLines.push({
        name,
        duration_minutes: args.estimatedMinutes ?? undefined,
      });
      await ctx.db.patch(args.bookingId, {
        custom_services: existingLines,
        updated_at: now,
      });
    }

    // recordCustomJobsForBooking is idempotent per (booking, match_key), so a
    // double-tap patches the existing row instead of duplicating it.
    const ids = await recordCustomJobsForBooking(ctx, {
      booking: {
        _id: args.bookingId,
        shop_id: booking.shop_id,
        vin: booking.vin,
      },
      mechanicId: booking.mechanic_id ?? undefined,
      customJobs: [
        {
          name,
          system_tags: args.systemTags ?? null,
          work_type: args.workType ?? null,
          complaint: args.complaint ?? null,
          estimated_minutes: args.estimatedMinutes ?? null,
          shop_custom_service_id: args.shopCustomServiceId ?? null,
        },
      ],
      source: "mid_job",
      now,
    });

    return {
      ok: true,
      customJobId: ids[0] ?? null,
      addedLine: !alreadyThere,
      // The caller still has to send the mid-job change for approval — nothing
      // about the booking's money has moved yet.
      requiresApproval: true,
    };
  },
});

/**
 * Edit a line the mechanic just added — before it's been sent for approval.
 *
 * Only the three things captured at the keyboard are editable here: the name,
 * the complaint, and the taxonomy. Parts, minutes and price are owned by the
 * mid-job approval cycle downstream, so they're deliberately untouched. Same
 * "no money moves" contract as the add path.
 */
export const updateMidJobCustomService = mutation({
  args: {
    bookingId: v.id("bookings"),
    customJobId: v.id("custom_jobs"),
    name: v.string(),
    complaint: v.optional(v.string()),
    systemTags: v.optional(v.array(v.string())),
    workType: v.optional(v.string()),
    // Labor estimate for this line. Feeds the per-service breakdown on the
    // labor step; the mid-job approval cycle still owns the money.
    estimatedMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { booking } = await authorizeMidJobEdit(ctx, args.bookingId);

    const row = await ctx.db.get(args.customJobId);
    if (!row) throw new Error("That work is no longer on the job.");
    if (row.booking_id !== args.bookingId) {
      throw new Error("That work belongs to a different booking.");
    }

    const name = args.name.trim();
    if (!name) throw new Error("A name is required");

    // Same single enforcement point the record path uses.
    const taxonomy = requireCustomJobTaxonomy({
      system_tags: args.systemTags,
      work_type: args.workType,
      jobName: name,
    });

    const now = Date.now();
    const oldKey = row.match_key ?? serviceMatchKey(row.name);
    const newKey = serviceMatchKey(name);

    // A rename that collides with another line on the same booking would give
    // two custom_jobs rows one match_key. The completion path matches outcomes
    // on that key, so refuse the rename rather than silently merge two jobs.
    if (newKey !== oldKey) {
      const siblings = await ctx.db
        .query("custom_jobs")
        .withIndex("by_booking", (q: any) => q.eq("booking_id", args.bookingId))
        .collect();
      if (
        siblings.some((r: any) => r._id !== row._id && r.match_key === newKey)
      ) {
        throw new Error("That work is already on the job.");
      }
    }

    await ctx.db.patch(args.customJobId, {
      name,
      normalized_name: normalizeServiceName(name),
      match_key: newKey,
      system_tags: taxonomy.system_tags,
      work_type: taxonomy.work_type,
      complaint: args.complaint?.trim() || undefined,
      estimated_minutes:
        args.estimatedMinutes !== undefined
          ? args.estimatedMinutes
          : row.estimated_minutes,
      updated_at: now,
    });

    // Keep the booking's lightweight scheduling copy in sync when the name moved.
    if (newKey !== oldKey) {
      const lines = Array.isArray((booking as any).custom_services)
        ? [...(booking as any).custom_services]
        : [];
      let mutated = false;
      for (const line of lines) {
        if (serviceMatchKey(String(line.name)) === oldKey) {
          line.name = name;
          mutated = true;
        }
      }
      if (mutated) {
        await ctx.db.patch(args.bookingId, {
          custom_services: lines,
          updated_at: now,
        });
      }
    }

    return { ok: true, customJobId: args.customJobId };
  },
});

/**
 * Pull a line the mechanic added by mistake back off the job.
 *
 * Drops the structured custom_jobs row and the matching scheduling copy on the
 * booking. Only reachable before the mid-job change is submitted (the money
 * hasn't moved yet), so there's nothing to reverse downstream.
 */
export const removeMidJobCustomService = mutation({
  args: {
    bookingId: v.id("bookings"),
    customJobId: v.id("custom_jobs"),
  },
  handler: async (ctx, args) => {
    const { booking } = await authorizeMidJobEdit(ctx, args.bookingId);

    const row = await ctx.db.get(args.customJobId);
    if (!row) throw new Error("That work is no longer on the job.");
    if (row.booking_id !== args.bookingId) {
      throw new Error("That work belongs to a different booking.");
    }

    // Drop the scheduling copy on the booking, matched on the same key the row
    // is keyed on so an edited name still lines up.
    const matchKey = row.match_key ?? serviceMatchKey(row.name);
    const lines = Array.isArray((booking as any).custom_services)
      ? (booking as any).custom_services
      : [];
    const nextLines = lines.filter(
      (c: any) => serviceMatchKey(String(c.name)) !== matchKey,
    );
    if (nextLines.length !== lines.length) {
      await ctx.db.patch(args.bookingId, {
        custom_services: nextLines,
        updated_at: Date.now(),
      });
    }

    await ctx.db.delete(args.customJobId);
    return { ok: true };
  },
});

/**
 * Mechanic-facing: the custom jobs on a booking, so the post-job survey can ask
 * for an outcome per line without re-deriving them from the booking array.
 */
export const listForBooking = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("custom_jobs")
      .withIndex("by_booking", (q) => q.eq("booking_id", args.bookingId))
      .collect();
    rows.sort((a, b) => a.created_at - b.created_at);
    return rows.map((r) => ({
      _id: r._id,
      name: r.name,
      system_tags: (r.system_tags ?? []) as string[],
      work_type: (r.work_type ?? null) as string | null,
      parts: (r.parts ?? []) as Array<{
        part_name: string;
        oem_number?: string;
        brand?: string;
        quantity: number;
        unit_price_cents?: number;
        line_total_cents?: number;
      }>,
      quoted_parts_cents: (r.quoted_parts_cents ?? null) as number | null,
      category_id: r.category_id ?? null,
      complaint: r.complaint ?? null,
      resolution: r.resolution ?? null,
      resolved_complaint: r.resolved_complaint ?? null,
      estimated_minutes: r.estimated_minutes ?? null,
      actual_minutes: r.actual_minutes ?? null,
      status: r.status,
    }));
  },
});

/**
 * What other shops already call this work.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Clustering is only as good as the names. "Carbon cleaning", "walnut blast",
 * "intake decarbon" and "carbon clean service" are one job and four clusters,
 * and no amount of matching after the fact recovers what convergence at the
 * keyboard would have given for free. The catalog we're trying to build is
 * mostly a naming problem.
 *
 * So this is the second band under the name field. The first
 * (serviceMatch.matchCustomName) says "we already sell this" — take it and the
 * driver keeps their maintenance credit. This one says "other shops call it
 * X" — take it and the cluster grows instead of forking.
 *
 * ─── WHAT IT DELIBERATELY DOESN'T RETURN ────────────────────────────────────
 * No shop names, no ids, no prices, no vehicles. A shop learns that four OTHER
 * shops do this work and what they call it — nothing about who they are or what
 * they charge. The naming signal is what's useful here; the rest is somebody
 * else's business.
 *
 * ─── COST ───────────────────────────────────────────────────────────────────
 * Scans pending_service_submissions, which holds ONE row per distinct name
 * ever typed — the small table, not custom_jobs. Only the handful that survive
 * scoring then hit custom_jobs, and they go through the by_match_key index.
 */
export const suggestKnownNames = query({
  args: {
    name: v.string(),
    shopId: v.optional(v.id("shops")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Cross-shop data, however coarse, is not public. The band is only ever
    // rendered inside an authenticated shop surface, so requiring an identity
    // costs the feature nothing and keeps the whole naming ledger off an
    // unauthenticated endpoint.
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const typed = args.name.trim();
    if (typed.length < 3) return [];

    const submissions = await ctx.db
      .query("pending_service_submissions")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .collect();

    const typedKey = serviceMatchKey(typed);
    const scored: Array<{ name: string; score: number }> = [];
    for (const row of submissions) {
      const candidate = String(row.proposed_name ?? "").trim();
      if (!candidate) continue;
      // What they've typed so far, exactly. Suggesting it back is noise.
      if (normalizeServiceName(candidate) === normalizeServiceName(typed)) {
        continue;
      }
      const score = fuzzyNameSimilarity(typed, candidate);
      // 0.5 keeps a half-typed name useful ("carbon" → "Carbon cleaning")
      // without letting one shared noun drag in unrelated work.
      if (score < 0.5) continue;
      scored.push({ name: candidate, score });
    }

    scored.sort((a, b) => b.score - a.score);

    const out: Array<{
      name: string;
      shops: number;
      jobs: number;
      system_tags: string[];
      work_type: string | null;
      /** True when this shop has already used the name — it isn't news, and the
       *  UI drops it rather than telling them what they already know. */
      used_here: boolean;
    }> = [];

    const seenKeys = new Set<string>([typedKey]);
    for (const candidate of scored) {
      if (out.length >= (args.limit ?? 4)) break;
      const key = serviceMatchKey(candidate.name);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);

      const jobs = await ctx.db
        .query("custom_jobs")
        .withIndex("by_match_key", (q: any) => q.eq("match_key", key))
        .collect();
      if (jobs.length === 0) continue;

      const shops = new Set<string>();
      const systemCounts = new Map<string, number>();
      const workTypeCounts = new Map<string, number>();
      let usedHere = false;
      for (const job of jobs) {
        shops.add(String(job.shop_id));
        if (args.shopId && String(job.shop_id) === String(args.shopId)) {
          usedHere = true;
        }
        for (const tag of (job.system_tags ?? []) as string[]) {
          systemCounts.set(tag, (systemCounts.get(tag) ?? 0) + 1);
        }
        if (job.work_type) {
          workTypeCounts.set(
            job.work_type,
            (workTypeCounts.get(job.work_type) ?? 0) + 1,
          );
        }
      }

      // Already in this shop's own "Done here before" chips — showing it again
      // under a heading about other shops would be a lie.
      if (usedHere && shops.size === 1) continue;

      out.push({
        // The spelling the cluster is keyed on wins, not the mechanic's
        // half-typed one — converging on ONE string is the entire point.
        name: dominantName(jobs) ?? candidate.name,
        shops: shops.size,
        jobs: jobs.length,
        system_tags: [...systemCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([tag]) => tag),
        work_type:
          [...workTypeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
          null,
        used_here: usedHere,
      });
    }

    return out;
  },
});

/** The most common spelling inside a cluster — what everyone should converge on. */
function dominantName(jobs: Array<{ name: string }>): string | null {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const name = String(job.name ?? "").trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [name, n] of counts) {
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  return best;
}

/**
 * What the mechanic added to this job after work started, for the customer's
 * mid-job approval screen.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * The approval screen showed a price and a delta — "$472.84", "$220.08 above
 * your estimate" — and then jumped straight to inspection findings. It never
 * said what the extra money was FOR. A customer was being asked to approve a
 * number on trust, which is the exact moment trust is most expensive: they're
 * not at the shop, the car is on a lift, and declining is awkward.
 *
 * `source: "mid_job"` is what makes this answerable. Work added while the job
 * was running is stamped with it at write time, so this is a read of what
 * actually happened rather than a diff of two snapshots that may not exist.
 *
 * Returns the off-catalog additions only. A catalog service added mid-job
 * lands on `booking.service_ids` and already renders by name through the
 * receipt's service lines; it's this half that had no route to the customer.
 */
export const listMidJobAdditionsForCustomer = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q: any) =>
        q.eq("clerkUserId", identity.subject),
      )
      .unique();
    if (!user) return [];

    const booking = await ctx.db.get(args.bookingId);
    if (!booking) return [];
    // Strictly the booking's own customer. Shop staff have the mechanic-facing
    // read (listForBooking); this one exists to be shown to the person paying.
    if (booking.user_id !== user._id) return [];

    const rows = await ctx.db
      .query("custom_jobs")
      .withIndex("by_booking", (q: any) => q.eq("booking_id", args.bookingId))
      .collect();

    return rows
      .filter((r: any) => r.source === "mid_job" && r.status !== "cancelled")
      .sort((a: any, b: any) => a.created_at - b.created_at)
      .map((r: any) => ({
        _id: r._id,
        name: r.name,
        // The mechanic's own words for what they found. This is the sentence
        // that makes the number make sense, so it leads on the card.
        complaint: r.complaint ?? null,
        system_tags: (r.system_tags ?? []) as string[],
        work_type: (r.work_type ?? null) as string | null,
        estimated_minutes: r.estimated_minutes ?? null,
        // Named parts do more to justify a figure than any summary line.
        parts: ((r.parts ?? []) as any[]).map((p) => ({
          part_name: p.part_name,
          oem_number: p.oem_number ?? null,
          quantity: p.quantity,
        })),
        quoted_parts_cents: r.quoted_parts_cents ?? null,
      }));
  },
});
