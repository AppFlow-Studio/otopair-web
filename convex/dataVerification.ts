// =============================================================================
// Data portal · Verification & Variance — /data/verification (Data spec §10.3).
// Four streams: mechanic verifications (Tier 3, with milestone chips) ·
// spec variances (flagged-first, reviewed toggle) · post-job confirmations ·
// empirical labor ledger. Verifications are 0 live today — rendered at 0 per
// the honest-counter doctrine.
// =============================================================================
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query } from "./_generated/server";
import { requireDirector, logAudit } from "./directorGate";

// --- Authored return types (see dataOverview.ts header) -----------------------

export type VerificationRow = {
  id: string;
  mechanic: string | null;
  config_key: string | null;
  service: string | null;
  status: string | null;
  overall_accuracy: number | null;
  actual_labor_hours: number | null;
  parts_used_correct: boolean | null;
  field_verdicts: { field: string; verdict: string; old_value?: string; new_value?: string }[];
  milestones: string[];
  at: number;
};

export const verificationStream = query({
  args: { token: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (
    ctx,
    { token, paginationOpts },
  ): Promise<{
    page: VerificationRow[];
    isDone: boolean;
    continueCursor: string;
  }> => {
    await requireDirector(ctx, token);
    const page = await ctx.db
      .query("mechanic_verifications")
      .order("desc")
      .paginate(paginationOpts);

    const mechName = new Map<string, string | null>();
    const configKey = new Map<string, { key: string | null; verified: boolean }>();
    const serviceName = new Map<string, string | null>();

    const rows: VerificationRow[] = [];
    for (const r of page.page) {
      // mechanic
      const mid = String(r.mechanic_id);
      if (!mechName.has(mid)) {
        const m = await ctx.db.get(r.mechanic_id);
        mechName.set(mid, m ? ((m as { name?: string }).name ?? null) : null);
      }
      // config + "config verified" milestone (3+ verifications)
      const cid = String(r.vehicle_config_id);
      if (!configKey.has(cid)) {
        const c = await ctx.db.get(r.vehicle_config_id);
        configKey.set(cid, {
          key: c?.config_key ?? null,
          verified: (c?.verification_count ?? 0) >= 3,
        });
      }
      // service + "→ empirical" milestone (3+ samples on the pair)
      let service: string | null = null;
      let empirical = false;
      if (r.service_id) {
        const sid = String(r.service_id);
        if (!serviceName.has(sid)) {
          const s = await ctx.db.get(r.service_id);
          serviceName.set(sid, s ? ((s as { name?: string }).name ?? null) : null);
        }
        service = serviceName.get(sid) ?? null;
        const lt = await ctx.db
          .query("labor_times")
          .withIndex("by_vehicle_config_and_service", (q) =>
            q.eq("vehicle_config_id", r.vehicle_config_id).eq("service_id", r.service_id!),
          )
          .first();
        empirical = (lt?.empirical_sample_size ?? 0) >= 3;
      }

      // Per-field verdicts, rendered tolerantly from the v.any() blob.
      const verdicts: VerificationRow["field_verdicts"] = [];
      const blob = r.verifications as unknown;
      if (blob && typeof blob === "object" && !Array.isArray(blob)) {
        for (const [field, raw] of Object.entries(blob as Record<string, unknown>)) {
          if (raw && typeof raw === "object") {
            const o = raw as { verdict?: string; status?: string; old?: unknown; new?: unknown; value?: unknown };
            verdicts.push({
              field,
              verdict: o.verdict ?? o.status ?? "confirmed",
              old_value: o.old != null ? String(o.old) : undefined,
              new_value: o.new != null ? String(o.new) : o.value != null ? String(o.value) : undefined,
            });
          } else if (raw != null) {
            verdicts.push({ field, verdict: String(raw) });
          }
        }
      } else if (Array.isArray(blob)) {
        for (const entry of blob) {
          if (entry && typeof entry === "object") {
            const o = entry as { field?: string; verdict?: string; status?: string; old?: unknown; new?: unknown };
            verdicts.push({
              field: o.field ?? "(field)",
              verdict: o.verdict ?? o.status ?? "confirmed",
              old_value: o.old != null ? String(o.old) : undefined,
              new_value: o.new != null ? String(o.new) : undefined,
            });
          }
        }
      }

      const milestones: string[] = [];
      const cfg = configKey.get(cid);
      if (cfg?.verified) milestones.push("config verified (3+ verifications)");
      if (empirical) milestones.push("→ empirical at 3+ samples");

      rows.push({
        id: String(r._id),
        mechanic: mechName.get(mid) ?? null,
        config_key: cfg?.key ?? null,
        service,
        status: r.status ?? null,
        overall_accuracy: r.overall_accuracy ?? null,
        actual_labor_hours: r.actual_labor_hours ?? null,
        parts_used_correct: r.parts_used_correct ?? null,
        field_verdicts: verdicts,
        milestones,
        at: r.verified_at ?? r.created_at ?? r._creationTime,
      });
    }
    return { page: rows, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export type VarianceRow = {
  id: string;
  engine: string | null;
  service: string | null;
  predicted_labor_hours: number | null;
  actual_labor_hours: number | null;
  predicted_parts_cost: number | null;
  actual_parts_cost: number | null;
  variance_percentage: number | null;
  flagged: boolean;
  reviewed_at: number | null;
  notes: string | null;
  at: number;
};
export type VariancesResult = {
  flagged: VarianceRow[];
  recent: VarianceRow[];
  medians_by_service: { service: string; median_variance: number; n: number }[];
  window_note: string;
};

export const variances = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<VariancesResult> => {
    await requireDirector(ctx, token);
    const engineLabel = new Map<string, string | null>();
    const serviceName = new Map<string, string | null>();
    const hydrate = async (r: {
      _id: unknown;
      _creationTime: number;
      engine_id: import("./_generated/dataModel").Id<"engines">;
      service_id: import("./_generated/dataModel").Id<"services">;
      predicted_labor_hours?: number;
      actual_labor_hours?: number;
      predicted_parts_cost?: number;
      actual_parts_cost?: number;
      variance_percentage?: number;
      flagged_for_review?: boolean;
      reviewed_at?: number;
      notes?: string;
      created_at?: number;
    }): Promise<VarianceRow> => {
      const eid = String(r.engine_id);
      if (!engineLabel.has(eid)) {
        const e = await ctx.db.get(r.engine_id);
        const eo = e as { engine_code?: string; name?: string } | null;
        engineLabel.set(eid, eo?.engine_code ?? eo?.name ?? null);
      }
      const sid = String(r.service_id);
      if (!serviceName.has(sid)) {
        const s = await ctx.db.get(r.service_id);
        serviceName.set(sid, s ? ((s as { name?: string }).name ?? null) : null);
      }
      return {
        id: String(r._id),
        engine: engineLabel.get(eid) ?? null,
        service: serviceName.get(sid) ?? null,
        predicted_labor_hours: r.predicted_labor_hours ?? null,
        actual_labor_hours: r.actual_labor_hours ?? null,
        predicted_parts_cost: r.predicted_parts_cost ?? null,
        actual_parts_cost: r.actual_parts_cost ?? null,
        variance_percentage: r.variance_percentage ?? null,
        flagged: r.flagged_for_review === true,
        reviewed_at: r.reviewed_at ?? null,
        notes: r.notes ?? null,
        at: r.created_at ?? r._creationTime,
      };
    };

    const flaggedRows = await ctx.db
      .query("spec_variances")
      .withIndex("by_flagged", (q) => q.eq("flagged_for_review", true))
      .order("desc")
      .take(100);
    const recentRows = await ctx.db
      .query("spec_variances")
      .withIndex("by_created_at")
      .order("desc")
      .take(100);

    const flagged: VarianceRow[] = [];
    for (const r of flaggedRows) flagged.push(await hydrate(r));
    const recent: VarianceRow[] = [];
    for (const r of recentRows) recent.push(await hydrate(r));

    // Medians by service over the recent window (honest: labeled as such).
    const byService = new Map<string, number[]>();
    for (const r of recent) {
      if (r.variance_percentage == null || r.service == null) continue;
      const list = byService.get(r.service) ?? [];
      list.push(r.variance_percentage);
      byService.set(r.service, list);
    }
    const medians = [...byService.entries()].map(([service, vals]) => {
      const sorted = [...vals].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      return { service, median_variance: median, n: vals.length };
    });

    return {
      flagged,
      recent,
      medians_by_service: medians.sort((a, b) => b.n - a.n),
      window_note: "medians computed over the most recent 100 variances, not lifetime",
    };
  },
});

export type ConfirmationRow = {
  id: string;
  service: string | null;
  confirmed_accurate: boolean;
  feedback: string | null;
  at: number;
};

export const confirmations = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<ConfirmationRow[]> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db
      .query("spec_confirmations")
      .withIndex("by_confirmed_at")
      .order("desc")
      .take(100);
    const serviceName = new Map<string, string | null>();
    const out: ConfirmationRow[] = [];
    for (const r of rows) {
      const sid = String(r.service_id);
      if (!serviceName.has(sid)) {
        const s = await ctx.db.get(r.service_id);
        serviceName.set(sid, s ? ((s as { name?: string }).name ?? null) : null);
      }
      out.push({
        id: String(r._id),
        service: serviceName.get(sid) ?? null,
        confirmed_accurate: r.confirmed_accurate,
        feedback: r.feedback ?? null,
        at: r.confirmed_at,
      });
    }
    return out;
  },
});

