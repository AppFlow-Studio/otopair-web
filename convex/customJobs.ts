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
import { summarizePartPrices, quoteUnitPrice } from "./part_prices";
import { passesI1ReadGuardNamed, makeNameCached } from "./lib/makeIdentity";
import { detectTier, resolveLaborHours } from "./lib/quoteEngine";
import { resolveLaborRate, VehicleTier } from "./lib/vehicleTiers";

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
  /** The canonical service this added line resolved to at entry, when the
   *  mechanic added a real bookable service mid-job. Its presence is the
   *  discriminator the CUSTOM JOB INVARIANT keys on — see schema.ts. */
  catalog_service_id?: Id<"services"> | null;
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
        catalog_service_id: input.catalog_service_id ?? prior.catalog_service_id,
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
      catalog_service_id: input.catalog_service_id ?? undefined,
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
    // A line the customer declined (or let expire) mid-job is kept for audit
    // but must never complete or reach the receipt. If the survey still carries
    // an outcome for it (the mechanic opened the survey before the decline
    // landed), skip it — the row stays "declined".
    if (row.status === "declined") continue;
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
 * Stamp the custom_jobs a mid-job cycle just introduced with that cycle's
 * approval id, so a later customer decline can revert exactly those lines and
 * nothing from a prior approved cycle.
 *
 * Called from performSubmission right after the booking_approvals row is
 * inserted, only for the mid-job cycle. Stamps only rows that are still
 * "planned", off-catalog and added mid-job, and not already bound to a LIVE
 * approval. A row whose stamp points at an approval that was withdrawn, expired
 * or declined is re-stampable — that's how a withdraw+resubmit re-binds only the
 * lines the new cycle carries.
 */
export async function stampMidJobCustomJobs(
  ctx: any,
  args: {
    bookingId: Id<"bookings">;
    approvalId: Id<"booking_approvals">;
    now: number;
  },
): Promise<number> {
  const rows = await ctx.db
    .query("custom_jobs")
    .withIndex("by_booking", (q: any) => q.eq("booking_id", args.bookingId))
    .collect();

  // An existing stamp only "holds" a row while its approval is still live
  // (open, or approved). One that was withdrawn/expired/declined no longer owns
  // the line, so a fresh cycle may re-bind it.
  const stampStillHolds = async (approvalId: Id<"booking_approvals"> | undefined) => {
    if (!approvalId) return false;
    const prior: any = await ctx.db.get(approvalId);
    if (!prior) return false;
    const d = prior.decision as string | undefined;
    return d !== "declined" && d !== "withdrawn" && d !== "sla_expired";
  };

  let stamped = 0;
  for (const row of rows) {
    if (row.source !== "mid_job") continue;
    if (row.status !== "planned") continue;
    if (await stampStillHolds(row.introduced_by_approval_id)) continue;
    await ctx.db.patch(row._id, {
      introduced_by_approval_id: args.approvalId,
      updated_at: args.now,
    });
    stamped += 1;
  }
  return stamped;
}

/**
 * Revert the mid-job scope a customer declined (or let expire).
 *
 * Keeps the custom_jobs row for audit/logging — marked "declined", with its
 * parts/complaint intact so the denied parts are still recorded — but drops the
 * line from the booking's scheduling copy (`custom_services`) so it never
 * reaches the completed job, the receipt, or the price. Idempotent: only
 * touches rows still "planned" and bound to this exact approval cycle.
 *
 * Returns the number of lines reverted.
 */
