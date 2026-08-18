/**
 * vehicleEnrichment/quotability.ts — can each applicable service actually be
 * QUOTED from real data?
 *
 * fill_rate counts extraction fields; it read 93% on the Jul 2026 Audi A4 run
 * while the oil change had no engine-oil part and the battery had no price —
 * two headline services were unquotable and nothing surfaced it. Quotability
 * is the parts-side counterpart: for every applicable parts-bearing service in
 * SERVICE_PARTS_REFERENCE, do all its CORE roles have a fitment AND a trusted
 * price?
 *
 * Pure and unit-tested; the pipeline computes it at finalize and persists it
 * on the enrichment_runs row (plus an errors[] entry when pct < 0.8 so weak
 * runs land in the manual review queue without changing status semantics).
 */

import {
  SERVICE_PARTS_REFERENCE,
  type PartRoleSpec,
} from "../lib/servicePartsReference";
import type { FuelClass } from "./variantFingerprint";

/** One fitment row, pre-joined: which service slot it fills and whether at
 *  least one TRUSTED price row exists (poison/non-pooled types excluded —
 *  same standard as getPricedPartCount). */
export interface QuotabilityFitmentInput {
  service_type: string;
  subcategory: string | null;
  has_trusted_price: boolean;
}

export interface ServiceQuotability {
  slug: string;
  core_total: number;
  core_with_fitment: number;
  core_with_price: number;
}

export interface QuotabilityResult {
  /** fully-quotable services / applicable parts-bearing services (1 when none). */
  pct: number;
  services: ServiceQuotability[];
}

/**
 * Roles a FIRST-RUN, catalog-first harvest may fill before Batch 2 has said
 * which services this vehicle can be sold.
 *
 * Membership bar: present on any road vehicle that reaches this pipeline,
 * INDEPENDENT OF POWERTRAIN.
 *
 *   brakes        every car stops. Drum-rear vehicles are removed by
 *                 `na_role_keys` before this set is consulted.
 *   battery       every road vehicle has a 12 V battery, EVs included.
 *   cabin_filter  every modern vehicle with HVAC has one.
 *
 * DELIBERATELY ABSENT: `air_filter`, `oil_filter`, `engine_oil`, `spark_plug`.
 * A powertrain we have not identified yet removes each of them, and assuming
 * them would be guessing applicability — the one thing the in-run harvest is
 * not allowed to do. They keep their heal-time pass, which runs after Batch 2
 * and knows the answer.
 *
 * Lives HERE, in the module that owns role semantics, rather than in
 * categoryHarvest.ts, because v3pipeline schedules that harvest and
 * categoryHarvest statically imports v3pipeline — a constant shared between
 * them has to sit somewhere neither owns, or the import graph closes a loop.
 */
export const EARLY_ROLE_KEYS = [
  "front_brake_pad",
  "rear_brake_pad",
  "front_rotor",
  "rear_rotor",
  "battery",
  "cabin_filter",
] as const;

/**
 * Services to ASSUME applicable while `EARLY_ROLE_KEYS` is being harvested.
 *
 * `filter_replacement` is here even though it bundles the ENGINE air filter,
 * which an EV lacks — safe only because service and ROLE are separate gates:
 * assuming the service makes the cabin filter visible to `missingCoreRoles`,
 * and `EARLY_ROLE_KEYS` is what decides we act on it. Widening this list
 * without widening the role list is always the safe direction; the reverse is
 * not.
 */
export const EARLY_SERVICE_SLUGS = [
  "brake_pad_replacement",
  "rotor_replacement",
  "battery_replacement",
  "filter_replacement",
] as const;

/**
 * Roles that exist only on a vehicle with an INTERNAL COMBUSTION ENGINE, and
 * the services that carry them.
 *
 * These are the four the powertrain-independent set above deliberately omits.
 * They are safe to harvest early the moment the powertrain is known to burn
 * something — which it is: `engines.fuel_type` is populated on 100% of rows
 * (502/502, measured Aug 2026) from the vPIC decode, and that decode lands
 * BEFORE the in-run harvest is scheduled.
 */
