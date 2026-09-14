/**
 * Every make must be able to deterministically scrape every CORE part role.
 *
 * Round 14 regression anchor. Four hand-maintained slug maps had drifted apart:
 * BMW carried 15 slugs, the oempartsonline generic 15, and TOYOTA/HONDA only 10
 * — omitting battery, coolant and engine_oil, all of them CORE roles. A field
 * with no slug is never searched at all: getPartsSearchPlans maps over
 * Object.values(partSlugs), so a missing key produces no plan, no query, no log
 * and no warning. Toyota therefore could not deterministically scrape a
 * battery, and nothing in the system said so.
 *
 * Three core roles (atf_fluid, timing_belt, oil_filter_housing_oring) had no
 * slug in ANY map, so the sole core part of transmission_service and
 * timing_belt could never come from deterministic data on any vehicle of any
 * make.
 *
 * "CORE role needing a lookup" is derived from SERVICE_PARTS_REFERENCE, not
 * hardcoded here, so this test tracks the service catalog: add a service with a
 * new binding core part and this fails until the part is scrapeable.
 */
import { describe, expect, it } from "vitest";
import { SERVICE_PARTS_REFERENCE } from "../convex/lib/servicePartsReference";
import { SOURCE_REGISTRY, getPartsSearchPlans, getSourceConfig } from "../convex/vehicleEnrichment/sourceRegistry";
import { PART_FIELD_MAP } from "../convex/vehicleEnrichment/v3pipeline";

/** roleKey (== oem_parts.subcategory) -> PART_FIELD_MAP field key. */
const FIELD_BY_ROLE: Record<string, string> = Object.fromEntries(
  Object.entries(PART_FIELD_MAP).map(([field, meta]) => [(meta as any).subcategory, field]),
);

/**
 * Core roles that BIND a quote and need a real looked-up number.
 *
 * Excluded, deliberately:
 *  - `if_found_bad` — discovery items a mechanic finds in the bay; unquotable
 *    up front by definition.
 *  - roles with a universalFallback — a synthesised priced consumable already
 *    satisfies quotability, so no lookup is required.
 */
function coreRolesNeedingLookup(): string[] {
  const out = new Set<string>();
  for (const spec of Object.values(SERVICE_PARTS_REFERENCE)) {
    if (spec.laborOnly || spec.handledByDedicatedFlow) continue;
    for (const role of spec.roles) {
      if (role.serviceRole !== "core") continue;
      if (role.condition === "if_found_bad") continue;
      if (role.universalFallback != null) continue;
      out.add(role.roleKey);
    }
  }
  return [...out].sort();
}

const VEHICLE = {
  year: 2020,
  make: "Toyota",
  model: "Camry",
  trim: "LE",
  engineCode: "A25A-FKS",
  displacement: "2.5",
} as any;

describe("core part coverage is a property of the pipeline, not of a make", () => {
  const coreRoles = coreRolesNeedingLookup();

  it("derives a non-trivial set of core roles from the service catalog", () => {
    // Guards the guard: if this ever collapses to nothing, the assertions
    // below would pass vacuously for every make.
    expect(coreRoles.length).toBeGreaterThanOrEqual(10);
    expect(coreRoles).toContain("front_brake_pad");
    expect(coreRoles).toContain("battery");
  });

  it("every core role maps to a known extraction field", () => {
    for (const role of coreRoles) {
      expect(FIELD_BY_ROLE[role], `role "${role}" has no PART_FIELD_MAP entry`).toBeDefined();
    }
  });

  it.each(Object.keys(SOURCE_REGISTRY))(
    "%s can scrape every core role",
    (make) => {
      const config = SOURCE_REGISTRY[make];
      if (!config?.parts?.partSlugs) return; // make has no storefront config at all
      const slugFields = Object.keys(config.parts.partSlugs);
      const missing = coreRoles.filter((r) => !slugFields.includes(FIELD_BY_ROLE[r]));
      expect(missing, `${make} cannot scrape: ${missing.join(", ")}`).toEqual([]);
    },
  );

  it("does not spend a search on a service that cannot be booked", () => {
    // wiper_blade_replacement is data-only / non-bookable, so a wiper part can
    // never be quoted — yet it used to consume one of the ~15 searches and a
    // share of the 40k markdown cap on every vehicle.
    for (const [make, config] of Object.entries(SOURCE_REGISTRY)) {
      const fields = Object.keys(config?.parts?.partSlugs ?? {});
      expect(fields, `${make} still scrapes a wiper`).not.toContain("wiper_blade_set_oem");
      expect(fields, `${make} still scrapes a rear wiper`).not.toContain("wiper_blade_rear_oem");
    }
  });

  it("keeps the search count within the scrape budget's reach", () => {
    // PARTS_SCRAPE_BUDGET_MS (210s) and MAX_MARKDOWN_CHARS (40k) both cut the
    // TAIL of the plan list, so an unbounded map silently truncates the parts
    // that happen to sort last rather than failing loudly.
    for (const [make, config] of Object.entries(SOURCE_REGISTRY)) {
      if (!config?.parts?.partSlugs) continue;
      const plans = getPartsSearchPlans(config, { ...VEHICLE, make });
      expect(plans.length, `${make} plan count`).toBeLessThanOrEqual(18);
    }
  });

  it("orders quote-critical searches ahead of nice-to-haves", () => {
    // The budgets cut the tail, so ordering decides what survives truncation.
    const config = SOURCE_REGISTRY["Toyota"];
    const fields = Object.keys(config.parts.partSlugs);
    const brakeIdx = fields.indexOf("front_brake_pad_oem");
    const engineOilIdx = fields.indexOf("engine_oil_oem");
    expect(brakeIdx).toBeGreaterThanOrEqual(0);
    if (engineOilIdx >= 0) expect(brakeIdx).toBeLessThan(engineOilIdx);
  });
});

describe("getSourceConfig — corporate-family fallback for dead badges", () => {
  // Aug 27 2026, the 2008 Pontiac G6: no registry entry meant zero stores for
  // every store-backed lane, on exactly the cars whose open-web ecosystem is
  // worst. The family's stores genuinely serve these badges.
  it("routes dead GM badges to a GM config with a validated price voice", () => {
    for (const make of ["Pontiac", "Saturn", "Oldsmobile", "Hummer"]) {
      const cfg = getSourceConfig(make);
      expect(cfg).not.toBeNull();
      expect(
        (cfg!.parts.alternates ?? []).some(
          (a) => a.validated && a.capabilities.includes("price"),
        ),
      ).toBe(true);
    }
  });
  it("routes Mercury to the Ford family", () => {
    expect(getSourceConfig("Mercury")).toBe(getSourceConfig("Ford"));
  });
  it("still returns null for makes with no family in the registry", () => {
    expect(getSourceConfig("Peterbilt")).toBeNull();
    expect(getSourceConfig("")).toBeNull();
  });
  it("never shadows an exact entry", () => {
    expect(getSourceConfig("Chevrolet")).not.toBeNull();
    expect(getSourceConfig("Scion")).not.toBe(getSourceConfig("Toyota"));
  });
});
