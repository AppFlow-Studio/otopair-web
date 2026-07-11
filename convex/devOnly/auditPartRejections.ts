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
 *   npx convex run devOnly/auditPartRejections:audit '{"maxParts": 2000}'
 */
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { sanitizePartNumber } from "../vehicleEnrichment/contentSanitization";

const REJECT_PREFIX = "validation_dropped:oem_part_rejected: ";

export const audit = internalQuery({
  args: {
    maxRuns: v.optional(v.float64()),
    maxParts: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const maxRuns = args.maxRuns ?? 500;
    const maxParts = args.maxParts ?? 5000;

    // ── Leg 1: historical rejects, re-tested against current patterns ──
    const rejects: Array<{
      make: string | null;
      field: string;
      raw: string;
      nowAccepted: string | null; // sanitized/salvaged value, or null = still rejected
      configKey: string | null;
    }> = [];
    const runs = await ctx.db.query("enrichment_runs").order("desc").take(maxRuns);
    const makeByConfig = new Map<string, { make: string | null; key: string | null }>();
    for (const run of runs as any[]) {
      const gaps: Array<{ field: string; reason: string }> = run.field_gaps ?? [];
      const hits = gaps.filter((g) => g.reason.startsWith(REJECT_PREFIX));
      if (hits.length === 0) continue;

      const cfgId = String(run.vehicle_config_id ?? "");
      if (cfgId && !makeByConfig.has(cfgId)) {
        const cfg = run.vehicle_config_id ? ((await ctx.db.get(run.vehicle_config_id)) as any) : null;
        const make = cfg?.make_id ? ((await ctx.db.get(cfg.make_id)) as any) : null;
        makeByConfig.set(cfgId, { make: make?.name ?? null, key: cfg?.config_key ?? null });
      }
      const meta = makeByConfig.get(cfgId) ?? { make: null, key: null };

      for (const g of hits) {
        const raw = g.reason.slice(REJECT_PREFIX.length).trim();
        rejects.push({
          make: meta.make,
          field: g.field,
          raw,
          nowAccepted: meta.make ? sanitizePartNumber(raw, meta.make) : null,
          configKey: meta.key,
        });
      }
    }

    // ── Leg 2: accepted parts, re-tested (pattern-regression detector) ──
    const regressions: Array<{ make: string | null; oem: string; name: string | null }> = [];
    let scanned = 0;
    const makeNameCache = new Map<string, string | null>();
    let cursor: string | null = null;
    while (scanned < maxParts) {
      const page: any = await ctx.db
        .query("oem_parts")
        .paginate({ cursor, numItems: 200 });
      for (const part of page.page as any[]) {
        scanned++;
        if (part.is_current === false) continue;
        if (!part.make_id) continue; // universal consumables carry no make pattern
        const mk = String(part.make_id);
        if (!makeNameCache.has(mk)) {
          const make = (await ctx.db.get(part.make_id)) as any;
          makeNameCache.set(mk, make?.name ?? null);
        }
        const makeName = makeNameCache.get(mk);
        if (!makeName) continue;
        if (sanitizePartNumber(part.oem_part_number, makeName) == null) {
          regressions.push({ make: makeName, oem: part.oem_part_number, name: part.name ?? null });
        }
      }
      cursor = page.continueCursor;
      if (page.isDone) break;
    }

    // ── Summary ──
    const byMake: Record<string, { total: number; nowPass: number; stillRejected: string[] }> = {};
    for (const r of rejects) {
      const k = r.make ?? "(unknown make)";
      byMake[k] ??= { total: 0, nowPass: 0, stillRejected: [] };
      byMake[k].total++;
      if (r.nowAccepted != null) byMake[k].nowPass++;
      else if (byMake[k].stillRejected.length < 20) byMake[k].stillRejected.push(`${r.field}=${r.raw}`);
    }

    return {
      rejectsAudit: {
        totalLedgered: rejects.length,
        nowAccepted: rejects.filter((r) => r.nowAccepted != null).length,
        stillRejected: rejects.filter((r) => r.nowAccepted == null).length,
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
