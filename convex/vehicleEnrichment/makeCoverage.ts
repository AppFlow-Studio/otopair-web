/**
 * vehicleEnrichment/makeCoverage.ts — is every make we actually enrich actually
 * configured?
 *
 * WHY THIS EXISTS
 * ---------------
 * Four times now a make has arrived with no registry entry or no part-number
 * pattern, and every time it presented as a HARD VEHICLE rather than as a
 * missing config:
 *
 *   Genesis, Mercedes  `{make}.oempartsonline.com` did not resolve, so both ran
 *                      the weak open-web fallback on every vehicle. The 2020
 *                      AMG GLC 43 finished 3/9 core parts and read as a
 *                      difficult car.
 *   Lincoln, MINI      No SOURCE_REGISTRY entry at all → getSourceConfig returns
 *                      null → the Tier-1 site-scoped SERP and the vehicle-slug
 *                      resolution both silently vanish. The 2021 Nautilus came
 *                      back with SIX roles `never_found` and quotability 0.50;
 *                      the Countryman, 6 fitments and 0.45.
 *   Mitsubishi         Had a storefront but NO part-number pattern, so every
 *                      extracted value fell through to the permissive generic
 *                      check. Its "clean" Outlander run was unchecked, not
 *                      verified.
 *
 * Each was found by hand, one post-mortem at a time. The failure is invisible by
 * construction: a missing config does not raise anything, it just removes a lane
 * and lets the weaker path answer. This module makes it assertable.
 *
 * TWO LEVELS, ON PURPOSE
 * ----------------------
 *   1. A STATIC invariant over the code tables — every make in SOURCE_REGISTRY
 *      has a part-number pattern. Pure, no database, enforced by the unit test
 *      on every run, so a make added to one table and not the other cannot be
 *      committed.
 *   2. A LIVE audit over the makes actually present in a deployment, which is
 *      the only place a make nobody registered can show up (VIN decoders mint
 *      make rows from whatever the NHTSA record says). Run it from
 *      devOnly/makeCoverageAudit.
 *
 * The policy table is what keeps level 2 honest. Without it the audit would
 * report the same handful of exotics and junk rows forever, and a genuinely
 * missing make would sit in the noise — which is the exact failure this file is
 * meant to end. A make is either supported and therefore covered, or it carries
 * a written reason why not. There is no third state.
 */

import { SOURCE_REGISTRY, hasSources } from "./sourceRegistry";
import { hasOemPartPattern } from "./contentSanitization";
import { makeKeyOf } from "../lib/makeKey";

/**
 * What we have decided to do about a make.
 *
 * `supported` is the only disposition that obliges us to have a storefront and
 * a part pattern. The rest are deliberate exclusions, and each carries its
 * reason so the next person does not have to re-derive it.
 */
export type CoverageDisposition =
  | "supported"
  | "no_storefront"
  | "not_serviceable"
  | "data_artifact";

export type MakePolicy = {
  disposition: CoverageDisposition;
  /** Why. Shown in the audit output — a disposition with no reason is a guess. */
  why: string;
};

/**
 * THE TAIL, DECIDED EXPLICITLY (Aug 13 2026).
 *
 * Every make below appeared in a deployment's `makes` table without a registry
 * entry. Rather than leave them as perpetual audit noise or quietly register
 * them and pretend we can quote them, each gets a decision.
 *
 * Only `supported` makes need to be in SOURCE_REGISTRY; the audit checks that
 * and nothing else. Adding a make here is a product decision, not a
 * housekeeping one — which is the point of making it a written table.
 */
