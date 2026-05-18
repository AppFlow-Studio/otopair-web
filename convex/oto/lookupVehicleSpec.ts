// =============================================================================
// Oto AI — lookup_vehicle_spec
// =============================================================================
//
// Lets Oto pull factual specs for a vehicle the user DOESN'T own — typically
// when they're asking comparison or general-knowledge questions about a car
// they're considering or curious about.
//
// Takes free-text ("2020 BMW M5", "Tesla Model 3", "Honda Civic Si") and:
//   1. Tokenizes — extracts year if present, then matches against makes,
//      models, trims by name (case-insensitive substring).
//   2. If a unique vehicle_config matches, returns the joined facts shape
//      (same shape as get_vehicle_facts).
//   3. If multiple match, returns a candidates list so Haiku can disambiguate
//      with the user or pick by recency/popularity.
//   4. If nothing matches, returns empty candidates; Haiku then falls back
//      to training knowledge + (per the prompt) web_search.
//
// Does NOT require the vehicle to be in any user's account — strictly a
// catalog lookup against vehicles/vehicle_configs/makes/models/trims.
// =============================================================================

import { query } from "../_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { isEvalTestMake } from "./evalTestFilter";

export interface SpecCandidate {
  vehicle_config_id: string;
  year: number | null;
  make: string;
  model: string;
  trim: string | null;
}

export interface SpecFacts {
  matched: {
    display: string;
    vehicle_config_id: string;
    year: number | null;
    make: string;
    model: string;
    trim: string | null;
    engine: {
      displacement_l: number | null;
      cylinders: number | null;
      configuration: string | null;
      aspiration: string | null;
      fuel_type: string | null;
      engine_code: string | null;
      oil_viscosity: string | null;
      oil_capacity_qts: number | null;
      timing_type: string | null;
    } | null;
    transmission: { type: string | null; speeds: number | null } | null;
    drivetrain: string | null;
    chassis_code: string | null;
  } | null;
  candidates: SpecCandidate[];
}