const COMBUSTION_ROLE_KEYS = [
  "oil_filter",
  "engine_oil",
  "air_filter",
  "drain_plug_gasket",
  "coolant",
] as const;

const COMBUSTION_SERVICE_SLUGS = ["oil_change", "coolant_flush"] as const;

/**
 * Spark plugs are their own tier because they are the one role a DIESEL
 * removes while keeping everything else in COMBUSTION_ROLE_KEYS.
 *
 * fuelTypeResolver.ts exists largely for this split — "fuel_class is the
 * highest-consequence identity facet: it decides spark-plugs-vs-glow-plugs" —
 * so honouring it here is not a refinement, it is the whole reason that module
 * was written.
 */
const SPARK_ROLE_KEYS = ["spark_plug"] as const;
const SPARK_SERVICE_SLUGS = ["spark_plugs"] as const;

/** What the in-run harvest may assume, given the decoded powertrain. */
export interface EarlyHarvestScope {
  roleKeys: readonly string[];
  serviceSlugs: readonly string[];
  /** For the log line — why this scope and not another. */
  basis: string;
}

/**
 * Widen the in-run, catalog-first harvest as far as the POWERTRAIN allows.
 *
 * The harvest runs while Batch 2 is still polling, so the applicable-service
 * list does not exist yet and something has to stand in for it. The old answer
 * was a fixed powertrain-independent set, which is correct but narrow: it left
 * oil filter, air filter, coolant and spark plugs to be extracted-then-refuted
 * on every gasoline car, which is the majority of the fleet.
 *
 * The better answer is that we are not actually ignorant. `fuel_class` is
 * decoded during Batch 1 and is the exact fact that decides which of those
 * roles exist:
 *
 *   gasoline / flex / hybrid / phev → every role, spark plugs included.
 *     A hybrid is NOT an exception: it carries a full engine and burns fuel,
 *     so it takes oil, filters and plugs like any other. `classifyFuelClass`
 *     reads "Electric / Gasoline" and "Gasoline / Electric" as `hybrid`, which
 *     is why those 17 rows must not be lumped in with the 45 true BEVs.
 *   diesel → every role EXCEPT spark plugs (glow plugs, different part).
 *   bev → the powertrain-independent set only. No oil, no engine air filter,
 *     no plugs. Assuming them here is precisely the wrong-part write the
 *     "never guess applicability" rule forbids.
 *   other (CNG, hydrogen, fuel cell) / unknown → the narrow set. Rare enough
 *     that being conservative costs almost nothing, and varied enough that a
 *     guess would be a real guess.
 *
 * Pure and total: an unreadable fuel type degrades to the narrow set rather
 * than throwing, so a decode miss can only ever cost coverage, never
 * correctness.
 */
export function earlyHarvestScope(
  fuelClass: FuelClass | null | undefined,
): EarlyHarvestScope {
  const base = {
    roleKeys: [...EARLY_ROLE_KEYS] as string[],
    serviceSlugs: [...EARLY_SERVICE_SLUGS] as string[],
  };
  switch (fuelClass) {
    case "gasoline":
    case "flex":
    case "hybrid":
    case "phev":
      return {
        roleKeys: [...base.roleKeys, ...COMBUSTION_ROLE_KEYS, ...SPARK_ROLE_KEYS],
        serviceSlugs: [
          ...base.serviceSlugs,
          ...COMBUSTION_SERVICE_SLUGS,
          ...SPARK_SERVICE_SLUGS,
        ],
        basis: `fuel_class=${fuelClass}:combustion+spark`,
      };
    case "diesel":
      return {
        roleKeys: [...base.roleKeys, ...COMBUSTION_ROLE_KEYS],
        serviceSlugs: [...base.serviceSlugs, ...COMBUSTION_SERVICE_SLUGS],
        basis: "fuel_class=diesel:combustion_no_spark",
      };
    case "bev":
      return { ...base, basis: "fuel_class=bev:powertrain_independent_only" };
    default:
      return {
        ...base,
        basis: `fuel_class=${fuelClass ?? "unknown"}:powertrain_independent_only`,
      };
  }
}