export const MAKE_COVERAGE_POLICY: Record<string, MakePolicy> = {
  // ── No OEM parts storefront exists to scrape ──────────────────────────
  // These marques sell parts exclusively through franchised dealers with no
  // public online catalog, so the deterministic storefront lane cannot exist
  // for them at any amount of effort. They are not blocked from enrichment —
  // the open-web path still runs — they simply must not be counted as gaps.
  ferrari: { disposition: "no_storefront", why: "No public OEM parts catalog; dealer-only distribution." },
  astonmartin: { disposition: "no_storefront", why: "No public OEM parts catalog; dealer-only distribution." },
  bugatti: { disposition: "no_storefront", why: "No public OEM parts catalog; ~500 cars/yr, dealer-only." },
  maserati: { disposition: "no_storefront", why: "No public OEM parts catalog; dealer-only distribution." },
  lamborghini: { disposition: "no_storefront", why: "No public OEM parts catalog; dealer-only distribution." },
  rollsroyce: { disposition: "no_storefront", why: "No public OEM parts catalog; dealer-only distribution." },
  bentley: { disposition: "no_storefront", why: "No public OEM parts catalog; dealer-only distribution." },

  // ── Not a vehicle we should be quoting these services for ─────────────
  // A battery-electric car has no oil change, no spark plugs, no timing belt
  // and no transmission fluid, so "missing" core parts are CORRECT for it. It
  // needs its own service set before it belongs in the fleet at all; until then
  // registering a storefront would only produce confidently wrong quotes.
  tesla: { disposition: "not_serviceable", why: "Battery-electric: no oil change, spark plugs, timing belt or ATF. Needs an EV service set before support means anything." },
  rivian: { disposition: "not_serviceable", why: "Battery-electric: the core ICE service set does not apply. Needs an EV service set first." },
  lucid: { disposition: "not_serviceable", why: "Battery-electric: the core ICE service set does not apply. Needs an EV service set first." },
  polestar: { disposition: "not_serviceable", why: "Battery-electric: the core ICE service set does not apply. Needs an EV service set first." },
  // Class-8 trucks and towable RVs are not passenger vehicles; nothing in the
  // bookable service catalog applies to them.
  mack: { disposition: "data_artifact", why: "Class-8 commercial truck. Not a passenger vehicle; no bookable service applies." },
  freightliner: { disposition: "data_artifact", why: "Class-8 commercial truck. Not a passenger vehicle; no bookable service applies." },
  forestriver: { disposition: "data_artifact", why: "Towable RV/trailer manufacturer. A VIN decode of a trailer, not a car." },

  // ── Dead marques ──────────────────────────────────────────────────────
  // Discontinued brands whose vehicles are old enough that no current
  // storefront carries them. Left unsupported rather than deleted: a real
  // 2007 Saturn could legitimately turn up, and it should degrade to the
  // open-web path rather than crash or be silently dropped.
  saturn: { disposition: "data_artifact", why: "Marque discontinued 2010; no live storefront. Degrades to the open-web path." },
  pontiac: { disposition: "data_artifact", why: "Marque discontinued 2010; no live storefront." },
  mercury: { disposition: "data_artifact", why: "Marque discontinued 2011; no live storefront. Ford part formats still apply." },
  oldsmobile: { disposition: "data_artifact", why: "Marque discontinued 2004; no live storefront." },
  hummer: { disposition: "data_artifact", why: "Original marque discontinued 2010. The GMC Hummer EV decodes as GMC." },
};

export type MakeCoverageRow = {
  /** Display name as stored in the makes table. */
  name: string;
  /** How many vehicle_configs point at this make. 0 = registered but unused. */
  configCount: number;
};

export type CoverageSeverity = "ok" | "alarm" | "excluded";

export type MakeCoverageFinding = {
  name: string;
  key: string;
  configCount: number;
  disposition: CoverageDisposition;
  hasRegistry: boolean;
  hasPartPattern: boolean;
  severity: CoverageSeverity;
  note: string;
};

/** The disposition for a make — `supported` unless the policy says otherwise. */
export function dispositionOf(makeName: string): CoverageDisposition {
  return MAKE_COVERAGE_POLICY[makeKeyOf(makeName)]?.disposition ?? "supported";
}

/**
 * Audit a set of makes against the two things a supported make must have.
 *
 * Pure and total, so the same function backs the unit test, the devOnly action
 * and any future dashboard. An UNKNOWN make — one with no registry entry and no
 * policy entry — is an ALARM, not a shrug: that is precisely the state Lincoln
 * and MINI were in while their vehicles were being written off as hard.
 */
