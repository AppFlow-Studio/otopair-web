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

  for (const slug of [...new Set(applicableServiceSlugs)].sort()) {
    const spec = SERVICE_PARTS_REFERENCE[slug];
    if (!spec || spec.laborOnly || spec.handledByDedicatedFlow) continue;
    const roles = bindingCoreRoles(spec.roles).filter(
      (r) => !naRoleKeys?.has(r.roleKey),
    );
    if (roles.length === 0) continue;

    let withFitment = 0;
    let withPrice = 0;
    for (const role of roles) {
      // Roles may borrow fitments from another service's slot (timing belt
      // pulls coolant from coolant_flush) — match on the SOURCE service_type.
      const sourceService = role.fitmentService ?? slug;
      const matches = fitments.filter(
        (f) => f.service_type === sourceService && f.subcategory === role.roleKey,
      );
      if (matches.length === 0) {
        if (satisfiedWhenAbsent(role)) {
          withFitment++;
          withPrice++;
        }
        continue;
      }
      withFitment++;
      if (matches.some((f) => f.has_trusted_price)) withPrice++;
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