export async function revertDeclinedMidJobWork(
  ctx: any,
  args: {
    bookingId: Id<"bookings">;
    approvalId: Id<"booking_approvals">;
    now: number;
  },
): Promise<number> {
  const booking: any = await ctx.db.get(args.bookingId);
  if (!booking) return 0;

  const rows = await ctx.db
    .query("custom_jobs")
    .withIndex("by_booking", (q: any) => q.eq("booking_id", args.bookingId))
    .collect();

  const declinedKeys = new Set<string>();
  let reverted = 0;
  for (const row of rows) {
    if (String(row.introduced_by_approval_id ?? "") !== String(args.approvalId)) {
      continue;
    }
    if (row.status !== "planned") continue;
    await ctx.db.patch(row._id, {
      status: "declined",
      updated_at: args.now,
    });
    declinedKeys.add(row.match_key ?? serviceMatchKey(row.name));
    reverted += 1;
  }

  if (declinedKeys.size > 0) {
    const lines = Array.isArray(booking.custom_services)
      ? booking.custom_services
      : [];
    const nextLines = lines.filter(
      (c: any) => !declinedKeys.has(serviceMatchKey(String(c.name))),
    );
    if (nextLines.length !== lines.length) {
      await ctx.db.patch(args.bookingId, {
        custom_services: nextLines,
        updated_at: args.now,
      });
    }
  }

  return reverted;
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
/**
 * OEM catalog/enrichment parts for a catalog service on this vehicle, in the
 * shape custom_jobs.parts stores.
 *
 * Mirrors the oemRecommendations builder in job_actuals.getPrefillData (base
 * part_fitments by config+service slug, the I1 make guard, the canonical
 * median/average unit price) so that when a CATALOG service is added to a job —
 * an "Oil Change" promoted straight from the inspection, say — the scope dialog
 * opens with its OEM parts already listed instead of a blank "Add part for X".
 * A freeform (non-catalog) add has no serviceId and skips this entirely.
 *
 * Best-effort: returns null on any gap (no config, no slug, no fitments) so the
 * add still succeeds — the mechanic just fills the parts in by hand as before.
 */
async function oemPartsForServiceOnVehicle(
  ctx: any,
  args: { vin: string; serviceId: Id<"services"> },
): Promise<NonNullable<CustomJobInput["parts"]> | null> {
  const service: any = await ctx.db.get(args.serviceId);
  if (!service?.slug) return null;

  // .first() not .unique(): a duplicate-VIN row (rare, but they exist) would
  // otherwise throw and break the read this runs inside.
  const vehicle: any = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", args.vin))
    .first();
  const configId = vehicle?.vehicle_config_id;
  if (!configId) return null;
  const config: any = await ctx.db.get(configId);
  const configMakeName = await makeNameCached(ctx, config?.make_id);

  const fitments = await ctx.db
    .query("part_fitments")
    .withIndex("by_config_service", (q: any) =>
      q.eq("vehicle_config_id", configId).eq("service_type", service.slug),
    )
    .collect();

  const out: NonNullable<CustomJobInput["parts"]> = [];
  for (const f of fitments) {
    // Base parts only — package-gated rows need the customer's package answers,
    // which this add path doesn't collect.
    if (f.package_code != null) continue;
    const part: any = await ctx.db.get(f.part_id);
    if (!part) continue;
    // I1 read guard — NAME-aware, matching the canonical resolver so an added
    // catalog service surfaces the same parts Review & Pay would. Strict
    // id-only matching hid parts stamped under a duplicate make row (two
    // "Honda" rows) or a corporate-family sibling; the foreign-brand signature
    // backstop still drops genuine cross-make contaminants.
    if (
      !passesI1ReadGuardNamed({
        partMakeId: part.make_id,
        configMakeId: config?.make_id,
        oemPartNumber: part.oem_part_number,
        configMakeName,
        partMakeName: await makeNameCached(ctx, part.make_id),
        mechanicVerified: f.mechanic_verified === true,
      })
    )
      continue;
    const price = await summarizePartPrices(ctx, f.part_id);
    // summarizePartPrices returns DOLLARS (2dp); custom_jobs.parts stores cents.
    const unitCents = Math.round(
      quoteUnitPrice({
        average: price.average,
        median: price.median,
        sample_size: price.sample_size,
      }) * 100,
    );
    out.push({
      part_name: part.name,
      oem_number: part.oem_part_number,
      brand: part.brand ?? undefined,
      quantity:
        f.quantity_needed && f.quantity_needed > 0 ? f.quantity_needed : 1,
      unit_price_cents: unitCents > 0 ? unitCents : undefined,
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Labor minutes we'd quote for a catalog service on this vehicle — the internal
 * labor ladder (resolveLaborHours), car- and tier-aware, the same estimate a
 * BOOKED instance of the service would carry. Lets an added catalog service open
 * the labor step pre-filled with a real time instead of 0. Best-effort: null on
 * any gap (no config, no tier, ladder refuses) so the mechanic just types it.
 */
async function oemLaborMinutesForServiceOnVehicle(
  ctx: any,
  args: { vin: string; serviceId: Id<"services"> },
): Promise<number | null> {
  const vehicle: any = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", args.vin))
    .first();
  const configId = vehicle?.vehicle_config_id;
  if (!configId) return null;
  const config: any = await ctx.db.get(configId);
  if (!config) return null;
  const tier = await detectTier(ctx, config);
  if (!tier) return null;
  const res = await resolveLaborHours(ctx, {
    vehicle_config_id: configId,
    service_id: args.serviceId,
    vehicle_tier: tier,
  });
  if (!res.ok || !(res.hours > 0)) return null;
  return Math.round(res.hours * 60);
}

/**
 * Price an ADDED catalog service under the SHOP'S rules — the same rules a
 * booked instance of the service follows:
 *   • labor time from the internal ladder (car- and tier-aware),
 *   • the shop's per-vehicle-tier labor rate,
 *   • a per-(shop, service, tier) FLAT price override when the shop set one.
 * Powers both the pick-time estimate query (prefill + "Fixed price" pill) and
 * the add mutation (which freezes the flat price onto the custom-job row so
 * performSubmission bills it flat). Best-effort: every field is null on a gap
 * (no config, no tier, ladder refuses) so the mechanic just types the time.
 */
async function resolveAddedServicePricing(
  ctx: any,
  args: { booking: any; serviceId: Id<"services"> },
): Promise<{
  laborMinutes: number | null;
  laborRateCents: number | null;
  fixedPriceCents: number | null;
  tier: string | null;
}> {
  const empty = {
    laborMinutes: null,
    laborRateCents: null,
    fixedPriceCents: null,
    tier: null,
  };
  const vin = args.booking?.vin;
  if (!vin) return empty;
  const vehicle: any = await ctx.db
    .query("vehicles")
    .withIndex("by_vin", (q: any) => q.eq("vin", vin))
    .first();
  const configId = vehicle?.vehicle_config_id;
  if (!configId) return empty;
  const config: any = await ctx.db.get(configId);
  if (!config) return empty;
  const tier =
    (config.pricing_tier as VehicleTier | undefined) ??
    (await detectTier(ctx, config));
  if (!tier) return empty;

  // Labor time — same ladder a booked instance of the service would carry.
  let laborMinutes: number | null = null;
  const laborRes = await resolveLaborHours(ctx, {
    vehicle_config_id: configId,
    service_id: args.serviceId,
    vehicle_tier: tier,
  });
  if (laborRes.ok && laborRes.hours > 0) {
    laborMinutes = Math.round(laborRes.hours * 60);
  }

  // Shop's per-tier labor rate (dollars/hr → cents).
  let laborRateCents: number | null = null;
  const shop = args.booking?.shop_id
    ? await ctx.db.get(args.booking.shop_id)
    : null;
  if (shop) {
    const rate = resolveLaborRate(shop as any, tier);
    if (rate.rate != null) laborRateCents = Math.round(rate.rate * 100);
  }

  // Flat-price override for (shop, service, tier), if the shop set one.
  let fixedPriceCents: number | null = null;
  if (args.booking?.shop_id) {
    const row: any = await ctx.db
      .query("shop_service_fixed_prices")
      .withIndex("by_shop_service_tier", (q: any) =>
        q
          .eq("shop_id", args.booking.shop_id)
          .eq("service_id", args.serviceId)
          .eq("tier", tier),
      )
      .unique();
    if (row) fixedPriceCents = row.price_cents;
  }

  return { laborMinutes, laborRateCents, fixedPriceCents, tier };
}

/**
 * Resolve a free-text line name to a catalog service, on the same match key the
 * catalog dedupes on (so "Oil Change" → the oil_change service). The slug is
 * also tried, with -/_ normalized to spaces. Returns null for genuinely
 * off-catalog work. Pass `services` to avoid re-collecting the (small) table.
 */
export async function resolveCatalogServiceIdByName(
  ctx: any,
  name: string,
  services?: any[],
): Promise<Id<"services"> | null> {
  const key = serviceMatchKey(name);
  if (!key) return null;
  const list = services ?? (await ctx.db.query("services").collect());
  const matched = list.find(
    (s: any) =>
      serviceMatchKey(s.name) === key ||
      (s.slug && serviceMatchKey(String(s.slug).replace(/[-_]/g, " ")) === key),
  );
  return matched?._id ?? null;
}

// Shared arg shape for the two "add a custom service to a booking" entry points
// (pre-job estimate vs mid-job change). Inputs are identical; the mutations
// differ only in which booking status they accept and the `source` they stamp.
const customServiceAddArgs = {
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
  // Set when the added line resolves to a REAL catalog service (e.g. an
  // inspection follow-up that matched "Oil Change"). Lets the add seed the
  // line's parts from the OEM catalog/enrichment so the scope dialog shows them
  // instead of an empty "Add part for X". Omitted for freeform work.
  catalogServiceId: v.optional(v.id("services")),
} as const;

/**
 * Shared body for adding an off-catalog line to a booking. Appends it to
 * custom_services (idempotent by match_key) and records the structured
 * custom_jobs row. Deliberately does NOT re-quote or move money — the caller
 * sends the change through the appropriate approval cycle (pre_job estimate or
 * mid_job change), which owns the quote, the customer's approval and the ceiling.
 *
 * `assertStatus` is the ONE place the two entry points diverge: mid-job insists
 * the job is running (money would otherwise land on a booking nobody is standing
 * at); pre-job insists it is NOT yet running (an in-progress job takes the
 * mid-job path) and not closed.
 */
async function addCustomServiceForBooking(
  ctx: any,
  args: {
    bookingId: Id<"bookings">;
    name: string;
    complaint?: string;
    systemTags?: string[];
    workType?: string;
    estimatedMinutes?: number;
    shopCustomServiceId?: Id<"shop_custom_services">;
    catalogServiceId?: Id<"services">;
  },
  opts: { source: string; assertStatus: (status: string) => void },
) {
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

  opts.assertStatus(booking.status);

  const name = args.name.trim();
  if (!name) throw new Error("A name is required");

  const now = Date.now();

  // Resolve which catalog service this line IS, so its OEM parts and labor can
  // be seeded. Prefer the id the caller passed (the inspection knows it), but
  // fall back to matching the line's NAME against the catalog on the same key
  // the catalog dedupes on — so "Oil Change" seeds whether or not the caller
  // threaded an id. Freeform work that matches nothing stays bare.
  let catalogServiceId = args.catalogServiceId ?? null;
  if (!catalogServiceId) {
    catalogServiceId = await resolveCatalogServiceIdByName(ctx, name);
  }

  const existingLines = Array.isArray((booking as any).custom_services)
    ? [...(booking as any).custom_services]
    : [];
  const matchKey = serviceMatchKey(name);
  const alreadyThere = existingLines.some(
    (c: any) => serviceMatchKey(String(c.name)) === matchKey,
  );

  // Labor minutes for the line. The mechanic's explicit value wins; otherwise,
  // for a CATALOG service, fall back to the OEM labor ladder — the same time a
  // booked instance would carry — so the line reaches BOTH the estimate's labor
  // step and the receipt's per-service split with a real number instead of 0.
  // Without this, custom_services.duration_minutes stayed null: getReceipt
  // couldn't attribute any labor to the added line (it rendered "—") and instead
  // dumped the whole labor subtotal onto the original service's row. Only
  // computed for a NEW line, so a re-add never clobbers a time edited by hand.
  let estimatedMinutes = args.estimatedMinutes ?? null;
  // Flat price (cents) for this catalog service at the vehicle's tier, when the
  // shop set one. Frozen onto the custom-job row so performSubmission bills the
  // added line at the flat rate (parts+labor bypassed) — the same rule a booked
  // fixed-price service follows.
  let fixedPriceCents: number | null = null;
  if (!alreadyThere && catalogServiceId && booking.vin) {
    const pricing = await resolveAddedServicePricing(ctx, {
      booking,
      serviceId: catalogServiceId,
    });
    // Mechanic's explicit time wins; otherwise the OEM labor ladder time (same
    // a booked instance carries) so the labor step opens with a real number.
    if (estimatedMinutes == null) estimatedMinutes = pricing.laborMinutes;
    fixedPriceCents = pricing.fixedPriceCents;
  }

  if (!alreadyThere) {
    existingLines.push({
      name,
      duration_minutes: estimatedMinutes ?? undefined,
    });
    await ctx.db.patch(args.bookingId, {
      custom_services: existingLines,
      updated_at: now,
    });
  }

  // Catalog service? Seed the line's parts from the OEM catalog/enrichment so
  // the scope dialog opens with them listed. Best-effort — a gap just means the
  // mechanic fills them in by hand, exactly as before.
  const seededParts = catalogServiceId
    ? await oemPartsForServiceOnVehicle(ctx, {
        vin: booking.vin,
        serviceId: catalogServiceId,
      })
    : null;

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
        // Persist the catalog match resolved above. This is what lets booking
        // completion credit a maintenance anchor for an added *catalog* service
        // (and only that) — see the CUSTOM JOB INVARIANT in bookings.ts.
        catalog_service_id: catalogServiceId,
        complaint: args.complaint ?? null,
        estimated_minutes: estimatedMinutes,
        quoted_price_cents: fixedPriceCents ?? undefined,
        shop_custom_service_id: args.shopCustomServiceId ?? null,
        parts: seededParts,
      },
    ],
    source: opts.source,
    now,
  });

  return {
    ok: true,
    customJobId: ids[0] ?? null,
    addedLine: !alreadyThere,
    // The caller still has to send the change for approval — nothing about the
    // booking's money has moved yet.
    requiresApproval: true,
  };
}

/**
 * Pick-time estimate for an ADDED catalog service: the labor time, the shop's
 * per-tier labor rate, and any flat price the shop set for it — all for THIS
 * car at THIS shop. Drives the "What did you find?" labor prefill and the
 * "Fixed price" pill so the mechanic sees the same numbers a booked instance
 * would carry, before committing. Returns nulls on any gap.
 */
export const getAddedServiceEstimate = query({
  args: {
    bookingId: v.id("bookings"),
    serviceId: v.id("services"),
  },
  handler: async (ctx, args) => {
    const booking: any = await ctx.db.get(args.bookingId);
    if (!booking) {
      return {
        laborHours: null,
        laborRateCents: null,
        fixedPriceCents: null,
        tier: null,
      };
    }
    const pricing = await resolveAddedServicePricing(ctx, {
      booking,
      serviceId: args.serviceId,
    });
    return {
      laborHours:
        pricing.laborMinutes != null ? pricing.laborMinutes / 60 : null,
      laborRateCents: pricing.laborRateCents,
      fixedPriceCents: pricing.fixedPriceCents,
      tier: pricing.tier,
    };
  },
});

export const addMidJobCustomService = mutation({
  args: customServiceAddArgs,
  handler: (ctx, args) =>
    addCustomServiceForBooking(ctx, args, {
      source: "mid_job",
      assertStatus: (status) => {
        // Same gate the mid-job approval cycle enforces — adding work to a job
        // that isn't running lands money on a booking nobody is standing at.
        if (status !== "in_progress") {
          throw new Error(
            "Work can only be added while the booking is in progress.",
          );
        }
      },
    }),
});

/**
 * Add work discovered during the pre-job inspection to a booking that hasn't
 * started yet. Same append-and-record as the mid-job path, but the mechanic then
 * sends it through the PRE-job estimate (booking_approvals.submitPreJobEstimate)
 * so the customer confirms the added scope before any work begins — instead of
 * re-discovering and re-adding it once the job is running.
 */
export const addPreJobCustomService = mutation({
  args: customServiceAddArgs,
  handler: (ctx, args) =>
    addCustomServiceForBooking(ctx, args, {
      source: "pre_job",
      assertStatus: (status) => {
        if (status === "in_progress") {
          throw new Error(
            "This job is already in progress — add it as a mid-job change instead.",
          );
        }
        if (
          status === "completed" ||
          status === "cancelled" ||
          status === "canceled"
        ) {
          throw new Error("This booking is closed — nothing more can be added.");
        }
      },
    }),
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
 * Pull a line off a booking that hasn't started yet — the pre-job twin of
 * removeMidJobCustomService.
 *
 * A service added to the pre-job estimate (e.g. an inspection follow-up promoted
 * with "Add to this job") must be removable the same way it was added, before
 * the estimate is approved. authorizeMidJobEdit insists the job is in progress,
 * which would trap a pre-start add with no way to undo it — this allows the
 * removal while the booking is still pre-start (and not closed). No money has
 * moved (the pre-job estimate isn't approved), so there's nothing to reverse.
 */
export const removePreJobCustomService = mutation({
  args: {
    bookingId: v.id("bookings"),
    customJobId: v.id("custom_jobs"),
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

    if (booking.status === "in_progress") {
      throw new Error(
        "This job is in progress — remove it as a mid-job change instead.",
      );
    }
    if (
      booking.status === "completed" ||
      booking.status === "cancelled" ||
      booking.status === "canceled"
    ) {
      throw new Error("This booking is closed.");
    }

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
    const rows = (
      await ctx.db
        .query("custom_jobs")
        .withIndex("by_booking", (q) => q.eq("booking_id", args.bookingId))
        .collect()
    )
      // Declined mid-job lines are kept for audit but must not be surfaced to
      // the post-job survey — the mechanic isn't reporting an outcome on work
      // the customer turned down.
      .filter((r) => r.status !== "declined");
    rows.sort((a, b) => a.created_at - b.created_at);

    // Read-time part fill: a line that resolves to a catalog service we enrich
    // for (e.g. "Oil Change") but carries no stored parts gets the OEM catalog
    // parts for THIS vehicle listed here — the same parts a booked instance of
    // that service shows. This is what makes an added catalog service open with
    // its parts even when they were never seeded at add-time (older lines, or a
    // resolution miss). Stored parts always win; freeform lines resolve to no
    // service and stay parts-less. Services collected once, only when needed.
    const booking = await ctx.db.get(args.bookingId);
    const vin =
      booking && typeof (booking as any).vin === "string"
        ? (booking as any).vin
        : null;
    let servicesCache: any[] | null = null;

    const out = [];
    for (const r of rows) {
      let parts = (r.parts ?? []) as Array<{
        part_name: string;
        oem_number?: string;
        brand?: string;
        quantity: number;
        unit_price_cents?: number;
        line_total_cents?: number;
      }>;
      let estimatedMinutes = (r.estimated_minutes ?? null) as number | null;

      const needsParts = parts.length === 0;
      const needsLabor = !(
        typeof estimatedMinutes === "number" && estimatedMinutes > 0
      );
      // Fill parts AND labor from the catalog for a line we enrich for but that
      // carries neither yet — so an added catalog service opens with the parts
      // and the labor time a booked instance would show. Never overwrites stored
      // values, skips completed lines, and leaves freeform work untouched.
      if ((needsParts || needsLabor) && vin && r.status !== "completed") {
        if (!servicesCache) servicesCache = await ctx.db.query("services").collect();
        const serviceId = await resolveCatalogServiceIdByName(
          ctx,
          r.name,
          servicesCache,
        );
        if (serviceId) {
          if (needsParts) {
            const seeded = await oemPartsForServiceOnVehicle(ctx, {
              vin,
              serviceId,
            });
            if (seeded) parts = seeded;
          }
          if (needsLabor) {
            const mins = await oemLaborMinutesForServiceOnVehicle(ctx, {
              vin,
              serviceId,
            });
            if (mins) estimatedMinutes = mins;
          }
        }
      }

      out.push({
        _id: r._id,
        name: r.name,
        system_tags: (r.system_tags ?? []) as string[],
        work_type: (r.work_type ?? null) as string | null,
        parts,
        quoted_parts_cents: (r.quoted_parts_cents ?? null) as number | null,
        // Flat price for an added catalog service the shop set a fixed price
        // for (at the vehicle's tier). When present, the client shows a "Fixed
        // price" pill and the server bills the line flat, not parts+labor.
        quoted_price_cents: (r.quoted_price_cents ?? null) as number | null,
        category_id: r.category_id ?? null,
        complaint: r.complaint ?? null,
        resolution: r.resolution ?? null,
        resolved_complaint: r.resolved_complaint ?? null,
        estimated_minutes: estimatedMinutes,
        actual_minutes: r.actual_minutes ?? null,
        status: r.status,
      });
    }
    return out;
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
 * The off-catalog work a mechanic added to this job, for the customer's
 * approval screen — both the pre-job case ("found more during inspection,
 * before work begins") and the mid-job case ("found more while working").
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * The approval screen showed a price and a delta — "$472.84", "$220.08 above
 * your estimate" — and then jumped straight to inspection findings. It never
 * said what the extra money was FOR. A customer was being asked to approve a
 * number on trust, which is the exact moment trust is most expensive: they're
 * not at the shop, the car is on a lift, and declining is awkward.
 *
 * `source` is what makes this answerable. Work added before the job (the
 * pre-job estimate) is stamped "pre_job"; work added while it was running is
 * stamped "mid_job" — each at write time, so this is a read of what actually
 * happened rather than a diff of two snapshots that may not exist. Every row
 * carries its `source` so the caller renders the additions for the cycle being
 * approved, and only those.
 *
 * Returns the off-catalog additions only. A catalog service added to either
 * cycle lands on `booking.service_ids` and already renders by name through the
 * receipt's service lines; it's this half that had no route to the customer.
 */
export const listAddedServicesForCustomer = query({
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
      .filter(
        (r: any) =>
          (r.source === "mid_job" || r.source === "pre_job") &&
          r.status !== "cancelled",
      )
      .sort((a: any, b: any) => a.created_at - b.created_at)
      .map((r: any) => ({
        _id: r._id,
        name: r.name,
        // Which cycle added the line. The caller shows only the additions for
        // the approval it's rendering — pre-job on the pre-job estimate, mid-job
        // on the mid-job change — so a prior cycle's work doesn't resurface.
        source: r.source as "pre_job" | "mid_job",
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