/** Core roles that BIND a quote. if_found_bad roles are pure discovery items
 *  (never auto-priced), so they can't gate quotability. */
function bindingCoreRoles(roles: PartRoleSpec[]): PartRoleSpec[] {
  return roles.filter(
    (r) => r.serviceRole === "core" && r.condition !== "if_found_bad",
  );
}

/** A role that is ABSENT can still be satisfied: where_equipped roles simply
 *  don't exist on this vehicle, and universalFallback roles synthesize a
 *  priced consumable line at resolve time. */
function satisfiedWhenAbsent(role: PartRoleSpec): boolean {
  return role.condition === "where_equipped" || role.universalFallback != null;
}

/** Per binding core role: does a fitment fill it, and is it priced?
 *  `satisfiedAbsent` marks roles with no fitment that still count as covered
 *  (where_equipped / universalFallback) — callers must not treat those as
 *  gaps. Shared iterator for computeQuotability / missingCoreRoles /
 *  axlePairGaps so the three can never disagree on role semantics. */
interface RoleStatus {
  role: PartRoleSpec;
  /** service_type the fitment actually lives under (fitmentService ?? slug). */
  sourceService: string;
  hasFitment: boolean;
  satisfiedAbsent: boolean;
  hasTrustedPrice: boolean;
}

function serviceRoleStatuses(
  fitments: readonly QuotabilityFitmentInput[],
  applicableServiceSlugs: readonly string[],
  naRoleKeys?: ReadonlySet<string>,
): Array<{ slug: string; roles: RoleStatus[] }> {
  const out: Array<{ slug: string; roles: RoleStatus[] }> = [];
  for (const slug of [...new Set(applicableServiceSlugs)].sort()) {
    const spec = SERVICE_PARTS_REFERENCE[slug];
    if (!spec || spec.laborOnly || spec.handledByDedicatedFlow) continue;
    const roles = bindingCoreRoles(spec.roles).filter(
      (r) => !naRoleKeys?.has(r.roleKey),
    );
    if (roles.length === 0) continue;

    const statuses: RoleStatus[] = roles.map((role) => {
      // Roles may borrow fitments from another service's slot (timing belt
      // pulls coolant from coolant_flush) — match on the SOURCE service_type.
      const sourceService = role.fitmentService ?? slug;
      const matches = fitments.filter(
        (f) => f.service_type === sourceService && f.subcategory === role.roleKey,
      );
      return {
        role,
        sourceService,
        hasFitment: matches.length > 0,
        satisfiedAbsent: matches.length === 0 && satisfiedWhenAbsent(role),
        hasTrustedPrice: matches.some((f) => f.has_trusted_price),
      };
    });
    out.push({ slug, roles: statuses });
  }
  return out;
}

export function computeQuotability(
  fitments: readonly QuotabilityFitmentInput[],
  applicableServiceSlugs: readonly string[],
  /** roleKeys (== oem_parts.subcategory) the applicability rules stamped
   *  not_applicable for THIS vehicle (chain engine → "timing_belt"). Such
   *  roles leave the quotability math; a service whose binding core roles are
   *  ALL absent drops from the denominator entirely — before this, a chain
   *  car carried a permanently-0/1 timing_belt service that capped
   *  quotability at ~0.92 (740iA re-run, Jul 11 2026). */
  naRoleKeys?: ReadonlySet<string>,
): QuotabilityResult {
  const services: ServiceQuotability[] = [];
  let fullyQuotable = 0;

  for (const { slug, roles } of serviceRoleStatuses(
    fitments,
    applicableServiceSlugs,
    naRoleKeys,
  )) {
    let withFitment = 0;
    let withPrice = 0;
    for (const s of roles) {
      if (s.hasFitment) {
        withFitment++;
        if (s.hasTrustedPrice) withPrice++;
      } else if (s.satisfiedAbsent) {
        withFitment++;
        withPrice++;
      }
    }

    services.push({
      slug,
      core_total: roles.length,
      core_with_fitment: withFitment,
      core_with_price: withPrice,
    });
    if (withPrice === roles.length) fullyQuotable++;
  }

  return {
    pct: services.length > 0 ? Math.round((fullyQuotable / services.length) * 100) / 100 : 1,
    services,
  };
}

