/**
 * seedPricing.ts — MVP Pricing Multiplier seed (7-tier × category × Toyota base).
 *
 * Wipes and re-seeds pricing_tiers, pricing_multipliers, and
 * pricing_vehicle_assignments — the prior 4-tier (T1/T2/T3/T4) data is
 * dropped in favor of Yassin Wahman's 7-tier scheme (T1, T2a, T2b, T2c,
 * T3a, T3b, T4). pricing_baselines, ccb_absolute_prices, and the
 * services.pricing_category_id mapping are upserted in place (preserve
 * admin edits via is_real_data / data_source).
 *
 * Run:
 *   npx convex run seeds/seedPricing:run
 *
 * The 7-tier vocabulary lives in `convex/lib/vehicleTiers.ts` — that's the
 * single source of truth used by schema, shopLaborRates, and the future
 * quote engine. This file uses local tier descriptions only for the seed
 * row content (anchor vehicle labels + display copy).
 *
 * Vehicle-tier assignment is rule-based. The §2 weighted classifier is a
 * follow-up; until then, all assignments are stamped is_manual_override:true
 * so the future classifier won't trample seed values.
 */

import { internalMutation } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { VehicleTier } from "../lib/vehicleTiers";

// ──────────────────────────────────────────────────────────────────────────
// 1. Tiers — 7 entries, anchor vehicles from Yassin's enum comments
// ──────────────────────────────────────────────────────────────────────────

const TIERS: ReadonlyArray<{
  code: VehicleTier;
  name: string;
  anchor_vehicle_label: string;
  display_order: number;
  description: string;
}> = [
  {
    code: "T1",
    name: "Mainstream",
    anchor_vehicle_label: "2020 Toyota Camry LE",
    display_order: 1,
    description:
      "High-volume mass-market: Toyota, Honda, Ford, Hyundai, Kia, Mazda, Subaru, VW mass, GM, Ram, Jeep. Generalist shop friendly.",
  },
  {
    code: "T2a",
    name: "Value premium",
    anchor_vehicle_label: "2021 Lexus ES 350",
    display_order: 2,
    description:
      "Value-premium daily drivers: Lexus, Acura, Genesis, Volvo, Cadillac (non-V). Toyota/Honda-derived service complexity at a premium label.",
  },
  {
    code: "T2b",
    name: "German mid",
    anchor_vehicle_label: "2021 Mercedes-Benz C 300",
    display_order: 3,
    description:
      "Mercedes (non-AMG), Audi (non-S/RS), VW GTI/Arteon. OEM Euro parts premium + AGM/registration battery work.",
  },
  {
    code: "T2c",
    name: "BMW non-M",
    anchor_vehicle_label: "2021 BMW 330i",
    display_order: 4,
    description:
      "BMW non-M (3/5/X-Series base + M-Sport non-M), Porsche Macan base, MINI JCW. BMW-specialist labor premium over German mid.",
  },
  {
    code: "T3a",
    name: "Performance",
    anchor_vehicle_label: "2022 BMW M3 Competition",
    display_order: 5,
    description:
      "BMW M / M-Performance, Mercedes-AMG, Audi RS/S-line, Cadillac V-Series, Lexus F-Performance, Honda Civic Type R, Toyota GR, Subaru WRX.",
  },
  {
    code: "T3b",
    name: "Premium sports",
    anchor_vehicle_label: "2020 Porsche 911 Carrera (992)",
    display_order: 6,
    description:
      "Porsche 911 / 718 / Cayenne S/GTS / Panamera / Macan S/GTS, Mercedes-AMG GT, SL55/63, Audi R8, Lotus, F-Type R/SVR.",
  },
  {
    code: "T4",
    name: "Ultra-exotic",
    anchor_vehicle_label: "2022 Ferrari Roma",
    display_order: 7,
    description:
      "Ferrari, Lamborghini, McLaren, Aston Martin, Bentley, Rolls-Royce, Porsche 911 Turbo/GT3, Audi RS, BMW M-flagship (M5 CS, M4 CSL, M3 CS, M8 Competition).",
  },
];

// ──────────────────────────────────────────────────────────────────────────
// 2. Pricing categories (§3.1) — the 8 multiplier buckets
// ──────────────────────────────────────────────────────────────────────────