function lower(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

export const lookupVehicleSpec = query({
  args: { query: v.string() },
  handler: async (ctx, { query: rawQuery }): Promise<SpecFacts> => {
    const q = rawQuery.trim();
    if (!q) return { matched: null, candidates: [] };

    // Year extraction — first 4-digit token in 1980–<current+2>.
    const nowYear = new Date().getUTCFullYear();
    const yearMatch = q.match(/\b(19\d{2}|20\d{2})\b/);
    const year = yearMatch
      ? Math.min(Math.max(parseInt(yearMatch[1], 10), 1980), nowYear + 2)
      : null;
    const noYear = year ? q.replace(yearMatch![0], "").trim() : q;
    const tokens = noYear
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const tokensLower = tokens.map(lower);

    // Word-boundary match: avoids "M5" matching "M550i" (M550i contains the
    // characters m-5 but as a sub-token, not as a word). Use both:
    //   - exact name match (whole tokens equal)
    //   - prefix-or-whole-word match (regex with \b)
    // Substring fallback only for very short tokens (<=2 chars) which would
    // be too narrow with word boundaries.
    // Escape regex special chars in user-supplied tokens so we can safely
    // build a word-boundary RegExp around them.
    const escapeRegex = (s: string): string =>
      s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const matchesToken = (haystack: string, token: string): boolean => {
      const h = lower(haystack);
      const t = lower(token);
      if (!h || !t) return false;
      if (h === t) return true;
      // Word-boundary match avoids the M5 / M550i substring-collision bug:
      //   \bM5\b does NOT match inside "M550i" because the chars after the
      //   "5" are still word chars (no word-boundary at position 2). But
      //   \bM5\b DOES match "BMW M5" and "M5 Competition". Exact what we
      //   want for trim/model fuzzy matching.
      try {
        const re = new RegExp(`\\b${escapeRegex(t)}\\b`, "i");
        return re.test(h);
      } catch {
        return h.includes(t);
      }
    };

    // Match makes — take all makes, filter by token containment in name.
    // Awaiting Option B migration through queryMoat helper. See
    // docs/SPRINT_1/WAVE_7_3_RATE_LIMIT_DESIGN.md "Implementation Status".
    // EXEMPT: Wave 7.3 grandfathered (pre-migration moat read).
    const allMakesRaw = await ctx.db.query("makes").collect();
    const allMakes = allMakesRaw.filter((m) => !isEvalTestMake(m));
    const makeMatches = allMakes.filter((m) =>
      tokensLower.some((tk) => matchesToken((m as any).name, tk)),
    );

    // If multiple makes match, narrow to the longest-matching name (e.g.
    // "Mercedes-Benz" beats "Mercedes" — unlikely with substring but cheap).
    let activeMakes = makeMatches;
    if (makeMatches.length > 1) {
      activeMakes = [...makeMatches].sort(
        (a, b) => ((b as any).name?.length ?? 0) - ((a as any).name?.length ?? 0),
      );
    }

    // Match configs within active makes. A config is included if at least
    // one query token word-bound-matches the model name OR the trim_name.
    // Token tokens are ranked: model-name hit scores 2, trim-name hit scores
    // 1 — model match is stronger evidence (the user typed "M5" probably
    // wants the model, not a trim called "M5 Performance"). Total score is
    // summed across tokens.
    const candidateConfigs: Array<{
      cfg: Doc<"vehicle_configs">;
      makeName: string;
      modelName: string;
      score: number;
    }> = [];
    // Strip make tokens from consideration so we don't double-count "BMW"
    // as a model/trim hit on configs that legitimately have BMW in metadata.
    const makeNamesLower = new Set(
      activeMakes.map((m) => lower((m as any).name)),
    );
    const nonMakeTokens = tokensLower.filter((tk) => !makeNamesLower.has(tk));
    for (const make of activeMakes) {
      const models = await ctx.db
        .query("models")
        .filter((q: any) => q.eq(q.field("make_id"), make._id))
        .collect();
      for (const mdl of models) {
        const cfgs = await ctx.db
          .query("vehicle_configs")
          .filter((q: any) => q.eq(q.field("model_id"), mdl._id))
          .collect();
        for (const cfg of cfgs) {
          if (year != null && cfg.year !== year) continue;
          // Compute score from word-boundary matches against model name AND
          // trim_name. Tokens that match the model count double.
          let score = 0;
          const trim = (cfg as any).trim_name as string | undefined;
          if (nonMakeTokens.length === 0) {
            // No discriminating tokens — every config matches with score 0.
            // Will only be returned if no scored candidates exist.
            score = 0;
          } else {
            for (const tk of nonMakeTokens) {
              if (matchesToken((mdl as any).name, tk)) score += 2;
              else if (trim && matchesToken(trim, tk)) score += 1;
            }
          }
          if (score > 0 || nonMakeTokens.length === 0) {
            candidateConfigs.push({
              cfg,
              makeName: (make as any).name,
              modelName: (mdl as any).name,
              score,
            });
          }
        }
      }
    }

    // Drop dupes by config _id.
    const seen = new Set<string>();
    const deduped: typeof candidateConfigs = [];
    for (const x of candidateConfigs) {
      const k = x.cfg._id as unknown as string;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(x);
    }

    if (deduped.length === 0) {
      return { matched: null, candidates: [] };
    }

    // Use the score we already computed on candidateConfigs (model-name hit
    // counts double, trim-name hit counts single). Keep only the top-score
    // candidates; sort by year desc as a tiebreaker.
    let chosen = deduped;
    const maxScore = Math.max(...deduped.map((x) => x.score));
    if (maxScore > 0) {
      chosen = deduped.filter((x) => x.score === maxScore);
    }
    chosen.sort((a, b) => (b.cfg.year ?? 0) - (a.cfg.year ?? 0));

    // If after refinement we still have multiple, return candidates list for
    // Haiku to disambiguate.
    if (chosen.length > 1) {
      return {
        matched: null,
        candidates: chosen.slice(0, 8).map((x) => ({
          vehicle_config_id: x.cfg._id as unknown as string,
          year: x.cfg.year ?? null,
          make: x.makeName,
          model: x.modelName,
          trim: (x.cfg as any).trim_name ?? null,
        })),
      };
    }

    // Single match — build the joined facts shape.
    const x = chosen[0];
    const cfg = x.cfg;
    const engineId =
      (cfg.engine_id as Id<"engines"> | undefined) ?? undefined;
    const transmissionId =
      (cfg.transmission_id as Id<"transmissions"> | undefined) ?? undefined;
    const [engine, transmission] = await Promise.all([
      engineId ? ctx.db.get(engineId) : Promise.resolve(null),
      transmissionId ? ctx.db.get(transmissionId) : Promise.resolve(null),
    ]);

    const trimName = (cfg as any).trim_name ?? null;
    const displayParts = [cfg.year, x.makeName, x.modelName, trimName].filter(
      (v) => v != null && v !== "",
    );
    const display =
      displayParts.length > 0 ? displayParts.join(" ") : (x.modelName as string);

    const e = (engine as any) ?? {};
    const t = (transmission as any) ?? {};

    return {
      matched: {
        display,
        vehicle_config_id: cfg._id as unknown as string,
        year: cfg.year ?? null,
        make: x.makeName,
        model: x.modelName,
        trim: trimName,
        engine: engine
          ? {
              displacement_l: e.displacement_l ?? null,
              cylinders: e.cylinders ?? null,
              configuration: e.configuration ?? null,
              aspiration: e.aspiration ?? null,
              fuel_type: e.fuel_type ?? null,
              engine_code: e.engine_code ?? null,
              oil_viscosity: e.oil_viscosity ?? null,
              oil_capacity_qts: e.oil_capacity_qts ?? null,
              timing_type: e.timing_type ?? null,
            }
          : null,
        transmission: transmission
          ? {
              type: t.type ?? t.transmission_type ?? null,
              speeds: t.speeds ?? null,
            }
          : null,
        drivetrain: (cfg as any).drivetrain ?? null,
        chassis_code: (cfg as any).chassis_code ?? null,
      },
      candidates: [],
    };
  },
});
