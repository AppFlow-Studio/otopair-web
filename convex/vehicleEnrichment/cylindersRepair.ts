/**
 * vehicleEnrichment/cylindersRepair.ts — one-shot repair sweep + write-time
 * sanitizer for the corrupted engines.cylinders column (Wave 1, Aug 2026).
 *
 * The dry-run census (470 engines on dev) found 159 rows whose cylinders
 * value is untrustworthy, in three classes:
 *   A. displacement mirrors — cylinders holds the displacement float
 *      (cyl=3.5 on Ford Cyclone V6s, cyl=6.7 on Power Stroke V8s, cyl=4 on
 *      the M177 4.0L V8). The engine codes themselves show the source:
 *      decode descriptors like "3.5l_3.5cyl" wrote displacement into the
 *      cylinders slot. vehicle_pipeline now prefers NHTSA, but `?? 0` and
 *      the VDB gap-fill still leak, and the historical rows were never
 *      healed.
 *   B. cyl=0 — "unknownl_unknowncyl" descriptors that resolved nothing.
 *   C. integer mirrors with a corrupted plug twin (2l_2cyl plugs=2).
 *
 * Cylinders is quietly load-bearing: capacity bands (sanityChecks
 * getCapacityBand), spark-plug quantity validation, the fitment verifier's
 * vehicle context, and estimator variant scoring all key on it —
 * flagOutOfRangeCapacities was deliberately de-tuned because the column
 * could not be trusted.
 *
 * Repair precedence (pipeline law: null over a confident guess):
 *   1. EPA cylinders (config_epa_economy — government-backed, joined via
 *      the engine's configs).
 *   2. spark_plug_quantity, when it is NOT itself a displacement mirror
 *      (plugs=6 beside cyl=3.5 is the true count; plugs=2 beside disp=2 is
 *      the same corruption twice).
 *   3. KNOWN_ENGINE_CYLINDERS — a small curated table of the engine
 *      families the census actually surfaced. Only certain entries.
 *   4. Nothing corroborates → CLEAR the field (undefined), never keep the
 *      poison and never guess. A null re-resolves on the next enrichment.
 *
 * Run (dry run first — prints the full per-row plan, writes nothing):
 *   npx convex run vehicleEnrichment/cylindersRepair:repairAllCylinders '{"dryRun":true}'
 * Live: BACKFILL_ENGINE_CYLINDERS=on and pass {"dryRun":false}.
 */
import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

// ─── Pure helpers (unit-tested in tests/cylindersRepair.test.ts) ────────────

/** Write-time sanitizer: a cylinders value the schema will accept. Integer
 *  2–16 passes; 0, negatives, non-integers (the displacement-mirror
 *  signature) and out-of-range all become undefined — an honest gap instead
 *  of poison. Wired into the decode write path. */
export function sanitizeCylinders(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (n < 2 || n > 16) return undefined;
  return n;
}

/** Curated engine-family cylinder counts — ONLY families the census
 *  surfaced and whose count is unambiguous. Matched against engine_code
 *  (case-insensitive substring / prefix) plus a displacement gate where the
 *  family name alone is ambiguous (EcoBoost spans 3, 4 and 6 cylinders). */
const KNOWN_ENGINE_CYLINDERS: ReadonlyArray<{
  match: RegExp;
  /** displacement gate [min, max] inclusive; null = any */
  disp: [number, number] | null;
  cylinders: number;
}> = [
  { match: /^M177/i, disp: null, cylinders: 8 },          // AMG 4.0 V8
  { match: /4\.0\s*TFSI/i, disp: null, cylinders: 8 },    // Audi 4.0T V8
  { match: /^S58/i, disp: null, cylinders: 6 },           // BMW S58 3.0 I6
  { match: /^C32B/i, disp: null, cylinders: 6 },          // NSX 3.2 V6
  { match: /^J3[0-9]/i, disp: null, cylinders: 6 },       // Honda J-series V6
  { match: /^K2[0-9]/i, disp: null, cylinders: 4 },       // Honda K-series I4
  { match: /^A25A/i, disp: null, cylinders: 4 },          // Toyota Dynamic Force 2.5
  { match: /^EA211/i, disp: null, cylinders: 4 },         // VW EA211 I4
  { match: /FSI/i, disp: [3.5, 3.7], cylinders: 6 },      // VW/Audi 3.6 FSI VR6
  { match: /EcoBoost|GTDI/i, disp: [2.2, 2.4], cylinders: 4 },
  { match: /EcoBoost|GTDI|Nano/i, disp: [2.6, 2.8], cylinders: 6 },
  { match: /EcoBoost|GTDI|Cyclone|99B|99M/i, disp: [3.4, 3.8], cylinders: 6 },
  { match: /DRAGON/i, disp: [1.4, 1.6], cylinders: 3 },   // Ford Dragon 1.5 I3
  { match: /TiVCT|TIVCT|Coyote/i, disp: [4.9, 5.1], cylinders: 8 }, // Ford 5.0 V8
  { match: /Power\s*Stroke|^99L$|^996$/i, disp: [6.0, 7.4], cylinders: 8 }, // HD V8s
  { match: /^L9[0-9]/i, disp: [5.9, 6.3], cylinders: 8 }, // GM Vortec 6.0/6.2
  { match: /^LB8$/i, disp: null, cylinders: 6 },          // GM 2.8 V6
];

