/**
 * lib/tierResolver.ts — the canonical "what pricing tier is this vehicle?"
 * resolution, shared by the quote engine, config-creation, the backfill, and
 * the Director Cars surface.
 *
 * Precedence (single source of truth):
 *   1. Per-config MANUAL override — vehicle_configs.pricing_tier_source ===
 *      "manual". Handled by callers (never touched here / by the backfill).
 *   2. Director rule — best match in the pricing_tier_rules table.
 *   3. Hardcoded ASSIGNMENT_RULES (convex/seeds/seedPricing.ts) — unchanged.
 *   4. No match → null → "Needs review" (the quote engine refuses to quote a
 *      null tier; we never auto-default an unknown car to a tier).
 *
 * Director-rule matching MIRRORS matchRule (seedPricing): make_key equality,
 * model_includes / trim_includes substring (lowercased), optional inclusive
 * year range. Most-specific rule wins; ties broken by most-recently-updated.
 *
 * Pure except resolveTierForVehicle/Config, which do a single indexed read of
 * pricing_tier_rules. Works with both QueryCtx and MutationCtx (DatabaseReader
 * is the common denominator — DatabaseWriter extends it).
 */

import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { ASSIGNMENT_RULES, matchRule, norm, type AssignmentRule } from "../seeds/seedPricing";
import { makeKeyOf } from "./makeKey";
import type { VehicleTier } from "./vehicleTiers";

export type TierMatchCtx = {
  make: string;
  model: string;
  trim: string;
  year: number;
};

export type TierRule = Doc<"pricing_tier_rules">;

export type TierSource = "director_rule" | "rules_engine";

export type TierResolution = {
  tier: VehicleTier | null;
  source: TierSource | null;
  ruleId?: string;
  reason?: string;
};

// ──────────────────────────────────────────────────────────────────────────
// Pure matchers
// ──────────────────────────────────────────────────────────────────────────

/** Predicate mirroring matchRule for a Director rule. Disabled rules never
 *  match. */
export function matchTierRule(rule: TierRule, ctx: TierMatchCtx): boolean {
  if (!rule.enabled) return false;
  if (makeKeyOf(rule.make) !== makeKeyOf(ctx.make)) return false;
  if (rule.model_includes && !norm(ctx.model).includes(norm(rule.model_includes))) return false;
  if (rule.trim_includes && !norm(ctx.trim).includes(norm(rule.trim_includes))) return false;
  if (rule.year_min != null && ctx.year < rule.year_min) return false;
  if (rule.year_max != null && ctx.year > rule.year_max) return false;
  return true;
}

/** Higher = more specific. trim-scoped beats model-scoped beats make-only; a
 *  year-bounded rule edges out an unbounded one at the same scope. */
export function ruleSpecificity(rule: TierRule): number {
  let s = 0;
  if (rule.trim_includes) s += 4;
  if (rule.model_includes) s += 2;
  if (rule.year_min != null || rule.year_max != null) s += 1;
  return s;
}

/** Best enabled rule for this vehicle, or null. Most-specific wins; ties
 *  broken by most-recently-updated so a fresh edit takes precedence. */
export function pickTierRule(rules: TierRule[], ctx: TierMatchCtx): TierRule | null {
  let best: TierRule | null = null;
  let bestScore = -1;
  for (const r of rules) {
    if (!matchTierRule(r, ctx)) continue;
    const score = ruleSpecificity(r);
    if (best === null || score > bestScore || (score === bestScore && r.updated_at > best.updated_at)) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

/** Walk the hardcoded engine — first-match-wins, same order detectTier used. */
export function matchAssignmentRules(ctx: TierMatchCtx): AssignmentRule | null {
  for (const rule of ASSIGNMENT_RULES) {
    if (matchRule(rule, ctx)) return rule;
  }
  return null;
}

/** Resolve against an already-fetched rule set (pure). Callers that scan the
 *  whole rules table once (e.g. carsList over 200 cars) use this to avoid a
 *  per-car DB read. */
export function resolveTierWithRules(
  rules: TierRule[],
  ctx: TierMatchCtx,
): TierResolution {
  const rule = pickTierRule(rules, ctx);
  if (rule) {
    return { tier: rule.tier as VehicleTier, source: "director_rule", ruleId: String(rule._id), reason: rule.note };
  }
  const hard = matchAssignmentRules(ctx);
  if (hard) return { tier: hard.tier, source: "rules_engine", reason: hard.reason };
  return { tier: null, source: null };
}

// ──────────────────────────────────────────────────────────────────────────
// DB-reading resolvers
// ──────────────────────────────────────────────────────────────────────────

/** The canonical resolution for a single vehicle. Director rules first (single
 *  indexed read by make_key), then the hardcoded engine, then null. */
export async function resolveTierForVehicle(
  db: DatabaseReader,
  ctx: TierMatchCtx,
): Promise<TierResolution> {
  const rules = await db
    .query("pricing_tier_rules")
    .withIndex("by_make_key", (q) => q.eq("make_key", makeKeyOf(ctx.make)))
    .collect();
  return resolveTierWithRules(rules, ctx);
}

/** Resolve from a vehicle_configs doc — reads its make/model names. Returns
 *  null tier when the make/model rows are missing (can't classify). */
export async function resolveTierForConfig(
  db: DatabaseReader,
  cfg: Doc<"vehicle_configs">,
): Promise<TierResolution> {
  const [make, model] = await Promise.all([db.get(cfg.make_id), db.get(cfg.model_id)]);
  if (!make || !model) return { tier: null, source: null };
  return resolveTierForVehicle(db, {
    make: (make as { name?: string }).name ?? "",
    model: (model as { name?: string }).name ?? "",
    trim: cfg.trim_name ?? "",
    year: cfg.year,
  });
}
