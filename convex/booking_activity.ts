/**
 * booking_activity.ts — Unified activity log for a single booking.
 *
 * Union-merges four existing audit sources into one chronological timeline
 * the booking drawer can render directly:
 *
 *   1. booking_status_history   → status_change events
 *   2. bookings (create-time)   → booking_created + quote_snapshot
 *   3. booking_approvals        → estimate_submitted + estimate_decision
 *   4. job_actual_part_edits    → part_edit
 *
 * No new schema. The query just assembles, resolves actor names, and sorts.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";

type Actor = {
  userId: Id<"users"> | null;
  /** Display label: "First Last", "system", or "unknown". */
  label: string;
};

type ActivityEvent =
  | {
      type: "booking_created";
      at: number;
      actor: Actor;
      data: {
        quotedSetPriceCents: number | null;
        quotedBreakdown:
          | {
              parts_cents: number;
              labor_cents: number;
              tax_cents: number;
              service_fee_cents: number;
            }
          | null;
        disclosedRangeLowCents: number | null;
        disclosedRangeHighCents: number | null;
        pricedPartsSnapshot: Array<{
          part_name: string;
          oem_number: string;
          quantity: number;
          unit_price_cents: number;
          line_total_cents: number;
        }> | null;
        services: string[];
      };
    }
  | {
      type: "status_change";
      at: number;
      actor: Actor;
      data: { from: string | null; to: string; reason: string | null };
    }
  | {
      type: "estimate_submitted";
      at: number;
      actor: Actor;
      data: {
        cycle: string;
        approvalId: Id<"booking_approvals">;
        totalCents: number;
        partsSubtotalCents: number | null;
        laborCents: number | null;
        taxCents: number | null;
        serviceFeeCents: number | null;
        priorCeilingCents: number;
        partsSnapshot: any[];
        notes: string | null;
        slaExpiresAtMs: number | null;
        autoApprovedInRange: boolean;
      };
    }
  | {
      type: "estimate_decision";
      at: number;
      actor: Actor;
      data: {
        cycle: string;
        approvalId: Id<"booking_approvals">;
        decision: string;
        totalCents: number;
        ceilingAfterDecisionCents: number | null;
      };
    }
  | {
      /* Off-catalog work landing on a booking. Derived from custom_jobs rather
         than written as its own log row, so it also covers every job recorded
         before this event existed — and can't drift from the table it
         describes.

         Worth its own type: adding work mid-job is the single most consequential
         thing that happens to a booking after it starts, and until now it showed
         up only as an estimate_submitted with a bigger number. The activity log
         said the price changed without ever saying what changed. */
      type: "custom_work_added";
      at: number;
      actor: Actor;
      data: {
        name: string;
        /** "booking" = on the original order, "mid_job" = found while working. */
        source: string;
        complaint: string | null;
        systemTags: string[];
        workType: string | null;
        estimatedMinutes: number | null;
        parts: Array<{
          part_name: string;
          oem_number: string | null;
          quantity: number;
        }>;
        quotedPartsCents: number | null;
      };
    }
  | {
      type: "part_edit";
      at: number;
      actor: Actor;
      data: {
        editType:
          | "added"
          | "removed"
          | "price"
          | "quantity"
          | "supplied_by"
          | "swap"
          | "not_used";
        partKey: string;
        partName: string | null;
        oemNumber: string | null;
        oldValue: string | null;
        newValue: string | null;
      };
    };

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

async function assertCanReadBookingActivity(
  ctx: any,
  bookingId: Id<"bookings">,
) {
  const user = await getCurrentUserOrNull(ctx);
  if (!user) throw new Error("Your session has expired. Please sign in again.");
  const booking = await ctx.db.get(bookingId);
  if (!booking) return null;

  // Customer can read their own booking's activity.
  if (String(booking.user_id) === String(user._id)) return booking;

  // Shop staff (owner or active shop_user) can read.
  if (booking.shop_id) {
    const membership = await ctx.db
      .query("shop_users")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
      .filter((q: any) => q.eq(q.field("is_active"), true))
      .first();
    if (membership && String(membership.shop_id) === String(booking.shop_id)) {
      return booking;
    }
    const ownedShop = await ctx.db
      .query("shops")
      .withIndex("by_owner_user_id", (q: any) =>
        q.eq("owner_user_id", user._id),
      )
      .first();
    if (ownedShop && String(ownedShop._id) === String(booking.shop_id)) {
      return booking;
    }
  }

  throw new Error("You are not authorized to view this booking's activity.");
}