function knownFamilyCylinders(engineCode: string | null | undefined, dispL: number | null): number | null {
  const code = String(engineCode ?? "");
  if (!code) return null;
  for (const k of KNOWN_ENGINE_CYLINDERS) {
    if (!k.match.test(code)) continue;
    if (k.disp && (dispL == null || dispL < k.disp[0] || dispL > k.disp[1])) continue;
    return k.cylinders;
  }
  return null;
}

export interface CylindersRepairInput {
  cylinders: number | null | undefined;
  displacement_l?: number | null;
  displacement_liters?: string | null;
  engine_code?: string | null;
  configuration?: string | null;
  spark_plug_quantity?: number | null;
  fuel_type?: string | null;
  verified_fields?: string[] | null;
}

export interface CylindersRepairPlan {
  verdict: "ok" | "repair" | "clear" | "review";
  proposed?: number;
  /** true when spark_plug_quantity was itself a displacement mirror and
   *  should be cleared alongside (never guessed — dual-plug engines exist). */
  clearPlugs: boolean;
  reason: string;
}

function displacementOf(e: CylindersRepairInput): number | null {
  const n =
    typeof e.displacement_l === "number"
      ? e.displacement_l
      : parseFloat(String(e.displacement_liters ?? ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Is this cylinders value suspect at all? Mirrors the census detectors. */
export function cylindersSuspect(e: CylindersRepairInput): string[] {
  const cyl = e.cylinders;
  if (cyl == null) return [];
  const d = displacementOf(e);
  const signals: string[] = [];
  if (!Number.isInteger(cyl)) signals.push("non_integer");
  if (cyl < 2 || cyl > 16) signals.push("out_of_range");
  const vConfig = String(e.configuration ?? "").toUpperCase() === "V";
  if (vConfig && (cyl < 6 || cyl % 2 === 1)) signals.push("v_config_impossible");
  if (d != null && Math.abs(cyl - d) < 0.05 && d >= 2) {
    // Integer coincidences (a genuine 3.0L... there is no 3-cyl 3.0L or
    // 4-cyl 4.0L in the fleet) — the mirror alone is only decisive when
    // another signal agrees or the count is impossible for the layout.
    if (vConfig || !Number.isInteger(cyl) || cyl <= 3) signals.push("mirrors_displacement");
  }
  return signals;
}

/** Whether spark_plug_quantity can serve as the true cylinder count. */
function trustworthyPlugs(e: CylindersRepairInput): number | null {
  const p = e.spark_plug_quantity;
  if (typeof p !== "number" || !Number.isInteger(p) || p < 3 || p > 16) return null;
  const d = displacementOf(e);
  // The same corruption hits plugs (2l_2cyl → plugs=2, 3l_3cyl → plugs=3):
  // a plug count equal to the displacement float is not evidence.
  if (d != null && Math.abs(p - d) < 0.05) return null;
  const fuel = String(e.fuel_type ?? "").toLowerCase();
  if (fuel.includes("diesel") || fuel.includes("electric")) return null;
  return p;
}

/** The deterministic repair decision for one engine row. Pure. */
export function resolveCylindersRepair(
  e: CylindersRepairInput,
  epaCylinders: number | null,
): CylindersRepairPlan {
  if ((e.verified_fields ?? []).includes("cylinders")) {
    return { verdict: "ok", clearPlugs: false, reason: "verified_field" };
  }
  const signals = cylindersSuspect(e);
  if (signals.length === 0) return { verdict: "ok", clearPlugs: false, reason: "no_signals" };

  const d = displacementOf(e);
  const plugs = trustworthyPlugs(e);
  const plugsWasMirror =
    typeof e.spark_plug_quantity === "number" &&
    d != null &&
    Math.abs(e.spark_plug_quantity - d) < 0.05;
  const family = knownFamilyCylinders(e.engine_code, d);

  const finish = (proposed: number, source: string): CylindersRepairPlan => ({
    verdict: "repair",
    proposed,
    // A mirror-corrupted plug count that disagrees with the repaired
    // cylinder count is the same poison — clear it, never guess dual-plug.
    clearPlugs: plugsWasMirror && e.spark_plug_quantity !== proposed,
    reason: `${signals.join("+")} -> ${source}`,
  });

  if (epaCylinders != null && Number.isInteger(epaCylinders) && epaCylinders >= 2 && epaCylinders <= 16) {
    return finish(epaCylinders, `epa:${epaCylinders}`);
  }
  if (plugs != null) {
    // Cross-check: when the curated table ALSO knows this family and
    // disagrees with plugs, neither source is safe — surface for review.
    if (family != null && family !== plugs) {
      return { verdict: "review", clearPlugs: false, reason: `plugs=${plugs} vs family=${family}` };
    }
    return finish(plugs, `plugs:${plugs}`);
  }
  if (family != null) return finish(family, `family:${family}`);
  return {
    verdict: "clear",
    clearPlugs: plugsWasMirror,
    reason: `${signals.join("+")} -> no corroboration`,
  };
}

// ─── Sweep ──────────────────────────────────────────────────────────────────

export const repairCylindersPage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    pageSize: v.number(),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("engines")
      .paginate({ cursor: args.cursor, numItems: args.pageSize });

    // engine_id -> EPA cylinders via this engine's configs (cheap: configs
    // per engine is small; EPA rows exist only for a subset).
    const results: Array<{ id: string; code: string | null; before: number | null; plan: CylindersRepairPlan }> = [];
    let repaired = 0;
    let cleared = 0;
    let review = 0;

    for (const engine of page.page) {
      const configs = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_engine", (q) => q.eq("engine_id", engine._id))
        .collect();
      let epaCyl: number | null = null;
      for (const c of configs) {
        const epa = await ctx.db
          .query("config_epa_economy")
          .withIndex("by_config", (q) => q.eq("vehicle_config_id", c._id))
          .first();
        if (epa && typeof (epa as any).epa_cylinders === "number") {
          epaCyl = (epa as any).epa_cylinders;
          break;
        }
      }
      const plan = resolveCylindersRepair(engine as any, epaCyl);
      if (plan.verdict === "ok") continue;
      results.push({
        id: String(engine._id),
        code: (engine as any).engine_code ?? null,
        before: (engine as any).cylinders ?? null,
        plan,
      });
      if (args.dryRun) continue;
      if (plan.verdict === "repair") {
        const patch: Record<string, unknown> = { cylinders: plan.proposed };
        if (plan.clearPlugs) patch.spark_plug_quantity = undefined;
        await ctx.db.patch(engine._id, patch as any);
        repaired++;
      } else if (plan.verdict === "clear") {
        const patch: Record<string, unknown> = { cylinders: undefined };
        if (plan.clearPlugs) patch.spark_plug_quantity = undefined;
        await ctx.db.patch(engine._id, patch as any);
        cleared++;
      } else {
        review++; // review rows are never auto-touched
      }
    }

    return {
      continueCursor: page.isDone ? null : page.continueCursor,
      scanned: page.page.length,
      results,
      repaired,
      cleared,
      review,
    };
  },
});

