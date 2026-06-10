/**
 * laborSibling — resolve a RepairPal-covered, platform-equivalent sibling to
 * source labor from when the exact nameplate isn't covered. Labor is a function
 * of chassis (brake/suspension/body jobs) and engine family (engine-bay jobs),
 * so we match on the dimension that determines THIS service's labor.
 *
 * This file's pure predicates (routing) have no ctx and are unit-tested. The
 * candidate-discovery query + LLM router + validated resolver action are added
 * in later tasks.
 */

export type LaborDeterminant = "engine" | "chassis" | "both";
export type PlatformKey = { chassis_code?: string; engine_family?: string };

/**
 * Derive the engine FAMILY from a full engine code when engine_family is unset
 * (it's null on many dev rows). The family is the leading letter+number group:
 * "N63B44O2" → "N63", "B58B30M0" → "B58". Returns undefined if unparseable.
 * Family (not the sub-variant) is the right grain for labor — a water-pump job
 * is identical across N63B44O2/T4. BMW-shaped; good enough for our fleet.
 */
export function deriveEngineFamily(engineCode?: string): string | undefined {
  if (!engineCode) return undefined;
  const m = engineCode.match(/^[A-Z]+\d+/);
  return m ? m[0] : undefined;
}

/** Which platform key(s) a service's labor depends on. */
export function matchKeyForDeterminant(
  d: LaborDeterminant,
  v: { chassis_code?: string; engine_family?: string },
): PlatformKey {
  if (d === "engine") return { engine_family: v.engine_family };
  if (d === "chassis") return { chassis_code: v.chassis_code };
  return { chassis_code: v.chassis_code, engine_family: v.engine_family };
}

/**
 * Is `candidate` a valid labor source for a `d`-determined service on `target`?
 * engine → same engine_family; chassis → same chassis_code; both → both.
 */
export function siblingMatches(
  d: LaborDeterminant,
  target: { chassis_code?: string; engine_family?: string },
  candidate: { chassis_code?: string; engine_family?: string },
): boolean {
  const chassisOk =
    !!target.chassis_code && target.chassis_code === candidate.chassis_code;
  const engineOk =
    !!target.engine_family && target.engine_family === candidate.engine_family;
  if (d === "engine") return engineOk;
  if (d === "chassis") return chassisOk;
  return chassisOk && engineOk;
}

/** Provenance match_key string for a resolved sibling. */
export function matchKeyString(d: LaborDeterminant, target: PlatformKey): string {
  const k = matchKeyForDeterminant(d, target);
  return k.engine_family
    ? `engine_family:${k.engine_family}`
    : `chassis_code:${k.chassis_code}`;
}

// ===========================================================================
// Sibling discovery + resolution (Convex)
// ===========================================================================

import { internalAction, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { repairpalUrlCandidates, repairpalModelCandidates, slugify } from "./repairpalLabor";
import { callClaudeExtractOnly } from "./utils/claudeClient";

type SiblingCandidate = {
  model: string;
  trim: string;
  chassis_code?: string;
  engine_family?: string;
};

const determinantValidator = v.union(
  v.literal("engine"),
  v.literal("chassis"),
  v.literal("both"),
);

/** chassis_code for a vehicle_config (needed for sibling resolution). */
export const getConfigChassisCode = internalQuery({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, { vehicleConfigId }): Promise<string | undefined> => {
    const c = (await ctx.db.get(vehicleConfigId)) as any;
    return c?.chassis_code ?? undefined;
  },
});

/**
 * Sibling candidates from OUR OWN catalog: other vehicle_configs sharing the
 * target's chassis_code and/or engine family. Free, deterministic, grows with
 * the catalog. engine_family is derived from engine_code when unset.
 */