const CATEGORIES = [
  {
    code: "routine_fluids",
    name: "Routine fluids",
    display_order: 1,
    notes: "Oil change, brake fluid flush, coolant flush, diff fluid, trans fluid.",
  },
  {
    code: "filters_wear",
    name: "Filters & wear items",
    display_order: 2,
    notes: "Engine air, cabin air, drive belt, wipers. OEM Euro parts pricing premium drives T2 step.",
  },
  {
    code: "brakes_iron",
    name: "Brakes — iron",
    display_order: 3,
    notes: "Pads only, pads + rotors, calipers. CCB-equipped vehicles route to ccb_absolute_prices instead.",
  },
  {
    code: "ignition",
    name: "Ignition",
    display_order: 4,
    notes:
      "Spark plugs, coil packs. T4 step function reflects Porsche flat-six rear-plug-access (half-day vs. Camry one-hour).",
  },
  {
    code: "battery_electrical",
    name: "Battery & electrical",
    display_order: 5,
    notes:
      "Battery replace with registration, alternator R&R. T2 jump captures AGM + diagnostic-tool registration + trunk-mount labor.",
  },
  {
    code: "labor_diag",
    name: "Labor-only diagnostic & inspection",
    display_order: 6,
    notes:
      "CEL scan, electrical diag, multi-point, state inspection. Caps at 2.0× T4 — an hour is an hour.",
  },
  {
    code: "labor_chassis",
    name: "Labor-only chassis",
    display_order: 7,
    notes: "Alignment, tire rotation, wheel balance. Caps at 2.0× T4 for the same reason.",
  },
  {
    code: "specialized_engine",
    name: "Specialized engine work",
    display_order: 8,
    notes: "Carbon cleaning, PDK service, transaxle, hand-built engine specifics.",
  },
] as const;

type CategoryCode = (typeof CATEGORIES)[number]["code"];

// ──────────────────────────────────────────────────────────────────────────
// 3. Multiplier matrix — 8 categories × 7 tiers = 56 cells
// ──────────────────────────────────────────────────────────────────────────
// T2a/T2b/T2c initially share the old T2 value; T3a/T3b initially share the
// old T3 value. They diverge cell-by-cell as the admin tightens with real
// booking data. T1 and T4 unchanged from yesterday's matrix.

const MATRIX: Record<CategoryCode, Record<VehicleTier, number>> = {
  routine_fluids:     { T1: 1.0, T2a: 1.4,  T2b: 1.4,  T2c: 1.4,  T3a: 1.85, T3b: 1.85, T4: 2.4 },
  filters_wear:       { T1: 1.0, T2a: 1.6,  T2b: 1.6,  T2c: 1.6,  T3a: 2.0,  T3b: 2.0,  T4: 2.5 },
  brakes_iron:        { T1: 1.0, T2a: 1.75, T2b: 1.75, T2c: 1.75, T3a: 2.4,  T3b: 2.4,  T4: 3.5 },
  ignition:           { T1: 1.0, T2a: 1.8,  T2b: 1.8,  T2c: 1.8,  T3a: 2.8,  T3b: 2.8,  T4: 4.2 },
  battery_electrical: { T1: 1.0, T2a: 2.4,  T2b: 2.4,  T2c: 2.4,  T3a: 2.7,  T3b: 2.7,  T4: 3.0 },
  labor_diag:         { T1: 1.0, T2a: 1.5,  T2b: 1.5,  T2c: 1.5,  T3a: 1.7,  T3b: 1.7,  T4: 2.0 },
  labor_chassis:      { T1: 1.0, T2a: 1.5,  T2b: 1.5,  T2c: 1.5,  T3a: 1.7,  T3b: 1.7,  T4: 2.0 },
  specialized_engine: { T1: 1.0, T2a: 2.0,  T2b: 2.0,  T2c: 2.0,  T3a: 2.5,  T3b: 2.5,  T4: 3.5 },
};

// ──────────────────────────────────────────────────────────────────────────
// 4. Service → pricing-category map (by service slug). Unchanged from prior.
// ──────────────────────────────────────────────────────────────────────────

const SERVICE_PRICING_CATEGORY: Record<string, CategoryCode | null> = {
  diagnostic_scan: "labor_diag",
  pre_purchase_inspection: "labor_diag",
  check_engine_light: "labor_diag",
  state_inspection: "labor_diag",
  emissions_test: "labor_diag",
  battery_test: "labor_diag",
  oil_change: "routine_fluids",
  coolant_flush: "routine_fluids",
  transmission_service: "routine_fluids",
  power_steering_flush: "routine_fluids",
  differential_service: "routine_fluids",
  brake_fluid_flush: "routine_fluids",
  filter_replacement: "filters_wear",
  spark_plugs: "ignition",
  brake_pad_replacement: "brakes_iron",
  rotor_replacement: "brakes_iron",
  battery_replacement: "battery_electrical",
  timing_belt: "specialized_engine",
  fuel_system_cleaning: "specialized_engine",
  tire_rotation: "labor_chassis",
  tire_balance: "labor_chassis",
  wheel_alignment: "labor_chassis",
  tire_replacement: null,
};

// ──────────────────────────────────────────────────────────────────────────
// 5. Baselines (Toyota Camry T1 anchor prices, in cents). Unchanged.
// ──────────────────────────────────────────────────────────────────────────