export type EmpiricalRow = {
  id: string;
  config_key: string | null;
  service: string | null;
  empirical_hours: number;
  sample_size: number;
  p25: number | null;
  p75: number | null;
  book_hours: number | null;
};

export const empiricalLedger = query({
  args: { token: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (
    ctx,
    { token, paginationOpts },
  ): Promise<{ page: EmpiricalRow[]; isDone: boolean; continueCursor: string }> => {
    await requireDirector(ctx, token);
    const page = await ctx.db.query("labor_times").paginate(paginationOpts);
    const configKey = new Map<string, string | null>();
    const serviceName = new Map<string, string | null>();
    const rows: EmpiricalRow[] = [];
    for (const r of page.page) {
      if (r.empirical_hours == null) continue; // ledger = empirical rows only
      let cfg: string | null = null;
      if (r.vehicle_config_id) {
        const cid = String(r.vehicle_config_id);
        if (!configKey.has(cid)) {
          const c = await ctx.db.get(r.vehicle_config_id);
          configKey.set(cid, c?.config_key ?? null);
        }
        cfg = configKey.get(cid) ?? null;
      }
      const sid = String(r.service_id);
      if (!serviceName.has(sid)) {
        const s = await ctx.db.get(r.service_id);
        serviceName.set(sid, s ? ((s as { name?: string }).name ?? null) : null);
      }
      rows.push({
        id: String(r._id),
        config_key: cfg,
        service: serviceName.get(sid) ?? null,
        empirical_hours: r.empirical_hours,
        sample_size: r.empirical_sample_size ?? 0,
        p25: r.empirical_p25 ?? null,
        p75: r.empirical_p75 ?? null,
        book_hours: r.book_hours ?? null,
      });
    }
    return { page: rows, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export const markVarianceReviewed = mutation({
  args: { token: v.string(), reason: v.string(), id: v.id("spec_variances") },
  handler: async (ctx, { token, reason, id }): Promise<{ ok: true }> => {
    const actor = await requireDirector(ctx, token, "data.write");
    if (reason.trim().length < 4) throw new Error("A reason is required.");
    const row = await ctx.db.get(id);
    if (!row) throw new Error("That variance row no longer exists.");
    if (row.reviewed_at != null) throw new Error("Already marked reviewed.");
    await ctx.db.patch(id, { reviewed_at: Date.now() });
    await logAudit(ctx, actor, {
      entity_type: "spec_variance",
      entity_id: String(id),
      action: "variance_reviewed",
      detail: reason.trim(),
    });
    return { ok: true };
  },
});
