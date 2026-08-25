/**
 * convex/lib/combinedLabor.ts — the ONE pure resolver for combined labor.
 *
 * "Combined labor operations": when a booking has multiple services that share
 * teardown/access (brake pads + rotors same axle; tire rotation + brakes both
 * need wheels off; timing belt + coolant flush share the coolant drain), the
 * duplicated labor is charged once — mirroring Mitchell1/ALLDATA and the parts
 * side's `positionless`/`suppressSharedRoles` dedup.
 *
 * PURE (no ctx / no DB) so every naive-sum site — quoteEngine.resolveQuoteSeries,
 * bookings.resolveBookingLaborMinutes, and the create-booking drawer — calls the
 * SAME logic and can never disagree. Rounding to 15 min happens ONCE at each
 * caller AFTER combining, never here.
 *
 * Flag-off (or < 2 services) returns a byte-identical naive sum.
 */

import {
  getServiceLaborSpec,
  OVERLAP_FAMILIES,
  type LaborAccessDomain,
  type OverlapFamilyId,
} from "./serviceLaborReference";
import { normalizeServiceSlug } from "./servicePartsReference";

export type AxlePosition = "front" | "rear" | "both";

export interface CombinedLaborServiceInput {
  serviceId: string;
  slug: string;
  /** Vehicle-resolved standalone hours for this service (already the number
   *  the naive sum would have used). */
  standaloneHours: number;
  /** Axle for per-axle services (brakes). Ignored for others. */
  position?: AxlePosition | null;
  /** Resolver source label; used only to skip deductions between two empirical
   *  numbers (which may already reflect a combined job). */
  source?: string | null;
}

export interface CombinedLaborBreakdown {
  serviceId: string;
  slug: string;
  standaloneHours: number;
  chargedHours: number;
  deductedHours: number;
}

export interface CombinedLaborResult {
  /** Total labor to charge, UNROUNDED. Caller rounds to 15 min once. */
  combinedHours: number;
  perServiceBreakdown: CombinedLaborBreakdown[];
  /** Σ standalone − combined, never negative. */
  savedHours: number;
  /** Human, customer-safe reasons for the deductions that fired. */
  notes: string[];
  /** Which overlap families actually fired (for analytics / flags). */
  firedFamilies: OverlapFamilyId[];
}

export interface CombinedLaborOptions {
  /** Master switch. Anything other than an explicit `true` = naive sum, so a
   *  caller that forgets to thread the director flag gets today's behavior. */
  enabled?: boolean;
  /** Overlap families the director turned off. */
  disabledFamilies?: OverlapFamilyId[];
}

const DOMAIN_FAMILY: Record<LaborAccessDomain, OverlapFamilyId> = {
  wheels_off: "wheels_off",
  brake_corner: "brake_pad_rotor",
  coolant_drain_fill: "cooling_drain",
};

const FAMILY_NOTE: Record<OverlapFamilyId, string> = {
  brake_pad_rotor:
    "Rotors already remove the pads on that axle — pad labor billed once.",
  wheels_off:
    "Wheels come off once for the shared axle — removal labor billed once.",
  tire_rotation_subsumed:
    "New tires make a rotation unnecessary — its labor was dropped.",
  cooling_drain:
    "The coolant is drained once for both jobs — the drain/refill isn't billed twice.",
};

function axlesOf(position: AxlePosition | null | undefined): ("front" | "rear")[] {
  if (position === "front") return ["front"];
  if (position === "rear") return ["rear"];
  return ["front", "rear"]; // "both", null, undefined
}

function isEmpirical(source: string | null | undefined): boolean {
  return typeof source === "string" && source.includes("empirical");
}

function naiveResult(
  services: CombinedLaborServiceInput[],
): CombinedLaborResult {
  return {
    combinedHours: services.reduce((s, x) => s + x.standaloneHours, 0),
    perServiceBreakdown: services.map((x) => ({
      serviceId: x.serviceId,
      slug: x.slug,
      standaloneHours: x.standaloneHours,
      chargedHours: x.standaloneHours,
      deductedHours: 0,
    })),
    savedHours: 0,
    notes: [],
    firedFamilies: [],
  };
}

/** One shareable access instance a service contributes, pinned to a group key. */
interface AccessInstance {
  svcIdx: number;
  domain: LaborAccessDomain;
  key: string; // domain + axle → the dedup bucket
  hours: number;
  charged: boolean; // flipped off when deducted
}

