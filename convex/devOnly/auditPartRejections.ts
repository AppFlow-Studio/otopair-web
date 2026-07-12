/**
 * devOnly/auditPartRejections — READ-ONLY empirical audit of the OEM part
 * pattern layer (contentSanitization.sanitizePartNumber).
 *
 * The pattern allowlist can't be PROVEN complete for vehicles we haven't seen
 * — this replays real-world evidence against the CURRENT patterns instead:
 *
 *   rejects leg — every `oem_part_rejected: <raw>` ledgered in
 *     enrichment_runs.field_gaps, re-tested for its config's make. A value
 *     that now passes/salvages = a pattern bug that WAS fixed; one that still
 *     fails = open triage (real SKU means the pattern needs widening).
 *
 *   accepted leg — every current oem_parts row, re-tested for its own make.
 *     Any accepted part that would NOW be rejected = a pattern-change
 *     regression (this is the pre-deploy safety check for pattern edits).
 *
 *   npx convex run devOnly/auditPartRejections:audit '{}'
 *   npx convex run devOnly/auditPartRejections:audit '{"maxParts": 20000}'
 *
 * `audit` is an ACTION driving one-paginated-query-per-call pages (Convex
 * allows a single paginated query per query function).
 */
import { internalQuery, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { sanitizePartNumber } from "../vehicleEnrichment/contentSanitization";

const REJECT_PREFIX = "validation_dropped:oem_part_rejected: ";

/** Historical rejects from the most recent enrichment runs (take, no paginate). */
export const rejectsLeg = internalQuery({
  args: { maxRuns: v.optional(v.float64()) },
  handler: async (ctx, args) => {
    const runs = await ctx.db.query("enrichment_runs").order("desc").take(args.maxRuns ?? 500);
    const out: Array<{ make: string | null; field: string; raw: string; configKey: string | null }> = [];
    const metaByConfig = new Map<string, { make: string | null; key: string | null }>();
    for (const run of runs as any[]) {
      const gaps: Array<{ field: string; reason: string }> = run.field_gaps ?? [];
      const hits = gaps.filter((g) => g.reason.startsWith(REJECT_PREFIX));
      if (hits.length === 0) continue;
      const cfgId = String(run.vehicle_config_id ?? "");
      if (cfgId && !metaByConfig.has(cfgId)) {
        const cfg = run.vehicle_config_id ? ((await ctx.db.get(run.vehicle_config_id)) as any) : null;
        const make = cfg?.make_id ? ((await ctx.db.get(cfg.make_id)) as any) : null;
        metaByConfig.set(cfgId, { make: make?.name ?? null, key: cfg?.config_key ?? null });
      }
      const meta = metaByConfig.get(cfgId) ?? { make: null, key: null };
      for (const g of hits) {
        out.push({
          make: meta.make,
          field: g.field,
          raw: g.reason.slice(REJECT_PREFIX.length).trim(),
          configKey: meta.key,
        });
      }
    }
    return out;
  },
});

/** One page of current oem_parts with resolved make names. */
export const acceptedPage = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("oem_parts")
      .paginate({ cursor: args.cursor ?? null, numItems: 200 });
    const out: Array<{ make: string | null; oem: string; name: string | null }> = [];
    const makeNameCache = new Map<string, string | null>();
    for (const part of page.page as any[]) {
      if (part.is_current === false || !part.make_id) continue;
      const mk = String(part.make_id);
      if (!makeNameCache.has(mk)) {
        const make = (await ctx.db.get(part.make_id)) as any;
        makeNameCache.set(mk, make?.name ?? null);
      }
      out.push({ make: makeNameCache.get(mk) ?? null, oem: part.oem_part_number, name: part.name ?? null });
    }
    return { parts: out, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

export const audit = internalAction({
  args: {
    maxRuns: v.optional(v.float64()),
    maxParts: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const maxParts = args.maxParts ?? 10000;

    // ── Leg 1: historical rejects vs current patterns ──
    const rejects: Array<{ make: string | null; field: string; raw: string; configKey: string | null }> =
      await ctx.runQuery(internal.devOnly.auditPartRejections.rejectsLeg, { maxRuns: args.maxRuns });
    const judged = rejects.map((r) => ({
      ...r,
      nowAccepted: r.make ? sanitizePartNumber(r.raw, r.make) : null,
    }));

    // ── Leg 2: accepted parts vs current patterns (regression detector) ──
    const regressions: Array<{ make: string | null; oem: string; name: string | null }> = [];
    let scanned = 0;
    let cursor: string | null = null;
    while (scanned < maxParts) {
      const page: {
        parts: Array<{ make: string | null; oem: string; name: string | null }>;
        continueCursor: string;
        isDone: boolean;
      } = await ctx.runQuery(internal.devOnly.auditPartRejections.acceptedPage, { cursor });
      for (const p of page.parts) {
        scanned++;
        if (!p.make) continue;
        if (sanitizePartNumber(p.oem, p.make) == null) regressions.push(p);
      }
      cursor = page.continueCursor;
      if (page.isDone) break;
    }

    // ── Summary ──
    const byMake: Record<string, { total: number; nowPass: number; stillRejected: string[] }> = {};
    for (const r of judged) {
      const k = r.make ?? "(unknown make)";
      byMake[k] ??= { total: 0, nowPass: 0, stillRejected: [] };
      byMake[k].total++;
      if (r.nowAccepted != null) byMake[k].nowPass++;
      else if (byMake[k].stillRejected.length < 20) byMake[k].stillRejected.push(`${r.field}=${r.raw}`);
    }

    return {
      rejectsAudit: {
        totalLedgered: judged.length,
        nowAccepted: judged.filter((r) => r.nowAccepted != null).length,
        stillRejected: judged.filter((r) => r.nowAccepted == null).length,
        byMake,
      },
      acceptedAudit: {
        partsScanned: scanned,
        regressions: regressions.length,
        samples: regressions.slice(0, 30),
      },
    };
  },
});
