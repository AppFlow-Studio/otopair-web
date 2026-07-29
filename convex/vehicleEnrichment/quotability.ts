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