const BASELINES: Record<
  string,
  { low_cents: number; high_cents: number; notes?: string }
> = {
  diagnostic_scan:        { low_cents:  6000, high_cents: 12000 },
  pre_purchase_inspection:{ low_cents: 15000, high_cents: 25000 },
  check_engine_light:     { low_cents:  9000, high_cents: 18000 },
  state_inspection:       { low_cents:  3700, high_cents:  3700, notes: "NY state cap" },
  emissions_test:         { low_cents:  2500, high_cents:  2500 },
  oil_change:             { low_cents:  6500, high_cents: 11000 },
  filter_replacement:     { low_cents:  4500, high_cents:  9500 },
  spark_plugs:            { low_cents: 18000, high_cents: 32000 },
  timing_belt:            { low_cents: 70000, high_cents:120000 },
  coolant_flush:          { low_cents: 14000, high_cents: 22000 },
  transmission_service:   { low_cents: 20000, high_cents: 35000 },
  tire_rotation:          { low_cents:  3000, high_cents:  6000 },
  tire_balance:           { low_cents:  6000, high_cents: 10000 },
  wheel_alignment:        { low_cents:  9500, high_cents: 16000 },
  brake_pad_replacement:  { low_cents: 22000, high_cents: 38000 },
  rotor_replacement:      { low_cents: 45000, high_cents: 75000 },
  brake_fluid_flush:      { low_cents: 11000, high_cents: 17000 },
  battery_replacement:    { low_cents: 18000, high_cents: 28000 },
  power_steering_flush:   { low_cents: 12000, high_cents: 18000 },
  differential_service:   { low_cents: 12000, high_cents: 22000 },
  fuel_system_cleaning:   { low_cents: 14000, high_cents: 22000 },
  battery_test:           { low_cents:  2500, high_cents:  5000 },
};

// ──────────────────────────────────────────────────────────────────────────
// 6. CCB absolute prices (§3.3). Unchanged.
// ──────────────────────────────────────────────────────────────────────────

const CCB_PRICES: Record<string, { low_cents: number; high_cents: number; notes?: string }> = {
  brake_pad_replacement: {
    low_cents: 240000,
    high_cents: 380000,
    notes: "CCB pad pair (front). Wide MVP band — refine after first CCB booking.",
  },
  rotor_replacement: {
    low_cents: 950000,
    high_cents: 1600000,
    notes: "CCB rotor single. Rotors often lifetime if undamaged; verify before quoting.",
  },
  brake_fluid_flush: {
    low_cents: 40000,
    high_cents: 65000,
    notes: "CCB-compatible brake fluid flush.",
  },
};

// ──────────────────────────────────────────────────────────────────────────
// 7. Vehicle-tier rules — 7-tier mapping
// ──────────────────────────────────────────────────────────────────────────
// First match wins. Most-specific patterns precede catch-alls. The mapping
// follows the plan §"Tier mapping (4 → 7)":
//   - Lexus/Acura/Genesis/Volvo/Cadillac → T2a
//   - Mercedes non-AMG / Audi non-S/RS / VW GTI → T2b
//   - BMW non-M / Macan base / MINI JCW → T2c
//   - BMW M / AMG / S-line / Type S / Civic Type R / WRX / GR → T3a
//   - 911 base / 718 / Cayenne S/GTS / Panamera / R8 / AMG GT → T3b
//   - 911 Turbo / GT3 / RS / M-flagship / Aston / Bentley / Rolls → T4

export type AssignmentRule = {
  tier: VehicleTier;
  make?: string;
  model_includes?: string;
  model_excludes?: string[];
  trim_includes?: string[];
  trim_excludes?: string[];
  year_min?: number;
  year_max?: number;
  brake_system?: "iron_standard" | "iron_high_performance" | "ccb_optional" | "ccb_standard";
  reason: string;
};