// ─── Round 12: completeness as a first-class, per-role fact ─────────────────
//
// computeQuotability collapses coverage into one fleet fraction with a 0.8
// floor — the 2025 Crosstrek finished "complete" with NO front brake pads or
// rotors (rear-only brake data) because a missing axle costs ~2 of ~11
// services ≈ 0.82. These helpers expose the underlying facts so the pipeline
// can REPAIR (role-targeted re-source) and the completion gate can ENFORCE.

/** A binding core role with no fitment and no satisfied-when-absent excuse. */
export interface MissingCoreRole {
  serviceSlug: string;
  roleKey: string;
  /** service_type a repairing write must land under (fitmentService ?? slug) —
   *  rotor_replacement borrows pads from brake_pad_replacement. */
  fitmentService: string;
}

export function missingCoreRoles(
  fitments: readonly QuotabilityFitmentInput[],
  applicableServiceSlugs: readonly string[],
  naRoleKeys?: ReadonlySet<string>,
): MissingCoreRole[] {
  const out: MissingCoreRole[] = [];
  for (const { slug, roles } of serviceRoleStatuses(
    fitments,
    applicableServiceSlugs,
    naRoleKeys,
  )) {
    for (const s of roles) {
      if (!s.hasFitment && !s.satisfiedAbsent) {
        out.push({ serviceSlug: slug, roleKey: s.role.roleKey, fitmentService: s.sourceService });
      }
    }
  }
  return out;
}

/** Within one service, exactly one side of a front_/rear_ role pair filled —
 *  the half-a-brake-job invariant. Deterministic and threshold-free: this
 *  fires even when quotability stays ≥ 0.8. A side excluded via naRoleKeys
 *  (drum rear → rear_rotor N/A) drops out of the pairing entirely, so
 *  drum-brake vehicles never alarm. */
export interface AxlePairGap {
  serviceSlug: string;
  filledRole: string;
  missingRole: string;
}

export function axlePairGaps(
  fitments: readonly QuotabilityFitmentInput[],
  applicableServiceSlugs: readonly string[],
  naRoleKeys?: ReadonlySet<string>,
): AxlePairGap[] {
  const out: AxlePairGap[] = [];
  for (const { slug, roles } of serviceRoleStatuses(
    fitments,
    applicableServiceSlugs,
    naRoleKeys,
  )) {
    const byKey = new Map(roles.map((s) => [s.role.roleKey, s]));
    for (const s of roles) {
      if (!s.role.roleKey.startsWith("front_")) continue;
      const counterpart = byKey.get(s.role.roleKey.replace(/^front_/, "rear_"));
      if (!counterpart) continue; // rear side N/A or not a binding role here
      const frontFilled = s.hasFitment || s.satisfiedAbsent;
      const rearFilled = counterpart.hasFitment || counterpart.satisfiedAbsent;
      if (frontFilled === rearFilled) continue;
      out.push({
        serviceSlug: slug,
        filledRole: frontFilled ? s.role.roleKey : counterpart.role.roleKey,
        missingRole: frontFilled ? counterpart.role.roleKey : s.role.roleKey,
      });
    }
  }
  return out;
}