export function auditMakeCoverage(rows: readonly MakeCoverageRow[]): {
  findings: MakeCoverageFinding[];
  alarms: MakeCoverageFinding[];
  summary: string;
} {
  const findings: MakeCoverageFinding[] = rows.map((row) => {
    const key = makeKeyOf(row.name);
    const disposition = dispositionOf(row.name);
    // Both spellings: `hasSources` is the function the pipeline itself calls, so
    // asking it is what makes this audit reflect reality rather than a parallel
    // model of it. The key check catches a row whose stored name differs in
    // punctuation from the registry's ("MERCEDES BENZ" vs "Mercedes-Benz").
    const registry = hasSources(row.name) || registryHasKey(key);
    const pattern = hasOemPartPattern(row.name);

    let severity: CoverageSeverity = "ok";
    let note = "";

    if (disposition !== "supported") {
      severity = "excluded";
      note = MAKE_COVERAGE_POLICY[key]?.why ?? "excluded by policy";
      // An excluded make that somehow acquired a registry entry is worth
      // saying out loud — the two statements contradict each other.
      if (registry) note += " [WARNING: has a SOURCE_REGISTRY entry anyway]";
    } else if (!registry && !pattern) {
      severity = "alarm";
      note =
        "UNREGISTERED AND UNVALIDATED — no storefront lane (the Lincoln/MINI failure: " +
        "roles come back never_found and the vehicle reads as hard) and part numbers " +
        "fall through to the permissive generic check. Register it, or give it a policy entry.";
    } else if (!registry) {
      severity = "alarm";
      note =
        "No SOURCE_REGISTRY entry: getSourceConfig returns null, which silently removes " +
        "the site-scoped SERP and the vehicle-slug resolution.";
    } else if (!pattern) {
      severity = "alarm";
      note =
        "No OEM part pattern: extracted numbers fall through to the permissive generic " +
        "check, so hallucinations are not filtered (the Mitsubishi failure).";
    }

    return {
      name: row.name,
      key,
      configCount: row.configCount,
      disposition,
      hasRegistry: registry,
      hasPartPattern: pattern,
      severity,
      note,
    };
  });

  // Loudest first: a make with live configs is actively producing bad quotes,
  // one with none is only a latent gap.
  const alarms = findings
    .filter((f) => f.severity === "alarm")
    .sort((a, b) => b.configCount - a.configCount);

  const ok = findings.filter((f) => f.severity === "ok").length;
  const excluded = findings.filter((f) => f.severity === "excluded").length;
  const affected = alarms.reduce((n, f) => n + f.configCount, 0);

  return {
    findings,
    alarms,
    summary:
      `${findings.length} make(s): ${ok} covered, ${excluded} excluded by policy, ` +
      `${alarms.length} ALARM` +
      (alarms.length ? ` affecting ${affected} vehicle_config(s): ${alarms.map((a) => a.name).join(", ")}` : ""),
  };
}

/**
 * The static invariant: every make we CLAIM to support has a part pattern.
 *
 * Registering a storefront without a pattern is the Mitsubishi shape — the make
 * looks supported, scrapes fine, and validates nothing. Returns the offenders
 * rather than throwing so the test can name them.
 */
export function registryMakesWithoutPattern(): string[] {
  return Object.keys(SOURCE_REGISTRY).filter((make) => !hasOemPartPattern(make));
}

/** Registry membership by IDENTITY KEY rather than display name.
 *
 *  `hasSources` compares lowercased display names, so it cannot answer a
 *  question posed in makeKeyOf form — "alfaromeo" would not match the registry's
 *  "Alfa Romeo" because the space survives lowercasing. Policy keys are all in
 *  makeKeyOf form, so they need this. */
function registryHasKey(key: string): boolean {
  return Object.keys(SOURCE_REGISTRY).some((k) => makeKeyOf(k) === key);
}

/** Policy entries that contradict themselves — an excluded make that is also
 *  registered as a storefront make. Both statements cannot be true. */
export function contradictoryPolicyEntries(): string[] {
  return Object.keys(MAKE_COVERAGE_POLICY).filter(
    (key) => MAKE_COVERAGE_POLICY[key].disposition !== "supported" && registryHasKey(key),
  );
}