export const ASSIGNMENT_RULES: AssignmentRule[] = [
  // ════════════════════ T4 ULTRA-EXOTIC (most specific first) ═══════════
  // Porsche 911 Turbo / GT3 / GT3 RS / Turbo S
  { tier: "T4", make: "Porsche", model_includes: "911",
    trim_includes: ["Turbo", "GT3", "GT2"],
    reason: "Porsche 911 Turbo/GT3/GT2 — T4 ultra-exotic" },
  // Porsche 718 GT4 / Spyder — Yassin's T3b lists "Cayman" generically;
  // GT4/Spyder are the limited / hand-built variants → T4.
  { tier: "T4", make: "Porsche", model_includes: "718",
    trim_includes: ["GT4", "Spyder"],
    reason: "Porsche 718 GT4/Spyder — T4 limited/hand-built" },
  // Porsche Cayenne Turbo / Turbo GT
  { tier: "T4", make: "Porsche", model_includes: "Cayenne",
    trim_includes: ["Turbo"],
    reason: "Cayenne Turbo / Turbo GT — T4" },
  // Porsche Panamera Turbo / Turbo S
  { tier: "T4", make: "Porsche", model_includes: "Panamera",
    trim_includes: ["Turbo"],
    reason: "Panamera Turbo / Turbo S — T4" },
  // Audi RS-line (RS3/RS5/RS6/RS7/RSQ8) — high-perf hand-tuned
  { tier: "T4", make: "Audi", trim_includes: ["RS3", "RS5", "RS6", "RS7", "RSQ8"],
    reason: "Audi RS-line — T4 high-perf" },
  { tier: "T4", make: "Audi", model_includes: "RS",
    reason: "Audi RS models — T4" },
  // BMW M flagship variants
  { tier: "T4", make: "BMW", model_includes: "M5",
    trim_includes: ["CS"], reason: "BMW M5 CS — T4 flagship" },
  { tier: "T4", make: "BMW", model_includes: "M4",
    trim_includes: ["CSL"], reason: "BMW M4 CSL — T4 flagship" },
  { tier: "T4", make: "BMW", model_includes: "M3",
    trim_includes: ["CS"], reason: "BMW M3 CS — T4 flagship" },
  { tier: "T4", make: "BMW", model_includes: "M8",
    trim_includes: ["Competition"], reason: "BMW M8 Competition — T4" },
  // Ultra-luxury / hand-built marques (catch-alls)
  { tier: "T4", make: "Aston Martin", reason: "Aston Martin — T4 ultra-exotic" },
  { tier: "T4", make: "Bentley", reason: "Bentley — T4 ultra-luxury" },
  { tier: "T4", make: "Rolls-Royce", reason: "Rolls-Royce — T4 ultra-luxury" },
  { tier: "T4", make: "Ferrari", reason: "Ferrari — T4 ultra-exotic" },
  { tier: "T4", make: "Lamborghini", reason: "Lamborghini — T4 ultra-exotic" },
  { tier: "T4", make: "McLaren", reason: "McLaren — T4 ultra-exotic" },
  // Maserati: MC20 + Levante Trofeo are T4; GranTurismo is T3b (handled below)
  { tier: "T4", make: "Maserati", model_includes: "MC20",
    reason: "Maserati MC20 — T4 mid-engine" },
  { tier: "T4", make: "Maserati", model_includes: "Levante",
    trim_includes: ["Trofeo"],
    reason: "Levante Trofeo — T4" },

  // ════════════════════ T3b PREMIUM SPORTS ══════════════════════════════
  // Porsche 911 base / Carrera (catch-all for non-Turbo/non-GT3)
  { tier: "T3b", make: "Porsche", model_includes: "911",
    reason: "Porsche 911 (base/Carrera) — T3b premium sports" },
  // Porsche 718 base / Cayman / Boxster
  { tier: "T3b", make: "Porsche", model_includes: "718",
    reason: "Porsche 718 (non-GT4/Spyder) — T3b" },
  { tier: "T3b", make: "Porsche", model_includes: "Cayman",
    reason: "Porsche Cayman — T3b premium sports" },
  { tier: "T3b", make: "Porsche", model_includes: "Boxster",
    reason: "Porsche Boxster — T3b premium sports" },
  // Porsche Cayenne S / GTS (non-Turbo)
  { tier: "T3b", make: "Porsche", model_includes: "Cayenne",
    trim_includes: ["GTS", "S"], trim_excludes: ["Turbo"],
    reason: "Cayenne S/GTS — T3b" },
  // Porsche Panamera (non-Turbo) — base/4/GTS
  { tier: "T3b", make: "Porsche", model_includes: "Panamera",
    trim_excludes: ["Turbo"],
    reason: "Panamera (non-Turbo) — T3b" },
  // Mercedes AMG GT (2-door coupé/roadster, not the 4-door)
  { tier: "T3b", make: "Mercedes-Benz", model_includes: "AMG GT",
    reason: "Mercedes-AMG GT 2-door — T3b premium sports" },
  // Mercedes SL55 / SL63 flagship roadsters
  { tier: "T3b", make: "Mercedes-Benz", model_includes: "SL",
    trim_includes: ["55", "63"],
    reason: "Mercedes SL55/SL63 — T3b" },
  // Audi R8
  { tier: "T3b", make: "Audi", model_includes: "R8",
    reason: "Audi R8 — T3b mid-engine V10" },
  // Lotus (Emira, Evora, etc) — lightweight specialty sports
  { tier: "T3b", make: "Lotus",
    reason: "Lotus — T3b premium sports" },
  // Jaguar F-Type R / SVR
  { tier: "T3b", make: "Jaguar", model_includes: "F-Type",
    trim_includes: ["R", "SVR"],
    reason: "Jaguar F-Type R/SVR — T3b" },
  // Maserati GranTurismo (the new MC20-platform GT)
  { tier: "T3b", make: "Maserati", model_includes: "GranTurismo",
    reason: "Maserati GranTurismo — T3b" },

  // ════════════════════ T3a PERFORMANCE ═════════════════════════════════
  // BMW M / M-Performance + M-badged SUVs
  { tier: "T3a", make: "BMW", model_includes: "M2",
    reason: "BMW M2 — T3a performance" },
  { tier: "T3a", make: "BMW", model_includes: "M3",
    reason: "BMW M3 (non-CS) — T3a" },
  { tier: "T3a", make: "BMW", model_includes: "M4",
    reason: "BMW M4 (non-CSL) — T3a" },
  { tier: "T3a", make: "BMW", model_includes: "M5",
    reason: "BMW M5 (non-CS) — T3a" },
  { tier: "T3a", make: "BMW", model_includes: "M8",
    reason: "BMW M8 (non-Competition) — T3a" },
  { tier: "T3a", make: "BMW",
    trim_includes: ["M340i", "M440i", "M550i", "M40i", "M50i", "M60i"],
    reason: "BMW M-Performance trims — T3a" },
  { tier: "T3a", make: "BMW", model_includes: "X3 M",
    reason: "BMW X3 M — T3a" },
  { tier: "T3a", make: "BMW", model_includes: "X4 M",
    reason: "BMW X4 M — T3a" },
  { tier: "T3a", make: "BMW", model_includes: "X5 M",
    reason: "BMW X5 M — T3a" },
  { tier: "T3a", make: "BMW", model_includes: "X6 M",
    reason: "BMW X6 M — T3a" },
  // Mercedes-AMG (everything not already routed to T3b/T4)
  { tier: "T3a", make: "Mercedes-Benz", model_includes: "AMG",
    reason: "Mercedes-AMG (non-GT 2-door, non-SL flagship) — T3a" },
  { tier: "T3a", make: "Mercedes-Benz", trim_includes: ["AMG"],
    reason: "Mercedes trim with AMG badge — T3a" },
  // Audi S-line (S3/S4/S5/S6/S7/SQ5/SQ7/SQ8/TTS)
  { tier: "T3a", make: "Audi",
    trim_includes: ["S3", "S4", "S5", "S6", "S7", "SQ5", "SQ7", "SQ8", "TTS"],
    reason: "Audi S-line — T3a" },
  // Cadillac V-Series
  { tier: "T3a", make: "Cadillac", model_includes: "CT5-V",
    reason: "Cadillac CT5-V — T3a" },
  { tier: "T3a", make: "Cadillac", model_includes: "Escalade-V",
    reason: "Cadillac Escalade-V — T3a" },
  // Porsche Macan S / GTS (non-Turbo, base Macan handled at T2c)
  { tier: "T3a", make: "Porsche", model_includes: "Macan",
    trim_includes: ["GTS", "S"], trim_excludes: ["Turbo"],
    reason: "Porsche Macan S/GTS — T3a" },
  // Lexus F-Performance
  { tier: "T3a", make: "Lexus",
    trim_includes: ["F Sport Performance", "IS500"],
    reason: "Lexus F-Performance trims — T3a" },
  { tier: "T3a", make: "Lexus", model_includes: "RC F",
    reason: "Lexus RC F — T3a" },
  { tier: "T3a", make: "Lexus", model_includes: "LC",
    reason: "Lexus LC500 — T3a" },
  // Acura Type S
  { tier: "T3a", make: "Acura", trim_includes: ["Type S"],
    reason: "Acura Type S — T3a" },
  // Honda Civic Type R
  { tier: "T3a", make: "Honda", model_includes: "Civic",
    trim_includes: ["Type R"],
    reason: "Honda Civic Type R — T3a" },
  // VW Golf R
  { tier: "T3a", make: "Volkswagen", model_includes: "Golf",
    trim_includes: ["R"], trim_excludes: ["GTI"],
    reason: "VW Golf R — T3a" },
  // Subaru WRX / STI (high-perf rally lineage)
  { tier: "T3a", make: "Subaru", model_includes: "WRX",
    reason: "Subaru WRX / STI — T3a" },
  // Toyota GR (GR Corolla, GR86, GR Supra)
  { tier: "T3a", make: "Toyota", model_includes: "GR",
    reason: "Toyota GR (Corolla, 86, Supra) — T3a" },
  // Subaru BRZ (GR86 platform sibling)
  { tier: "T3a", make: "Subaru", model_includes: "BRZ",
    reason: "Subaru BRZ — T3a" },
  // Ford F-150 Raptor
  { tier: "T3a", make: "Ford", model_includes: "F-150",
    trim_includes: ["Raptor"],
    reason: "Ford F-150 Raptor — T3a high-perf truck" },
  // Jeep Grand Cherokee SRT / Trackhawk
  { tier: "T3a", make: "Jeep", model_includes: "Grand Cherokee",
    trim_includes: ["SRT", "Trackhawk"],
    reason: "Jeep Grand Cherokee SRT/Trackhawk — T3a" },
  // Jeep Wrangler 392
  { tier: "T3a", make: "Jeep", model_includes: "Wrangler",
    trim_includes: ["392"],
    reason: "Jeep Wrangler 392 — T3a V8" },
  // Ram 1500 TRX
  { tier: "T3a", make: "Ram", model_includes: "1500",
    trim_includes: ["TRX"],
    reason: "Ram 1500 TRX — T3a" },

  // ════════════════════ T2c BMW non-M ═══════════════════════════════════
  // Porsche Macan base (closer to Q5 / BMW X3 base in service complexity)
  { tier: "T2c", make: "Porsche", model_includes: "Macan",
    reason: "Porsche Macan base — T2c" },
  // MINI JCW
  { tier: "T2c", make: "MINI", trim_includes: ["JCW", "John Cooper Works"],
    reason: "MINI JCW — T2c" },
  // BMW catch-all for non-M, non-M-Performance trims
  { tier: "T2c", make: "BMW",
    reason: "BMW (non-M, non-M-Performance) — T2c" },

  // ════════════════════ T2b German mid ══════════════════════════════════
  { tier: "T2b", make: "Mercedes-Benz",
    reason: "Mercedes-Benz (non-AMG) — T2b" },
  { tier: "T2b", make: "Audi",
    reason: "Audi (non-S, non-RS) — T2b" },
  { tier: "T2b", make: "Volkswagen", model_includes: "Golf",
    trim_includes: ["GTI"],
    reason: "VW GTI — T2b hot hatch" },
  { tier: "T2b", make: "Volkswagen", model_includes: "Arteon",
    reason: "VW Arteon — T2b" },
  // MINI base (non-JCW)
  { tier: "T2b", make: "MINI",
    reason: "MINI (non-JCW) — T2b" },

  // ════════════════════ T2a Value premium ═══════════════════════════════
  { tier: "T2a", make: "Lexus",
    reason: "Lexus (non-F-Performance) — T2a" },
  { tier: "T2a", make: "Acura",
    reason: "Acura (non-Type S) — T2a" },
  { tier: "T2a", make: "Genesis",
    reason: "Genesis — T2a" },
  { tier: "T2a", make: "Volvo",
    reason: "Volvo (non-Polestar) — T2a" },
  { tier: "T2a", make: "Cadillac",
    reason: "Cadillac (non-V-Series) — T2a" },
  // Honda Accord 2.0T (boundary call — sport variant of mass model)
  { tier: "T2a", make: "Honda", model_includes: "Accord",
    trim_includes: ["2.0T", "Sport 2.0"],
    reason: "Honda Accord 2.0T Sport — T2a boundary" },

  // ════════════════════ T1 MAINSTREAM (catch-all by make) ═══════════════
  { tier: "T1", make: "Toyota",   reason: "Toyota — T1 baseline" },
  { tier: "T1", make: "Honda",    reason: "Honda — T1" },
  { tier: "T1", make: "Nissan",   reason: "Nissan — T1" },
  { tier: "T1", make: "Hyundai",  reason: "Hyundai — T1" },
  { tier: "T1", make: "Kia",      reason: "Kia — T1" },
  { tier: "T1", make: "Mazda",    reason: "Mazda — T1" },
  { tier: "T1", make: "Subaru",   reason: "Subaru (non-WRX/BRZ) — T1" },
  { tier: "T1", make: "Volkswagen", reason: "VW mass market — T1" },
  { tier: "T1", make: "Ford",     reason: "Ford (non-Raptor) — T1" },
  { tier: "T1", make: "Chevrolet",reason: "Chevrolet — T1" },
  { tier: "T1", make: "GMC",      reason: "GMC — T1" },
  { tier: "T1", make: "Ram",      reason: "Ram (non-TRX) — T1" },
  { tier: "T1", make: "Jeep",     reason: "Jeep (non-SRT/Trackhawk/392) — T1" },
  { tier: "T1", make: "Chrysler", reason: "Chrysler — T1" },
  { tier: "T1", make: "Dodge",    reason: "Dodge (Hellcat → upgrade to T3a when in catalog) — T1" },
  { tier: "T1", make: "Buick",    reason: "Buick — T1" },
  { tier: "T1", make: "Mitsubishi", reason: "Mitsubishi — T1" },
];

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

