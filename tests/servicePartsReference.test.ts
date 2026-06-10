// =============================================================================
// servicePartsReference unit tests — invariants over the canonical service→parts
// mapping (SERVICE_PARTS_REFERENCE) + its derived lookups. Pure data, no ctx.
//
//   npx vitest run tests/servicePartsReference.test.ts
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  SERVICE_PARTS_REFERENCE,
  LABOR_ONLY_SLUGS,
  type FluidCapacityRef,
  getServicePartsSpec,
  isLaborOnlyService,
  normalizeServiceSlug,
  roleForSubcategory,
  universalConsumables,
} from "../convex/lib/servicePartsReference";

// The six fluid-capacity refs a fluid-quantity role may point at.
const FLUID_CAPACITY_REFS: ReadonlySet<FluidCapacityRef> = new Set([
  "oil_capacity_qts",
  "coolant_capacity_qts",
  "fluid_capacity_drain_fill_qts",
  "brake_fluid_capacity_oz",
  "ps_fluid_capacity_oz",
  "diff_fluid_capacity_qts",
]);

const EXPECTED_LABOR_ONLY = [
  "diagnostic_scan",
  "pre_purchase_inspection",
  "check_engine_light",
  "state_inspection",
  "emissions_test",
  "tire_rotation",
  "wheel_alignment",
  "battery_test",
];

const allSpecs = Object.values(SERVICE_PARTS_REFERENCE);

describe("SERVICE_PARTS_REFERENCE — shape & counts", () => {
  it("has exactly 23 services, each keyed by its own slug", () => {
    expect(allSpecs).toHaveLength(23);
    for (const [key, spec] of Object.entries(SERVICE_PARTS_REFERENCE)) {
      expect(spec.slug).toBe(key);
    }
  });

  it("has exactly 8 labor-only services, and they are the expected slugs", () => {
    const laborOnly = allSpecs.filter((s) => s.laborOnly).map((s) => s.slug);
    expect(laborOnly).toHaveLength(8);
    expect(new Set(laborOnly)).toEqual(new Set(EXPECTED_LABOR_ONLY));
    expect(LABOR_ONLY_SLUGS).toEqual(new Set(EXPECTED_LABOR_ONLY));
  });

  it("labor-only specs carry zero roles", () => {
    for (const spec of allSpecs.filter((s) => s.laborOnly)) {
      expect(spec.roles).toHaveLength(0);
    }
  });
});

