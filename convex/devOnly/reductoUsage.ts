/**
 * devOnly/reductoUsage — what has Reducto actually billed us for?
 *
 * Reducto charges per PAGE and publishes no usage or credits endpoint (18 paths
 * on the API, checked against /openapi.json). What it does expose is
 * `GET /jobs`, and every job carries `num_pages` — which IS the billing unit.
 * Summing it is the closest thing to a meter we have, and it is what turns "the
 * bill looked big" into a number attached to specific documents.
 *
 *   npx convex run devOnly/reductoUsage:report
 *   npx convex run devOnly/reductoUsage:report '{"limit":200,"pageRate":0.042}'
 *
 * `pageRate` is an ESTIMATE derived from a real invoice — three manuals for
 * roughly $50 against a 395-page document — not a published price. The page
 * counts are exact; the dollar column is arithmetic on top of an assumption, so
 * it is labelled as such rather than presented as billing truth.
 */
import { internalAction } from "../_generated/server";
import { v } from "convex/values";

const REDUCTO_BASE = "https://platform.reducto.ai";

export const report = internalAction({
  args: {
    limit: v.optional(v.float64()),
    /** $/page. Default from the measured ~$16.67 for a 395-page manual. */
    pageRate: v.optional(v.float64()),
  },
  handler: async (_ctx, args): Promise<any> => {
    const key = process.env.REDUCTO_API_KEY;
    if (!key) return { error: "no_reducto_api_key" };
    const rate = args.pageRate ?? 0.042;
    const limit = Math.min(Math.max(1, Math.trunc(args.limit ?? 100)), 500);

    let res: Response;
    try {
      res = await fetch(`${REDUCTO_BASE}/jobs?limit=${limit}&exclude_configs=true`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      return { error: `transport:${String(e).slice(0, 160)}` };
    }
    if (!res.ok) {
      // A 401 here has meant an exhausted/invalid key, not a permissions quirk
      // — it 401'd on /jobs and /extract alike while the account was down.
      return { error: `jobs_${res.status}`, detail: (await res.text().catch(() => "")).slice(0, 200) };
    }

    const body: any = await res.json();
    const jobs: any[] = Array.isArray(body?.jobs) ? body.jobs : [];

    let pages = 0;
    const byType: Record<string, { jobs: number; pages: number }> = {};
    const byStatus: Record<string, number> = {};
    const largest: Array<{ job_id: string; pages: number; type: string; created_at: string }> = [];

    for (const j of jobs) {
      const n = Number(j?.num_pages ?? j?.total_pages ?? 0) || 0;
      pages += n;
      const t = String(j?.type ?? "unknown");
      byType[t] = byType[t] ?? { jobs: 0, pages: 0 };
      byType[t].jobs++;
      byType[t].pages += n;
      const st = String(j?.status ?? "unknown");
      byStatus[st] = (byStatus[st] ?? 0) + 1;
      largest.push({
        job_id: String(j?.job_id ?? ""),
        pages: n,
        type: t,
        created_at: String(j?.created_at ?? ""),
      });
    }
    largest.sort((a, b) => b.pages - a.pages);

    const out = {
      jobs: jobs.length,
      total_pages: pages,
      estimated_cost_usd: Number((pages * rate).toFixed(2)),
      page_rate_assumed: rate,
      avg_pages_per_job: jobs.length ? Number((pages / jobs.length).toFixed(1)) : 0,
      by_type: byType,
      by_status: byStatus,
      largest_jobs: largest.slice(0, 10),
      note:
        "page counts are exact from the API; the dollar figure assumes " +
        `$${rate}/page derived from a real invoice, not a published rate`,
    };
    console.log(
      `[reducto-usage] ${out.jobs} job(s), ${out.total_pages} pages, ` +
        `~$${out.estimated_cost_usd} at $${rate}/page (avg ${out.avg_pages_per_job} pages/job)`,
    );
    return out;
  },
});