export const norm = (s: string | undefined) => (s ?? "").toLowerCase().trim();

export function matchRule(
  rule: AssignmentRule,
  ctx: { make: string; model: string; trim: string; year: number },
): boolean {
  if (rule.make && norm(rule.make) !== norm(ctx.make)) return false;
  if (rule.model_includes && !norm(ctx.model).includes(norm(rule.model_includes))) return false;
  if (rule.model_excludes) {
    for (const ex of rule.model_excludes) {
      if (norm(ctx.model).includes(norm(ex))) return false;
    }
  }
  if (rule.trim_includes) {
    const t = norm(ctx.trim);
    const anyHit = rule.trim_includes.some((p) => t.includes(norm(p)));
    if (!anyHit) return false;
  }
  if (rule.trim_excludes) {
    const t = norm(ctx.trim);
    for (const ex of rule.trim_excludes) {
      if (t.includes(norm(ex))) return false;
    }
  }
  if (rule.year_min != null && ctx.year < rule.year_min) return false;
  if (rule.year_max != null && ctx.year > rule.year_max) return false;
  return true;
}

// ──────────────────────────────────────────────────────────────────────────
// The seed
// ──────────────────────────────────────────────────────────────────────────

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stats = {
      migrated: { tiers_deleted: 0, multipliers_deleted: 0, assignments_deleted: 0 },
      tiers: { inserted: 0, updated: 0 },
      categories: { inserted: 0, updated: 0 },
      multipliers: { inserted: 0, updated: 0 },
      baselines: { inserted: 0, updated: 0, missing_services: 0 },
      ccb_prices: { inserted: 0, updated: 0, missing_services: 0 },
      service_map: { patched: 0, missing_services: 0 },
      vehicle_assignments: { inserted: 0, updated: 0, unmatched: 0, scanned: 0 },
    };

    // 0. Wipe 4-tier data from yesterday before installing the 7-tier set.
    //    Order matters: assignments + multipliers FK to tiers, so kill the
    //    leaves first.
    const oldAssignments = await ctx.db.query("pricing_vehicle_assignments").collect();
    for (const row of oldAssignments) await ctx.db.delete(row._id);
    stats.migrated.assignments_deleted = oldAssignments.length;

    const oldMultipliers = await ctx.db.query("pricing_multipliers").collect();
    for (const row of oldMultipliers) await ctx.db.delete(row._id);
    stats.migrated.multipliers_deleted = oldMultipliers.length;

    const oldTiers = await ctx.db.query("pricing_tiers").collect();
    for (const row of oldTiers) await ctx.db.delete(row._id);
    stats.migrated.tiers_deleted = oldTiers.length;

    // 1. Tiers (fresh inserts now that the old rows are gone)
    const tierIdByCode = new Map<VehicleTier, Id<"pricing_tiers">>();
    for (const t of TIERS) {
      const id = await ctx.db.insert("pricing_tiers", {
        code: t.code,
        name: t.name,
        anchor_vehicle_label: t.anchor_vehicle_label,
        display_order: t.display_order,
        description: t.description,
        is_active: true,
        created_at: now,
        updated_at: now,
      });
      tierIdByCode.set(t.code, id);
      stats.tiers.inserted++;
    }

    // 2. Categories (upsert by code — preserve admin edits to notes)
    const categoryIdByCode = new Map<CategoryCode, Id<"pricing_service_categories">>();
    for (const c of CATEGORIES) {
      const existing = await ctx.db
        .query("pricing_service_categories")
        .withIndex("by_code", (q) => q.eq("code", c.code))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          name: c.name,
          display_order: c.display_order,
          notes: c.notes,
          is_active: true,
          updated_at: now,
        });
        categoryIdByCode.set(c.code, existing._id);
        stats.categories.updated++;
      } else {
        const id = await ctx.db.insert("pricing_service_categories", {
          code: c.code,
          name: c.name,
          display_order: c.display_order,
          notes: c.notes,
          is_active: true,
          created_at: now,
          updated_at: now,
        });
        categoryIdByCode.set(c.code, id);
        stats.categories.inserted++;
      }
    }

    // 3. Multipliers (fresh inserts — 7×8 = 56 cells)
    for (const catCode of Object.keys(MATRIX) as CategoryCode[]) {
      for (const tierCode of Object.keys(MATRIX[catCode]) as VehicleTier[]) {
        const tierId = tierIdByCode.get(tierCode);
        const catId = categoryIdByCode.get(catCode);
        if (!tierId || !catId) continue;
        await ctx.db.insert("pricing_multipliers", {
          tier_id: tierId,
          pricing_category_id: catId,
          multiplier: MATRIX[catCode][tierCode],
          min_bookings_for_lock: 20,
          validated_booking_count: 0,
          is_locked: false,
          created_at: now,
          updated_at: now,
        });
        stats.multipliers.inserted++;
      }
    }

    // Cache services by slug for the next three sections
    const allServices = await ctx.db.query("services").collect();
    const serviceBySlug = new Map<string, Doc<"services">>();
    for (const s of allServices) {
      if (s.slug) serviceBySlug.set(s.slug, s);
    }

    // 4. Baselines — upsert; preserve admin is_real_data/data_source upgrades
    for (const [slug, base] of Object.entries(BASELINES)) {
      const svc = serviceBySlug.get(slug);
      if (!svc) {
        stats.baselines.missing_services++;
        console.warn(`seedPricing: baseline for unknown service slug "${slug}" — skipping`);
        continue;
      }
      const existing = await ctx.db
        .query("pricing_baselines")
        .withIndex("by_service", (q) => q.eq("service_id", svc._id))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          base_price_low_cents: base.low_cents,
          base_price_high_cents: base.high_cents,
          is_real_data: existing.is_real_data,
          data_source: existing.data_source,
          notes: base.notes ?? existing.notes,
          updated_at: now,
        });
        stats.baselines.updated++;
      } else {
        await ctx.db.insert("pricing_baselines", {
          service_id: svc._id,
          base_price_low_cents: base.low_cents,
          base_price_high_cents: base.high_cents,
          is_real_data: false,
          data_source: "modeled",
          notes: base.notes,
          created_at: now,
          updated_at: now,
        });
        stats.baselines.inserted++;
      }
    }

    // 5. CCB absolute prices
    for (const [slug, ccb] of Object.entries(CCB_PRICES)) {
      const svc = serviceBySlug.get(slug);
      if (!svc) {
        stats.ccb_prices.missing_services++;
        continue;
      }
      const existing = await ctx.db
        .query("ccb_absolute_prices")
        .withIndex("by_service", (q) => q.eq("service_id", svc._id))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          price_low_cents: ccb.low_cents,
          price_high_cents: ccb.high_cents,
          notes: ccb.notes ?? existing.notes,
          updated_at: now,
        });
        stats.ccb_prices.updated++;
      } else {
        await ctx.db.insert("ccb_absolute_prices", {
          service_id: svc._id,
          price_low_cents: ccb.low_cents,
          price_high_cents: ccb.high_cents,
          notes: ccb.notes,
          created_at: now,
          updated_at: now,
        });
        stats.ccb_prices.inserted++;
      }
    }

    // 6. Service → pricing-category mapping
    for (const [slug, catCode] of Object.entries(SERVICE_PRICING_CATEGORY)) {
      const svc = serviceBySlug.get(slug);
      if (!svc) {
        stats.service_map.missing_services++;
        continue;
      }
      const catId = catCode ? categoryIdByCode.get(catCode) : undefined;
      await ctx.db.patch(svc._id, { pricing_category_id: catId });
      stats.service_map.patched++;
    }

    // 7. Vehicle tier assignments — rule-based over existing vehicle_configs
    const makes = await ctx.db.query("makes").collect();
    const models = await ctx.db.query("models").collect();
    const makeNameById = new Map(makes.map((m) => [m._id, m.name]));
    const modelNameById = new Map(models.map((m) => [m._id, m.name]));

    const configs = await ctx.db.query("vehicle_configs").collect();
    stats.vehicle_assignments.scanned = configs.length;

    for (const cfg of configs) {
      const make = makeNameById.get(cfg.make_id) ?? "";
      const model = modelNameById.get(cfg.model_id) ?? "";
      const trim = cfg.trim_name ?? "";
      const year = cfg.year;

      let matched: AssignmentRule | undefined;
      for (const rule of ASSIGNMENT_RULES) {
        if (matchRule(rule, { make, model, trim, year })) {
          matched = rule;
          break;
        }
      }
      if (!matched) {
        stats.vehicle_assignments.unmatched++;
        continue;
      }

      const tierId = tierIdByCode.get(matched.tier);
      if (!tierId) continue;

      const brake_system = matched.brake_system ?? "iron_standard";
      const powertrain_type = "ice";

      // Fresh inserts — step 0 wiped pricing_vehicle_assignments, so no
      // existing row guard is needed here.
      await ctx.db.insert("pricing_vehicle_assignments", {
        vehicle_config_id: cfg._id,
        tier_id: tierId,
        brake_system,
        powertrain_type,
        is_manual_override: true,
        override_reason: matched.reason,
        assigned_at: now,
        created_at: now,
        updated_at: now,
      });
      stats.vehicle_assignments.inserted++;
    }

    console.log("seedPricing complete", JSON.stringify(stats, null, 2));
    return stats;
  },
});