describe("SERVICE_PARTS_REFERENCE — parts-bearing role invariants", () => {
  it("every parts-bearing service (except tire_replacement) has >=1 role and >=1 primary", () => {
    for (const spec of allSpecs) {
      if (spec.laborOnly) continue;
      if (spec.slug === "tire_replacement") continue;
      expect(spec.roles.length).toBeGreaterThanOrEqual(1);
      expect(spec.roles.some((r) => r.primary === true)).toBe(true);
    }
  });

  it("tire_replacement is handled by a dedicated flow with zero roles", () => {
    const spec = SERVICE_PARTS_REFERENCE.tire_replacement;
    expect(spec.laborOnly).toBe(false);
    expect(spec.handledByDedicatedFlow).toBe(true);
    expect(spec.roles).toHaveLength(0);
  });

  it("roleKeys are unique within each service", () => {
    for (const spec of allSpecs) {
      const keys = spec.roles.map((r) => r.roleKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("every fluid role has a valid capacity ref and a positive packageSize", () => {
    for (const spec of allSpecs) {
      for (const role of spec.roles) {
        if (role.quantity.kind !== "fluid") continue;
        expect(FLUID_CAPACITY_REFS.has(role.quantity.capacity)).toBe(true);
        expect(role.quantity.packageSize).toBeGreaterThan(0);
      }
    }
  });

  it("every role with a universalFallback has a positive default price", () => {
    for (const spec of allSpecs) {
      for (const role of spec.roles) {
        if (!role.universalFallback) continue;
        expect(role.universalFallback.defaultPriceUsd).toBeGreaterThan(0);
      }
    }
  });
});

describe("normalizeServiceSlug / getServicePartsSpec / isLaborOnlyService", () => {
  it("normalizes dash / underscore / case to the underscore key", () => {
    expect(normalizeServiceSlug("brake-pad-replacement")).toBe("brake_pad_replacement");
    expect(normalizeServiceSlug("Brake_Pad_Replacement")).toBe("brake_pad_replacement");
    expect(normalizeServiceSlug("OIL-CHANGE")).toBe("oil_change");
  });

  it("resolves a spec from its dash alias", () => {
    expect(getServicePartsSpec("brake-pad-replacement")?.slug).toBe("brake_pad_replacement");
    expect(getServicePartsSpec("oil_change")?.slug).toBe("oil_change");
    expect(getServicePartsSpec("not_a_service")).toBeNull();
  });

  it("flags labor-only services across slug forms", () => {
    expect(isLaborOnlyService("tire-rotation")).toBe(true);
    expect(isLaborOnlyService("tire_rotation")).toBe(true);
    expect(isLaborOnlyService("oil_change")).toBe(false);
  });
});

describe("roleForSubcategory", () => {
  it("matches by subcategory within the service", () => {
    expect(roleForSubcategory("oil_change", "oil_filter")?.roleKey).toBe("oil_filter");
    expect(roleForSubcategory("oil_change", "oil_filter")?.serviceRole).toBe("core");
    expect(roleForSubcategory("oil_change", "engine_oil")?.primary).toBe(true);
  });

  it("resolves a borrowed-fitment role with its fitmentService", () => {
    const role = roleForSubcategory("rotor_replacement", "front_brake_pad");
    expect(role?.roleKey).toBe("front_brake_pad");
    expect(role?.serviceRole).toBe("core");
    expect(role?.fitmentService).toBe("brake_pad_replacement");
  });

  it("falls back to category when exactly one role maps to it", () => {
    // "fluid" maps to many roleKeys, but only engine_oil lives in oil_change.
    expect(roleForSubcategory("oil_change", null, "fluid")?.roleKey).toBe("engine_oil");
  });

  it("returns null when a category maps ambiguously within the service", () => {
    // "brake" → 6 roleKeys, all present in brake_pad_replacement → ambiguous.
    expect(roleForSubcategory("brake_pad_replacement", null, "brake")).toBeNull();
  });

  it("returns null for an unknown service or with no resolvable hint", () => {
    expect(roleForSubcategory("not_a_service", "oil_filter")).toBeNull();
    expect(roleForSubcategory("oil_change", null, null)).toBeNull();
  });
});

describe("universalConsumables", () => {
  it("returns unique roleKeys with positive prices, covering the seeded consumables", () => {
    const consumables = universalConsumables();
    const keys = consumables.map((c) => c.roleKey);
    expect(new Set(keys).size).toBe(keys.length);

    for (const c of consumables) {
      expect(c.defaultPriceUsd).toBeGreaterThan(0);
    }

    const keySet = new Set(keys);
    for (const expected of [
      "caliper_grease",
      "drain_plug_gasket",
      "brake_fluid",
      "gear_oil",
      "wheel_weights",
      "fuel_system_cleaner",
    ]) {
      expect(keySet.has(expected)).toBe(true);
    }
  });
});

describe("SERVICE_PARTS_REFERENCE — specific reference rules", () => {
  it("spark_plugs carries an as_needed ignition_coil", () => {
    const coil = SERVICE_PARTS_REFERENCE.spark_plugs.roles.find((r) => r.roleKey === "ignition_coil");
    expect(coil?.serviceRole).toBe("as_needed");
  });

  it("differential_service friction_modifier is gated on lsd_additive_required", () => {
    const fm = SERVICE_PARTS_REFERENCE.differential_service.roles.find(
      (r) => r.roleKey === "friction_modifier",
    );
    expect(fm?.condition).toBe("lsd_additive_required");
  });

  it("brake-pad wear sensors are conditioned on has_brake_pad_sensor", () => {
    const sensors = SERVICE_PARTS_REFERENCE.brake_pad_replacement.roles.filter((r) =>
      r.roleKey.endsWith("brake_wear_sensor"),
    );
    expect(sensors).toHaveLength(2);
    for (const s of sensors) {
      expect(s.condition).toBe("has_brake_pad_sensor");
    }
  });

  it("oil_change drain_plug_gasket is conditioned where_equipped", () => {
    const gasket = SERVICE_PARTS_REFERENCE.oil_change.roles.find(
      (r) => r.roleKey === "drain_plug_gasket",
    );
    expect(gasket?.condition).toBe("where_equipped");
  });
});
