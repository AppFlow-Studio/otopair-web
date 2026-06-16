import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

/**
 * director_mechanic_edits — cross-cutting "what did the mechanic change on this
 * job" data for the Director "Mechanic Edits" detail modal.
 *
 * The `mechanic_verifications` row already carries the vehicle-SPEC review
 * (confirmed/corrected). This query supplies the other three change surfaces a
 * mechanic touches during a job, each of which lives in its own table:
 *
 *   • parts  → job_actual_part_edits  (price / swap / qty / added / removed …)
 *   • quote  → booking_approvals      (pre_job / mid_job / post_job cycles)
 *   • labor  → estimated (booking) vs actual (job_actual) minutes
 *
 * Read-only and display-only — none of these have the accept/reject/undo review
 * workflow that the spec verifications do. Keyed off the job_actual id that
 * mechanic_verifications stores in `job_id`.
 */
export const getJobChanges = query({
  args: { jobId: v.string() },
  handler: async (ctx, { jobId }) => {
    const empty = {
      partEdits: [] as any[],
      quoteCycles: [] as any[],
      laborEdits: [] as any[],
      labor: null as null | {
        estimated_minutes: number | null;
        actual_minutes: number | null;
        delta_minutes: number | null;
      },
    };

    // jobId is the stringified job_actuals id persisted on the verification row.
    let jobActual: any = null;
    try {
      jobActual = await ctx.db.get(jobId as Id<"job_actuals">);
    } catch {
      jobActual = null;
    }
    if (!jobActual) return empty;

    const bookingId = jobActual.booking_id;
    const booking: any = bookingId ? await ctx.db.get(bookingId) : null;

    // ── Parts: append-only edit log for this job_actual ────────────────────
    const partRows = await ctx.db
      .query("job_actual_part_edits")
      .withIndex("by_job_actual_id", (q: any) =>
        q.eq("job_actual_id", jobActual._id),
      )
      .collect();
    partRows.sort((a: any, b: any) => (a.edited_at ?? 0) - (b.edited_at ?? 0));
    const partEdits = partRows.map((e: any) => ({
      edit_type: e.edit_type,
      part_name: e.part_name_snapshot ?? null,
      oem_number: e.oem_number_snapshot ?? null,
      old_value: e.old_value ?? null,
      new_value: e.new_value ?? null,
      edited_at: e.edited_at ?? null,
    }));

    // ── Quote: approval cycles for this booking (pre/mid/post) ─────────────
    let quoteCycles: any[] = [];
    if (bookingId) {
      const approvals = await ctx.db
        .query("booking_approvals")
        .withIndex("by_booking_and_cycle", (q: any) =>
          q.eq("booking_id", bookingId),
        )
        .collect();
      approvals.sort(
        (a: any, b: any) => (a.submitted_at_ms ?? 0) - (b.submitted_at_ms ?? 0),
      );
      quoteCycles = approvals.map((a: any) => ({
        cycle: a.cycle ?? null,
        set_price_cents: a.mechanic_set_price_cents ?? null,
        parts_cents: a.parts_subtotal_cents ?? null,
        labor_cents: a.labor_cents ?? null,
        labor_hours: a.labor_hours ?? null,
        decision: a.decision ?? null,
        submitted_at: a.submitted_at_ms ?? null,
        decided_at: a.decided_at_ms ?? null,
      }));
    }

    // ── Labor edits: append-only log of mechanic labor-time changes ────────
    const laborRows = await ctx.db
      .query("job_actual_labor_edits")
      .withIndex("by_job_actual_id", (q: any) =>
        q.eq("job_actual_id", jobActual._id),
      )
      .collect();
    laborRows.sort((a: any, b: any) => (a.edited_at ?? 0) - (b.edited_at ?? 0));
    const laborEdits = laborRows.map((e: any) => ({
      old_minutes: typeof e.old_minutes === "number" ? e.old_minutes : null,
      new_minutes: typeof e.new_minutes === "number" ? e.new_minutes : null,
      edited_at: e.edited_at ?? null,
    }));

    // ── Labor: estimated (booking quote) vs actual (logged) ────────────────
    const estMin =
      typeof booking?.estimated_labor_minutes === "number"
        ? booking.estimated_labor_minutes
        : null;
    const actMin =
      typeof jobActual.actual_labor_minutes === "number"
        ? jobActual.actual_labor_minutes
        : null;
    const labor =
      estMin != null || actMin != null
        ? {
            estimated_minutes: estMin,
            actual_minutes: actMin,
            delta_minutes:
              estMin != null && actMin != null ? actMin - estMin : null,
          }
        : null;

    return { partEdits, quoteCycles, laborEdits, labor };
  },
});