/**
 * Resolves a user id (or sentinel string) to a display label, caching to
 * avoid N+1 lookups when the same user appears across many rows.
 */
function makeActorResolver(ctx: any) {
  const cache = new Map<string, string>();
  return async function resolveActor(
    userIdOrLabel: string | Id<"users"> | null | undefined,
  ): Promise<Actor> {
    if (userIdOrLabel == null) {
      return { userId: null, label: "unknown" };
    }
    const key = String(userIdOrLabel);
    // System / sentinel actors arrive as plain strings, not Convex ids.
    if (key === "system" || key === "stripe_webhook") {
      return { userId: null, label: key };
    }
    if (cache.has(key)) {
      return { userId: userIdOrLabel as Id<"users">, label: cache.get(key)! };
    }
    try {
      const u: any = await ctx.db.get(userIdOrLabel as Id<"users">);
      const label = u
        ? `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() ||
          u.email ||
          "user"
        : "unknown";
      cache.set(key, label);
      return { userId: userIdOrLabel as Id<"users">, label };
    } catch {
      // Not a valid id — treat as opaque label (legacy `changed_by` strings).
      return { userId: null, label: key };
    }
  };
}

export const getBookingActivityLog = query({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, args): Promise<ActivityEvent[]> => {
    const booking: any = await assertCanReadBookingActivity(
      ctx,
      args.bookingId,
    );
    if (!booking) return [];

    const [statusHistory, approvals, partEdits, services, customJobs] = await Promise.all([
      ctx.db
        .query("booking_status_history")
        .withIndex("by_booking_id", (q: any) =>
          q.eq("booking_id", args.bookingId),
        )
        .collect(),
      ctx.db
        .query("booking_approvals")
        .withIndex("by_booking_and_cycle", (q: any) =>
          q.eq("booking_id", args.bookingId),
        )
        .collect(),
      ctx.db
        .query("job_actual_part_edits")
        .withIndex("by_booking_id", (q: any) =>
          q.eq("booking_id", args.bookingId),
        )
        .collect(),
      Promise.all(
        ((booking.service_ids ?? []) as Id<"services">[]).map(
          async (sid) => ((await ctx.db.get(sid)) as any)?.name as string | undefined,
        ),
      ),
      ctx.db
        .query("custom_jobs")
        .withIndex("by_booking", (q: any) => q.eq("booking_id", args.bookingId))
        .collect(),
    ]);

    const resolveActor = makeActorResolver(ctx);
    const events: ActivityEvent[] = [];

    // ── 1. Booking created (synthesized; carries the quote snapshot) ────
    // Prefer the first status_history row (old_status == null) for the
    // canonical actor + timestamp; fall back to booking._creationTime.
    const createRow = statusHistory.find((r: any) => r.old_status == null);
    const createdAt =
      (createRow?.changed_at as number | undefined) ??
      (booking.created_at as number | undefined) ??
      (booking._creationTime as number);
    const createdActor = await resolveActor(
      createRow?.changed_by ?? booking.user_id ?? null,
    );
    events.push({
      type: "booking_created",
      at: createdAt,
      actor: createdActor,
      data: {
        quotedSetPriceCents: booking.quoted_set_price_cents ?? null,
        quotedBreakdown: booking.quoted_breakdown ?? null,
        disclosedRangeLowCents: booking.disclosed_range_low_cents ?? null,
        disclosedRangeHighCents: booking.disclosed_range_high_cents ?? null,
        pricedPartsSnapshot: booking.priced_parts_snapshot ?? null,
        services: services.filter((n): n is string => !!n),
      },
    });

    // ── 2. Subsequent status changes ────────────────────────────────────
    for (const row of statusHistory) {
      if (row.old_status == null) continue; // already captured as booking_created
      events.push({
        type: "status_change",
        at: row.changed_at,
        actor: await resolveActor(row.changed_by ?? null),
        data: {
          from: row.old_status ?? null,
          to: row.new_status,
          reason: row.reason ?? null,
        },
      });
    }

    // ── 3. Estimate submissions + decisions ─────────────────────────────
    for (const a of approvals) {
      const submittedActor = await resolveActor(
        a.submitted_by_user_id ?? null,
      );
      events.push({
        type: "estimate_submitted",
        at: a.submitted_at_ms,
        actor: submittedActor,
        data: {
          cycle: a.cycle,
          approvalId: a._id,
          totalCents: a.mechanic_set_price_cents,
          partsSubtotalCents: a.parts_subtotal_cents ?? null,
          laborCents: a.labor_cents ?? null,
          taxCents: a.tax_cents ?? null,
          serviceFeeCents: a.service_fee_cents ?? null,
          priorCeilingCents: a.prior_ceiling_cents,
          partsSnapshot: a.parts_snapshot ?? [],
          notes: a.notes ?? null,
          slaExpiresAtMs: a.sla_expires_at_ms ?? null,
          autoApprovedInRange:
            a.decision === "auto_approved_within_range" &&
            a.decided_at_ms === a.submitted_at_ms,
        },
      });

      // Emit a separate decision event only when the decision happened
      // strictly after the submission. Auto-approved-in-range rows have
      // decided_at_ms === submitted_at_ms and are already represented by
      // the submission event's `autoApprovedInRange: true` flag.
      if (
        a.decision != null &&
        a.decided_at_ms != null &&
        a.decided_at_ms !== a.submitted_at_ms
      ) {
        const decisionActor = a.decided_by_user_id
          ? await resolveActor(a.decided_by_user_id)
          : await resolveActor(a.decision_actor ?? "system");
        events.push({
          type: "estimate_decision",
          at: a.decided_at_ms,
          actor: decisionActor,
          data: {
            cycle: a.cycle,
            approvalId: a._id,
            decision: a.decision,
            totalCents: a.mechanic_set_price_cents,
            ceilingAfterDecisionCents: a.ceiling_after_decision_cents ?? null,
          },
        });
      }
    }

    // ── 4. Per-line part edits ──────────────────────────────────────────
    for (const e of partEdits) {
      events.push({
        type: "part_edit",
        at: e.edited_at,
        actor: await resolveActor(e.edited_by_user_id),
        data: {
          editType: e.edit_type,
          partKey: e.part_key,
          partName: e.part_name_snapshot ?? null,
          oemNumber: e.oem_number_snapshot ?? null,
          oldValue: e.old_value ?? null,
          newValue: e.new_value ?? null,
        },
      });
    }

    // ── 5. Off-catalog work ─────────────────────────────────────────────
    for (const job of customJobs as any[]) {
      if (job.status === "cancelled") continue;
      events.push({
        type: "custom_work_added",
        at: job.created_at,
        // custom_jobs stores a mechanics id, which is not a users id — the
        // resolver keys on users, so pass the booking's mechanic through the
        // same path the other events use rather than guessing.
        actor: await resolveActor(booking.mechanic_id ?? null),
        data: {
          name: job.name,
          source: job.source ?? "booking",
          complaint: job.complaint ?? null,
          systemTags: (job.system_tags ?? []) as string[],
          workType: job.work_type ?? null,
          estimatedMinutes: job.estimated_minutes ?? null,
          parts: ((job.parts ?? []) as any[]).map((part) => ({
            part_name: part.part_name,
            oem_number: part.oem_number ?? null,
            quantity: part.quantity,
          })),
          quotedPartsCents: job.quoted_parts_cents ?? null,
        },
      });
    }

    events.sort((a, b) => a.at - b.at);
    return events;
  },
});