export const catalogSiblingCandidates = internalQuery({
  args: {
    chassis_code: v.optional(v.string()),
    engine_family: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<SiblingCandidate[]> => {
    const out: SiblingCandidate[] = [];
    const seen = new Set<string>();
    const addConfig = async (c: any) => {
      const model = c.model_id ? ((await ctx.db.get(c.model_id)) as any)?.name : undefined;
      if (!model) return;
      const engine = c.engine_id ? ((await ctx.db.get(c.engine_id)) as any) : null;
      const ef = engine?.engine_family ?? deriveEngineFamily(engine?.engine_code);
      const key = `${model}|${c.trim_name ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ model, trim: c.trim_name ?? "", chassis_code: c.chassis_code, engine_family: ef });
    };

    if (args.chassis_code) {
      const rows = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_chassis_code", (q: any) => q.eq("chassis_code", args.chassis_code))
        .collect();
      for (const c of rows as any[]) await addConfig(c);
    }
    if (args.engine_family) {
      // engine_family is null on many dev rows, so the index misses — scan and
      // derive. (Prod: backfill engine_family then this uses the index.)
      const engineIds = new Set<string>();
      for (const e of (await ctx.db.query("engines").collect()) as any[]) {
        const fam = e.engine_family ?? deriveEngineFamily(e.engine_code);
        if (fam === args.engine_family) engineIds.add(String(e._id));
      }
      for (const c of (await ctx.db.query("vehicle_configs").collect()) as any[]) {
        if (c.engine_id && engineIds.has(String(c.engine_id))) await addConfig(c);
      }
    }
    return out;
  },
});

/**
 * LLM ROUTER (not source): asks Claude for OTHER same-make models that share the
 * target's platform on the service's determinant. Returns ranked nameplate
 * candidates with their claimed chassis/engine — VALIDATED downstream by
 * siblingMatches + the populated-page probe. The labor value never comes from
 * the LLM, only the choice of which RepairPal page to read.
 */
export const llmSiblingCandidates = internalAction({
  args: {
    make: v.string(),
    model: v.string(),
    year: v.optional(v.float64()),
    chassis_code: v.optional(v.string()),
    engine_family: v.optional(v.string()),
    determinant: determinantValidator,
  },
  handler: async (ctx, a): Promise<SiblingCandidate[]> => {
    const dim =
      a.determinant === "engine"
        ? `the same engine family (${a.engine_family ?? "?"})`
        : a.determinant === "chassis"
          ? `the same chassis/platform (${a.chassis_code ?? "?"})`
          : `BOTH the same chassis (${a.chassis_code ?? "?"}) AND engine family (${a.engine_family ?? "?"})`;
    const system =
      "You are an automotive platform expert. Return ONLY valid JSON, no prose.";
    const userPrompt =
      `List up to 5 OTHER ${a.make} models sold in the US that share ${dim} with the ` +
      `${a.year ?? ""} ${a.make} ${a.model}, ranked by US sales volume (most common first). ` +
      `For each, return its common nameplate as RepairPal lists it (e.g. "550i xDrive"), its ` +
      `chassis code, and its engine family. Return ONLY a JSON array: ` +
      `[{"model":"...","chassis_code":"...","engine_family":"..."}].`;
    try {
      const { data } = await callClaudeExtractOnly({
        system,
        userPrompt,
        maxTokens: 800,
        estimatedInputTokens: 1500,
      });
      if (!Array.isArray(data)) return [];
      return data
        .filter((d: any) => d && d.model)
        .map((d: any) => ({
          model: String(d.model),
          trim: "",
          chassis_code: d.chassis_code ? String(d.chassis_code) : undefined,
          engine_family: d.engine_family ? String(d.engine_family) : undefined,
        }));
    } catch (e) {
      console.warn("[laborSibling] LLM router failed (non-fatal):", e);
      return [];
    }
  },
});

/**
 * Resolve the RepairPal NAMEPLATE to source `determinant`-labor from when the
 * target car's own pages are missing. Gathers candidates (catalog + LLM router),
 * keeps only platform-validated ones, then probes each against a calibration
 * service (engine→spark plugs, chassis→brake pads) and returns the first live
 * nameplate. Resolved ONCE per (car, determinant) by the caller.
 */
export const resolveLaborSibling = internalAction({
  args: {
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.string()),
    year: v.optional(v.float64()),
    chassis_code: v.optional(v.string()),
    engine_family: v.optional(v.string()),
    determinant: determinantValidator,
  },
  handler: async (
    ctx,
    a,
  ): Promise<{ nameplate: string; match_key: string } | null> => {
    const target: PlatformKey = {
      chassis_code: a.chassis_code,
      engine_family: a.engine_family,
    };
    const calibrationSlug =
      a.determinant === "chassis" ? "brake-pad-replacement" : "spark-plug-replacement";

    const catalog: SiblingCandidate[] = await ctx.runQuery(
      internal.vehicleEnrichment.laborSibling.catalogSiblingCandidates,
      {
        chassis_code: a.determinant === "engine" ? undefined : a.chassis_code,
        engine_family: a.determinant === "chassis" ? undefined : a.engine_family,
      },
    );
    const llm: SiblingCandidate[] = await ctx.runAction(
      internal.vehicleEnrichment.laborSibling.llmSiblingCandidates,
      {
        make: a.make,
        model: a.model,
        year: a.year,
        chassis_code: a.chassis_code,
        engine_family: a.engine_family,
        determinant: a.determinant,
      },
    );

    const candidates = [...catalog, ...llm].filter((c) =>
      siblingMatches(a.determinant, target, c),
    );
    for (const c of candidates) {
      const nameplates = c.trim
        ? repairpalModelCandidates(c.model, c.trim)
        : [slugify(c.model)];
      for (const np of nameplates) {
        if (!np) continue;
        const rp = await ctx.runAction(
          internal.vehicleEnrichment.repairpalLabor.scrapeRepairpalHours,
          // Our year on the sibling nameplate → its same-generation page;
          // yearless fallback keeps the calibration probe permissive.
          { urls: repairpalUrlCandidates(a.make, np, calibrationSlug, a.year) },
        );
        if (rp) {
          return { nameplate: np, match_key: matchKeyString(a.determinant, target) };
        }
      }
    }
    return null;
  },
});