export function resolveCombinedLabor(
  services: CombinedLaborServiceInput[],
  opts: CombinedLaborOptions = {},
): CombinedLaborResult {
  if (opts.enabled !== true || services.length < 2) {
    return naiveResult(services);
  }
  const disabled = new Set(opts.disabledFamilies ?? []);
  const familyEnabled = (f: OverlapFamilyId) => !disabled.has(f);

  // Per-service running state.
  const core: number[] = []; // non-shareable hours, mutated by subsumption
  const instances: AccessInstance[] = [];
  const norm = services.map((s) => normalizeServiceSlug(s.slug));

  services.forEach((svc, i) => {
    const spec = getServiceLaborSpec(svc.slug);
    if (!spec) {
      core[i] = svc.standaloneHours; // all core, inert
      return;
    }
    const fracSum = spec.accessOps.reduce((s, op) => s + op.fraction, 0);
    core[i] = svc.standaloneHours * (1 - fracSum);

    for (const op of spec.accessOps) {
      const opHours = svc.standaloneHours * op.fraction;
      if (op.scope === "global") {
        instances.push({ svcIdx: i, domain: op.domain, key: op.domain, hours: opHours, charged: true });
      } else {
        // per_axle_booked → the service's booked axles; all_axles → both.
        const axles =
          op.scope === "all_axles" ? (["front", "rear"] as const) : axlesOf(svc.position);
        const per = opHours / axles.length;
        for (const axle of axles) {
          instances.push({
            svcIdx: i,
            domain: op.domain,
            key: `${op.domain}:${axle}`,
            hours: per,
            charged: true,
          });
        }
      }
    }
  });

  const fired = new Set<OverlapFamilyId>();

  // ── Domain dedup: within each (domain,axle) bucket, keep the max-hours
  //    instance charged; deduct the rest (family-gated, empirical-skipped). ──
  const byKey = new Map<string, AccessInstance[]>();
  for (const inst of instances) {
    const list = byKey.get(inst.key);
    if (list) list.push(inst);
    else byKey.set(inst.key, [inst]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const family = DOMAIN_FAMILY[group[0].domain];
    if (!familyEnabled(family)) continue;
    // Owner = largest access (keeps the most thorough teardown; stable order).
    let owner = group[0];
    for (const inst of group) if (inst.hours > owner.hours) owner = inst;
    for (const inst of group) {
      if (inst === owner) continue;
      if (isEmpirical(services[inst.svcIdx].source) && isEmpirical(services[owner.svcIdx].source)) {
        continue; // two empirical numbers — don't double-deduct
      }
      inst.charged = false;
      fired.add(family);
    }
  }

  // ── Subsumption: rotor R&R contains the pad R&R on a shared axle → drop the
  //    pad's residual CORE for that axle. ──
  if (familyEnabled("brake_pad_rotor")) {
    const rotors = services
      .map((s, i) => ({ s, i }))
      .filter(({ i }) => norm[i] === "rotor_replacement");
    services.forEach((pad, i) => {
      if (norm[i] !== "brake_pad_replacement") return;
      const padAxles = axlesOf(pad.position);
      let sharedAxles = 0;
      let anyRotorNonEmpirical = false;
      for (const axle of padAxles) {
        const rotorSameAxle = rotors.find(({ s }) => axlesOf(s.position).includes(axle));
        if (rotorSameAxle) {
          sharedAxles += 1;
          if (!isEmpirical(rotorSameAxle.s.source)) anyRotorNonEmpirical = true;
        }
      }
      if (sharedAxles === 0) return;
      // Two empirical numbers already reflect their own jobs — don't subsume.
      if (isEmpirical(pad.source) && !anyRotorNonEmpirical) return;
      core[i] -= core[i] * (sharedAxles / padAxles.length);
      fired.add("brake_pad_rotor");
    });
  }

  // ── Subsumption: new tires make a rotation pointless → charge it 0. ──
  if (familyEnabled("tire_rotation_subsumed")) {
    const replacement = services.find((s, i) => norm[i] === "tire_replacement");
    if (replacement) {
      services.forEach((rot, i) => {
        if (norm[i] !== "tire_rotation") return;
        if (isEmpirical(rot.source) && isEmpirical(replacement.source)) return;
        core[i] = 0;
        for (const inst of instances) if (inst.svcIdx === i) inst.charged = false;
        fired.add("tire_rotation_subsumed");
      });
    }
  }

  // ── Tally ──
  const chargedAccess: number[] = services.map(() => 0);
  for (const inst of instances) if (inst.charged) chargedAccess[inst.svcIdx] += inst.hours;

  const perServiceBreakdown: CombinedLaborBreakdown[] = services.map((svc, i) => {
    const charged = Math.max(0, Math.min(svc.standaloneHours, core[i] + chargedAccess[i]));
    return {
      serviceId: svc.serviceId,
      slug: svc.slug,
      standaloneHours: svc.standaloneHours,
      chargedHours: charged,
      deductedHours: Math.max(0, svc.standaloneHours - charged),
    };
  });

  const totalStandalone = services.reduce((s, x) => s + x.standaloneHours, 0);
  const maxStandalone = services.reduce((m, x) => Math.max(m, x.standaloneHours), 0);
  // A combined job can never cost less than its single largest service alone.
  const combinedHours = Math.max(
    maxStandalone,
    perServiceBreakdown.reduce((s, b) => s + b.chargedHours, 0),
  );
  const savedHours = Math.max(0, totalStandalone - combinedHours);

  const firedFamilies = OVERLAP_FAMILIES.map((f) => f.id).filter((id) => fired.has(id));
  const notes = firedFamilies.map((id) => FAMILY_NOTE[id]);

  return { combinedHours, perServiceBreakdown, savedHours, notes, firedFamilies };
}
