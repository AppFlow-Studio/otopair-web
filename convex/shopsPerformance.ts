// =============================================================================
// Shops portal · Performance — /shops/performance (Shops spec p.8, QUALITY).
// Calibration: median labor variance % by service from spec_variances (0 rows
// live today — honest empty until post-job surveys flow), with per-shop dots
// via job_actual → booking joins. League: reuses shopsNetwork.leagueTable.
// Difficulty-vs-estimate scatter DESCOPED (needs estimate archaeology).
// "Systematically wrong" services carry the → Data portal chip.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

// --- Authored return types (see dataOverview.ts header) -----------------------

export type CalibrationService = {
  service: string;
  median_variance_pct: number;
  n: number;
  systematically_wrong: boolean; // |median| > 10% at n >= 3
  shop_dots: { shop: string; variance_pct: number }[];
};

export const calibration = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<{ services: CalibrationService[]; samples: number }> => {
    await requireDirector(ctx, token);
    // spec_variances holds predicted vs actual per job (0 live today).
    const rows = await ctx.db
      .query("spec_variances")
      .withIndex("by_created_at")
      .order("desc")
      .take(200);
    const serviceName = new Map<string, string | null>();
    const shopName = new Map<string, string | null>();
    const byService = new Map<string, { variances: number[]; dots: { shop: string; variance_pct: number }[] }>();

    for (const r of rows) {
      if (r.predicted_labor_hours == null || r.actual_labor_hours == null) continue;
      if (r.predicted_labor_hours === 0) continue;
      const variancePct =
        ((r.actual_labor_hours - r.predicted_labor_hours) / r.predicted_labor_hours) * 100;

      const sid = String(r.service_id);
      if (!serviceName.has(sid)) {
        const s = await ctx.db.get(r.service_id);
        serviceName.set(sid, s ? ((s as { name?: string }).name ?? null) : null);
      }
      const svc = serviceName.get(sid) ?? "Unknown service";

      // Shop via job_actual → booking (bounded: one get chain per row).
      let shop = "Unknown shop";
      const ja = await ctx.db.get(r.job_actual_id);
      if (ja) {
        const booking = await ctx.db.get(ja.booking_id);
        const shopId = (booking as { shop_id?: import("./_generated/dataModel").Id<"shops"> } | null)
          ?.shop_id;
        if (shopId) {
          const key = String(shopId);
          if (!shopName.has(key)) {
            const s = await ctx.db.get(shopId);
            shopName.set(key, s ? ((s as { name?: string }).name ?? null) : null);
          }
          shop = shopName.get(key) ?? shop;
        }
      }

      const bucket = byService.get(svc) ?? { variances: [], dots: [] };
      bucket.variances.push(variancePct);
      bucket.dots.push({ shop, variance_pct: variancePct });
      byService.set(svc, bucket);
    }

    const services: CalibrationService[] = [...byService.entries()].map(([service, b]) => {
      const sorted = [...b.variances].sort((a, x) => a - x);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      return {
        service,
        median_variance_pct: median,
        n: b.variances.length,
        systematically_wrong: Math.abs(median) > 10 && b.variances.length >= 3,
        shop_dots: b.dots,
      };
    });

    return {
      services: services.sort(
        (a, b) => Math.abs(b.median_variance_pct) - Math.abs(a.median_variance_pct),
      ),
      samples: rows.length,
    };
  },
});
