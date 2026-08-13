/**
 * seedTierAssignments.ts — Pricing v2 (spec May 29 2026) Part 5.
 *
 * Populates `vehicle_configs.pricing_tier` from the spec's ~330-model seed
 * list. Two-pass:
 *
 *   Pass 1 — PART5_TIERS: explicit (make, model) → tier, year-agnostic match.
 *            Writes pricing_tier_source = 'part5_seed'.
 *
 *   Pass 2 — ASSIGNMENT_RULES (reused from seeds/seedPricing.ts):
 *            pattern-based fallback for any vehicle_configs row still null.
 *            Writes pricing_tier_source = 'rules_engine'.
 *
 * Anything still null after both passes routes to booking_approvals at quote
 * time per spec scope boundary (EV/PHEV, carbon-ceramic, exotic bundles).
 *
 * Run:
 *   npx convex run seeds/seedTierAssignments:run
 *   npx convex run seeds/seedTierAssignments:run '{"force": true}'  // overwrite manual
 *
 * Idempotent. Manual overrides (pricing_tier_source = 'manual') are preserved
 * unless `force: true`.
 *
 * Borderline calls flagged in spec — stored in `notes` for audit:
 *   - Subaru WRX     (T2a vs T2b)   → spec says T2a
 *   - Corvette Stingray (T3a vs T3b) → spec says T3a
 *   - Lamborghini Urus (T3b vs T4)   → spec says T4
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { VehicleTier } from "../lib/vehicleTiers";
import { ASSIGNMENT_RULES, matchRule } from "./seedPricing";

// ─── Part 5 — explicit make+model seed list (year-agnostic) ────────────────

type Part5Row = { make: string; model: string; tier: VehicleTier; notes?: string };

const PART5_TIERS: ReadonlyArray<Part5Row> = [
  // ══ T1 — Mainstream / economy ICE ══
  ...mk("T1", "Toyota", [
    "Corolla", "Corolla Cross", "Camry", "Camry Hybrid", "Prius", "C-HR",
    "RAV4", "RAV4 Hybrid", "Highlander", "Venza", "Sienna", "4Runner",
    "Tacoma", "Tundra", "Sequoia",
  ]),
  ...mk("T1", "Honda", [
    "Civic", "Civic Si", "Accord", "Accord Hybrid", "HR-V", "CR-V",
    "CR-V Hybrid", "Passport", "Pilot", "Ridgeline", "Odyssey",
  ]),
  ...mk("T1", "Mazda", [
    "Mazda3", "CX-30", "CX-5", "CX-50", "CX-70", "CX-90", "MX-5 Miata",
  ]),
  ...mk("T1", "Hyundai", [
    "Elantra", "Sonata", "Venue", "Kona", "Tucson", "Santa Fe",
    "Palisade", "Santa Cruz",
  ]),
  ...mk("T1", "Kia", [
    "Forte", "K5", "Soul", "Seltos", "Sportage", "Sorento", "Telluride", "Carnival",
  ]),
  ...mk("T1", "Nissan", [
    "Versa", "Sentra", "Altima", "Kicks", "Rogue", "Murano", "Pathfinder",
    "Frontier", "Titan",
  ]),
  ...mk("T1", "Subaru", ["Impreza", "Crosstrek", "Forester", "Legacy", "Ascent"]),
  ...mk("T1", "Ford", [
    "Maverick", "Ranger", "F-150", "Escape", "Bronco", "Bronco Sport",
    "Edge", "Explorer", "Expedition",
  ]),
  ...mk("T1", "Chevrolet", [
    "Trax", "Trailblazer", "Equinox", "Malibu", "Blazer", "Traverse",
    "Tahoe", "Suburban", "Colorado", "Silverado",
  ]),
  ...mk("T1", "GMC", ["Canyon", "Sierra", "Terrain", "Acadia", "Yukon"]),
  ...mk("T1", "Jeep", ["Compass", "Cherokee", "Grand Cherokee", "Wrangler", "Gladiator"]),
  ...mk("T1", "Ram", ["1500"]),
  ...mk("T1", "Dodge", ["Hornet", "Durango"]),
  ...mk("T1", "Chrysler", ["Pacifica"]),
  ...mk("T1", "Buick", ["Encore GX", "Envista", "Envision", "Enclave"]),
  ...mk("T1", "Mitsubishi", ["Outlander"]),
  ...mk("T1", "Volkswagen", ["Jetta", "Taos", "Tiguan", "Atlas"]),

  // ══ T2a — Mainstream-premium / sport-mainstream / entry-AWD ══
  ...mk("T2a", "Subaru", ["WRX", "BRZ", "Outback XT", "Legacy XT"], "WRX borderline (T2a vs T2b)"),
  ...mk("T2a", "Toyota", ["GR86"]),
  ...mk("T2a", "Mazda", ["Mazda3 Turbo", "CX-50 Turbo"]),
  ...mk("T2a", "Mini", ["Cooper", "Countryman"]),
  ...mk("T2a", "Acura", ["Integra", "ILX"]),
  ...mk("T2a", "Lexus", ["UX", "NX"]),
  ...mk("T2a", "Volkswagen", ["Arteon"]),
  ...mk("T2a", "Fiat", ["124 Spider"]),
  ...mk("T2a", "Buick", ["Regal"]),
  ...mk("T2a", "Mitsubishi", ["Eclipse Cross"]),

  // ══ T2b — Hot-hatch / EA888 / entry-Euro performance ══
  ...mk("T2b", "Volkswagen", ["GTI", "Golf R", "Jetta GLI"]),
  ...mk("T2b", "Audi", ["A3", "S3"]),
  ...mk("T2b", "Honda", ["Civic Type R"]),
  ...mk("T2b", "Hyundai", ["Elantra N", "Kona N", "Veloster N"]),
  ...mk("T2b", "Mini", ["Cooper S", "JCW"]),
  ...mk("T2b", "Toyota", ["GR Corolla"]),
  ...mk("T2b", "Nissan", ["Z"]),
  ...mk("T2b", "Ford", ["Mustang EcoBoost"]),

  // ══ T2c — Entry-luxury German / Euro / Japanese ══
  ...mk("T2c", "BMW", [
    "2 Series", "3 Series", "4 Series", "5 Series",
    "X1", "X2", "X3", "X4", "Z4",
  ]),
  ...mk("T2c", "Mercedes-Benz", ["A 220", "C 300", "CLA", "E 350", "GLA", "GLB", "GLC", "GLE"]),
  ...mk("T2c", "Audi", ["A4", "A5", "A6", "A7", "Q3", "Q5", "Q7", "TT"]),
  ...mk("T2c", "Lexus", ["IS", "ES", "RC", "RX", "GX"]),
  ...mk("T2c", "Acura", ["TLX", "RDX", "MDX"]),
  ...mk("T2c", "Infiniti", ["Q50", "Q60", "QX50", "QX60", "QX80"]),
  ...mk("T2c", "Genesis", ["G70", "G80", "GV70", "GV80"]),
  ...mk("T2c", "Volvo", ["S60", "S90", "XC40", "XC60", "XC90", "V60", "V90"]),
  ...mk("T2c", "Alfa Romeo", ["Giulia", "Stelvio"]),
  ...mk("T2c", "Jaguar", ["XE", "XF", "F-Pace", "E-Pace"]),
  ...mk("T2c", "Land Rover", ["Discovery Sport", "Evoque", "Velar"]),
  ...mk("T2c", "Cadillac", ["CT4", "CT5", "XT4", "XT5", "XT6"]),
  ...mk("T2c", "Lincoln", ["Corsair", "Nautilus", "Aviator", "Navigator"]),

  // ══ T3a — Performance-luxury / M-lite / AMG-lite / S-line ══
  ...mk("T3a", "BMW", ["M240i", "M340i", "M440i", "M550i", "X3 M40i", "X4 M40i", "Z4 M40i"]),
  ...mk("T3a", "Toyota", ["GR Supra"]),
  ...mk("T3a", "Mercedes-AMG", [
    "A 35", "CLA 35", "C 43", "E 53", "GLC 43", "GLE 53", "SL 43",
  ]),
  ...mk("T3a", "Audi", ["S3", "S4", "S5", "S6", "S7", "SQ5", "SQ7", "TTS"]),
  ...mk("T3a", "Porsche", ["Macan", "Macan S", "Cayenne", "718 Cayman", "718 Boxster"]),
  ...mk("T3a", "Maserati", ["Ghibli", "Levante", "Grecale"]),
  ...mk("T3a", "Lexus", ["LC 500", "LS 500", "RC F", "IS 500"]),
  ...mk("T3a", "Chevrolet", ["Corvette Stingray"], "Stingray borderline (T3a vs T3b)"),
  ...mk("T3a", "Ford", ["Mustang GT", "Mustang Dark Horse"]),
  ...mk("T3a", "Dodge", ["Charger Hellcat", "Challenger Hellcat"]),
  ...mk("T3a", "Land Rover", ["Range Rover Sport"]),
  ...mk("T3a", "Jaguar", ["F-Type"]),
  ...mk("T3a", "Genesis", ["G90"]),
  ...mk("T3a", "Kia", ["Stinger GT"]),

  // ══ T3b — High-performance / near-exotic ══
  ...mk("T3b", "Porsche", ["911 Carrera", "911 4S", "718 GTS", "718 GT4",
    "Cayenne Turbo", "Macan GTS", "Macan Turbo", "Panamera"]),
  ...mk("T3b", "BMW", ["M2", "M3", "M4", "M5", "X3 M", "X4 M", "X5 M", "X6 M", "M8"]),
  ...mk("T3b", "Mercedes-AMG", ["C 63", "E 63", "GT 4-door", "GLC 63", "GLE 63", "G 63"]),
  ...mk("T3b", "Audi", ["RS3", "RS5", "RS6", "RS7", "RS Q8", "TT RS"]),
  ...mk("T3b", "Chevrolet", ["Corvette Z06", "Corvette E-Ray"]),
  ...mk("T3b", "Ford", ["Shelby GT500"]),
  ...mk("T3b", "Cadillac", ["CT4-V Blackwing", "CT5-V Blackwing"]),
  ...mk("T3b", "Dodge", ["Hellcat Redeye"]),
  ...mk("T3b", "Nissan", ["GT-R"]),
  ...mk("T3b", "Lotus", ["Emira"]),
  ...mk("T3b", "Maserati", ["GranTurismo"]),
  ...mk("T3b", "Jaguar", ["F-Type R", "F-Type SVR"]),
  ...mk("T3b", "Alfa Romeo", ["Giulia Quadrifoglio", "Stelvio Quadrifoglio"]),
  ...mk("T3b", "Aston Martin", ["Vantage"]),

  // ══ T4 — Exotic / ultra-luxury ══
  ...mk("T4", "Ferrari", ["296 GTB", "F8", "Roma", "SF90", "812", "Purosangue"]),
  ...mk("T4", "Lamborghini", ["Huracán", "Revuelto", "Urus"], "Urus borderline (T3b vs T4)"),
  ...mk("T4", "McLaren", ["Artura", "750S", "GT"]),
  ...mk("T4", "Porsche", ["911 GT3", "911 GT3 RS", "911 Turbo S", "911 S/T"]),
  ...mk("T4", "Bentley", ["Continental GT", "Flying Spur", "Bentayga"]),
  ...mk("T4", "Rolls-Royce", ["Ghost", "Phantom", "Cullinan"]),
  ...mk("T4", "Aston Martin", ["DB12", "DBS", "DBX", "Vanquish"]),
  ...mk("T4", "Audi", ["R8"]),
  ...mk("T4", "Mercedes-AMG", ["GT Black Series", "SL"]),
  ...mk("T4", "Maserati", ["MC20"]),
  ...mk("T4", "Bugatti", ["Chiron"]),
  ...mk("T4", "Pagani", ["Huayra", "Utopia"]),
  ...mk("T4", "Koenigsegg", ["Jesko", "Gemera"]),
  ...mk("T4", "Ford", ["GT"]),
];

function mk(
  tier: VehicleTier,
  make: string,
  models: string[],
  notes?: string,
): Part5Row[] {
  return models.map((model) => ({ make, model, tier, notes }));
}

// ─── Seed runner ────────────────────────────────────────────────────────────

export const run = internalMutation({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    const now = Date.now();

    // Build make name → id map
    const makes = await ctx.db.query("makes").collect();
    const makeIdByName = new Map<string, any>();
    for (const m of makes) {
      makeIdByName.set(m.name.toLowerCase(), m._id);
    }

    // Build model (make_id, name) → id map
    const models = await ctx.db.query("models").collect();
    const modelByMakeAndName = new Map<string, any>();
    for (const md of models as Array<{ _id: any; make_id?: any; name?: string }>) {
      if (md.make_id && md.name) {
        const key = `${md.make_id}::${md.name.toLowerCase()}`;
        modelByMakeAndName.set(key, md._id);
      }
    }

    // ── Pass 1: Part 5 explicit ────────────────────────────────────────────
    let pass1Written = 0;
    let pass1SkippedManual = 0;
    let pass1SkippedAlreadySet = 0;
    const pass1UnmatchedRows: string[] = [];

    for (const row of PART5_TIERS) {
      const makeId = makeIdByName.get(row.make.toLowerCase());
      if (!makeId) {
        pass1UnmatchedRows.push(`make:${row.make} model:${row.model}`);
        continue;
      }
      const modelId = modelByMakeAndName.get(`${makeId}::${row.model.toLowerCase()}`);
      if (!modelId) {
        pass1UnmatchedRows.push(`make:${row.make} model:${row.model}`);
        continue;
      }

      // Find all vehicle_configs matching (make, model), year-agnostic
      const configs = await ctx.db
        .query("vehicle_configs")
        .withIndex("by_make_model_year" as any, (q: any) =>
          q.eq("make_id", makeId).eq("model_id", modelId),
        )
        .collect();

      for (const cfg of configs) {
        const existing = cfg.pricing_tier;
        const existingSource = cfg.pricing_tier_source;
        if (existing === row.tier) {
          pass1SkippedAlreadySet++;
          continue;
        }
        if (existingSource === "manual" && !force) {
          pass1SkippedManual++;
          continue;
        }
        await ctx.db.patch(cfg._id, {
          pricing_tier: row.tier,
          pricing_tier_source: "part5_seed",
          pricing_tier_set_at: now,
        });
        pass1Written++;
      }
    }

    // ── Pass 2: ASSIGNMENT_RULES fallback for still-null configs ───────────
    let pass2Written = 0;
    let pass2NoMatch = 0;

    // Resolve make_id → name and model_id → name once for matching
    const makeNameById = new Map<any, string>();
    for (const m of makes) makeNameById.set(m._id, m.name);
    const modelNameById = new Map<any, string>();
    for (const md of models as Array<{ _id: any; name?: string }>) {
      if (md.name) modelNameById.set(md._id, md.name);
    }

    const stillNull = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_pricing_tier", (q) => q.eq("pricing_tier", undefined))
      .collect();

    for (const cfg of stillNull) {
      const makeName = makeNameById.get(cfg.make_id) ?? "";
      const modelName = modelNameById.get(cfg.model_id) ?? "";
      const matchCtx = {
        make: makeName,
        model: modelName,
        trim: cfg.trim_name ?? "",
        year: cfg.year,
      };
      let matched: VehicleTier | null = null;
      for (const rule of ASSIGNMENT_RULES) {
        if (matchRule(rule, matchCtx)) {
          matched = rule.tier;
          break;
        }
      }
      if (matched) {
        await ctx.db.patch(cfg._id, {
          pricing_tier: matched,
          pricing_tier_source: "rules_engine",
          pricing_tier_set_at: now,
        });
        pass2Written++;
      } else {
        pass2NoMatch++;
      }
    }

    return {
      pass1_part5: {
        written: pass1Written,
        skipped_manual: pass1SkippedManual,
        skipped_already_set: pass1SkippedAlreadySet,
        unmatched_rows: pass1UnmatchedRows.length,
        unmatched_sample: pass1UnmatchedRows.slice(0, 10),
        total_rows: PART5_TIERS.length,
      },
      pass2_rules_fallback: {
        written: pass2Written,
        unassigned: pass2NoMatch,
      },
    };
  },
});
