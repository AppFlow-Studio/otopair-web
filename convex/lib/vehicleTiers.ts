/**
 * lib/vehicleTiers.ts — single source of truth for the 7 vehicle tiers.
 *
 * Used by:
 *   - schema.ts (tierValidator on shops.declined_tiers)
 *   - shopLaborRates.ts (mutation + query)
 *   - the future quote engine (resolveLaborRate)
 *
 * Pure module — no Convex API surface, no DB access. Safe to import anywhere
 * and unit-test in isolation.
 *
 * Tier vocabulary chosen by Waleed + Yassin based on NYC indie-shop
 * observations: T2 is sub-divided by marque family (T2a value-premium / T2b
 * German-mid / T2c BMW-non-M) because labor cost differs even though parts
 * pricing is similar. T3 is sub-divided into T3a performance and T3b premium
 * sports because a 911 specialist prices very differently from an M-shop.
 */

import { v } from "convex/values";

// The seven canonical tiers. Order is display order — keep it stable so
// admin UIs render consistently.
export const VEHICLE_TIERS = [
  "T1",  // Mainstream        — Toyota, Honda, Ford, Hyundai
  "T2a", // Value premium     — Lexus, Acura, Genesis, Volvo
  "T2b", // German mid        — Mercedes (non-AMG), Audi (non-S), VW GTI
  "T2c", // BMW non-M         — BMW 3/5, Macan base, MINI JCW
  "T3a", // Performance       — BMW M, AMG, Audi RS/S
  "T3b", // Premium sports    — 911, Cayman, AMG GT, R8
  "T4",  // Ultra-exotic      — Ferrari, Lamborghini, Rolls, Bentley
] as const;

export type VehicleTier = (typeof VEHICLE_TIERS)[number];

// Reusable validator. Use as a Convex arg validator and inside table defs.
export const tierValidator = v.union(
  v.literal("T1"),
  v.literal("T2a"),
  v.literal("T2b"),
  v.literal("T2c"),
  v.literal("T3a"),
  v.literal("T3b"),
  v.literal("T4"),
);

export const TIER_LABELS: Record<VehicleTier, string> = {
  T1:  "Mainstream",
  T2a: "Value premium",
  T2b: "German mid",
  T2c: "BMW non-M",
  T3a: "Performance",
  T3b: "Premium sports",
  T4:  "Ultra-exotic",
};

// Recommended NYC dollar/hour bands. Soft signal only — a shop CAN price
// outside the band; the doc treats out-of-band rates as a quality-watch
// signal, not an error. Per Otopair_NYC_Labor_Rate_Tiers_v1 + Pricing System
// FINAL v2 ladder.
export const TIER_BANDS: Record<
  VehicleTier,
  { lo: number; hi: number; label: string }
> = {
  T1:  { lo: 130, hi: 150, label: "Mainstream" },
  T2a: { lo: 160, hi: 185, label: "Value premium" },
  T2b: { lo: 165, hi: 195, label: "German mid" },
  T2c: { lo: 175, hi: 210, label: "BMW non-M" },
  T3a: { lo: 195, hi: 235, label: "Performance" },
  T3b: { lo: 215, hi: 275, label: "Premium sports" },
  T4:  { lo: 250, hi: 400, label: "Ultra-exotic" },
};

// Hard sanity rails ($/hr). A rate outside this is almost certainly a typo
// ($16/hr, $1600/hr) — reject rather than warn.
export const ABSOLUTE_MIN_RATE = 50;
export const ABSOLUTE_MAX_RATE = 900;

// ──────────────────────────────────────────────────────────────────────────
// Pure resolver — what the quote engine calls. Given a shop document slice
// and the vehicle's tier, returns the rate to bill plus a source label for
// audit/debug. Pure → unit-testable without a DB.
// ──────────────────────────────────────────────────────────────────────────

export type LaborRateSource = "tier" | "legacy_fallback" | "declined" | "none";

export function resolveLaborRate(
  shop: {
    labor_rates_by_tier?: Partial<Record<VehicleTier, number | undefined>> | null;
    declined_tiers?: readonly string[] | null;
    labor_rate?: number | null;
  },
  vehicleTier: VehicleTier,
): { rate: number | null; source: LaborRateSource; serviceable: boolean } {
  const declined = new Set(shop.declined_tiers ?? []);

  // 1. Shop explicitly declined this tier → not serviceable here.
  if (declined.has(vehicleTier)) {
    return { rate: null, source: "declined", serviceable: false };
  }

  // 2. Shop has a specific rate for this tier → use it.
  const tierRate = shop.labor_rates_by_tier?.[vehicleTier];
  if (tierRate != null) {
    return { rate: tierRate, source: "tier", serviceable: true };
  }

  // 3. Tier unset → fall back to the legacy single labor_rate.
  if (shop.labor_rate != null) {
    return { rate: shop.labor_rate, source: "legacy_fallback", serviceable: true };
  }

  // 4. Nothing to price with.
  return { rate: null, source: "none", serviceable: false };
}

// ──────────────────────────────────────────────────────────────────────────
// Self-classifying shop profile — same inference the onboarding UI shows.
// Pure helper, exported for reuse in queries and the future shop card.
// ──────────────────────────────────────────────────────────────────────────

export function classifyShop(
  rates: Partial<Record<VehicleTier, number>>,
  declined: ReadonlySet<string>,
): string {
  const priced = (Object.keys(rates) as VehicleTier[]).filter(
    (t) => rates[t] != null,
  );
  if (priced.length === 0) return "incomplete";

  const topTiers = priced.filter((t) => t === "T3a" || t === "T3b" || t === "T4");
  const germanTiers = priced.filter(
    (t) => (t === "T2b" || t === "T2c") && (rates[t] ?? 0) >= TIER_BANDS[t].lo,
  );

  const vals = priced.map((t) => rates[t] as number);
  const flat = priced.length > 2 && Math.max(...vals) - Math.min(...vals) < 20;

  if (topTiers.length >= 2) return "performance / marque specialist";
  if (germanTiers.length >= 1 && topTiers.length === 0) return "German specialist";
  if (flat) return "generalist (flat pricing)";
  // Silence the unused-set warning while preserving the parameter contract —
  // declined feeds future profile refinements (e.g., "boutique, declines mass").
  void declined;
  return "multi-tier generalist";
}