export const repairAllCylinders = internalAction({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    if (!dryRun && process.env.BACKFILL_ENGINE_CYLINDERS !== "on") {
      return { status: "refused", reason: "set BACKFILL_ENGINE_CYLINDERS=on for a live run" };
    }
    let cursor: string | null = null;
    let scanned = 0;
    let repaired = 0;
    let cleared = 0;
    let review = 0;
    const plans: any[] = [];
    do {
      const r: any = await ctx.runMutation(
        internal.vehicleEnrichment.cylindersRepair.repairCylindersPage,
        { cursor, pageSize: 50, dryRun },
      );
      cursor = r.continueCursor;
      scanned += r.scanned;
      repaired += r.repaired;
      cleared += r.cleared;
      review += r.review;
      plans.push(...r.results);
    } while (cursor != null);
    const summary = {
      status: dryRun ? ("dry_run" as const) : ("done" as const),
      scanned,
      suspects: plans.length,
      repaired,
      cleared,
      review,
      plans: plans.map((p) => `${p.code ?? "?"} ${p.before} -> ${p.plan.verdict}${p.plan.proposed != null ? `:${p.plan.proposed}` : ""}${p.plan.clearPlugs ? " (clear plugs)" : ""} [${p.plan.reason}]`),
    };
    console.log("[cylinders-repair]", JSON.stringify({ ...summary, plans: summary.plans.length }));
    return summary;
  },
});
