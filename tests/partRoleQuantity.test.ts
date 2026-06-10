// =============================================================================
// partRoleQuantity unit tests — pure quantity + condition resolution for
// Service Parts Reference roles (resolveRoleQuantity / effectiveServiceRole /
// roleApplies). No ctx; we hand-build PartRoleSpecs and VehicleSpecBundles.
//
//   npx vitest run tests/partRoleQuantity.test.ts
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  resolveRoleQuantity,
  effectiveServiceRole,
  roleApplies,
  type VehicleSpecBundle,
} from "../convex/lib/partRoleQuantity";
import {
  SERVICE_PARTS_REFERENCE,
  type PartRoleSpec,
} from "../convex/lib/servicePartsReference";

// Real roles pulled from the canonical reference (keep the tests honest about
// the package sizes / capacity refs actually shipped).
const ENGINE_OIL = SERVICE_PARTS_REFERENCE.oil_change.roles.find((r) => r.roleKey === "engine_oil")!;
const COOLANT = SERVICE_PARTS_REFERENCE.coolant_flush.roles.find((r) => r.roleKey === "coolant")!;
const BRAKE_FLUID = SERVICE_PARTS_REFERENCE.brake_fluid_flush.roles.find(
  (r) => r.roleKey === "brake_fluid",
)!;
const SPARK_PLUG = SERVICE_PARTS_REFERENCE.spark_plugs.roles.find((r) => r.roleKey === "spark_plug")!;
const FRONT_ROTOR = SERVICE_PARTS_REFERENCE.rotor_replacement.roles.find(
  (r) => r.roleKey === "front_rotor",
)!;
const WEAR_SENSOR_FRONT = SERVICE_PARTS_REFERENCE.brake_pad_replacement.roles.find(
  (r) => r.roleKey === "front_brake_wear_sensor",
)!;
const FRICTION_MODIFIER = SERVICE_PARTS_REFERENCE.differential_service.roles.find(
  (r) => r.roleKey === "friction_modifier",
)!;
const TRANS_FILTER = SERVICE_PARTS_REFERENCE.transmission_service.roles.find(
  (r) => r.roleKey === "trans_filter",
)!;

const EMPTY: VehicleSpecBundle = {};

describe("resolveRoleQuantity — fluid roles", () => {
  it("oil 4.5qt @ 1qt bottles → 5, with an auditable capacity basis", () => {
    const r = resolveRoleQuantity(ENGINE_OIL, { engine: { oil_capacity_qts: 4.5 } }, undefined);
    expect(r.quantity).toBe(5);
    expect(r.basis).toBe("capacity:oil_capacity_qts=4.5qt/1qt");
  });

  it("coolant 9qt @ 4qt jugs → 3", () => {
    const r = resolveRoleQuantity(COOLANT, { engine: { coolant_capacity_qts: 9 } }, undefined);
    expect(r.quantity).toBe(3);
  });

  it("brake fluid 33oz @ 32oz bottles → 2", () => {
    const r = resolveRoleQuantity(
      BRAKE_FLUID,
      { config: { brake_fluid_capacity_oz: 33 } },
      undefined,
    );
    expect(r.quantity).toBe(2);
  });

  it("prefers the config (denormalized) capacity over the chassis copy", () => {
    const r = resolveRoleQuantity(
      BRAKE_FLUID,
      { config: { brake_fluid_capacity_oz: 33 }, chassis: { brake_fluid_capacity_oz: 99 } },
      undefined,
    );
    expect(r.quantity).toBe(2); // 33oz path, not 99oz
  });

  it("falls back to the chassis capacity when config is missing", () => {
    const r = resolveRoleQuantity(
      BRAKE_FLUID,
      { config: null, chassis: { brake_fluid_capacity_oz: 33 } },
      undefined,
    );
    expect(r.quantity).toBe(2);
    expect(r.basis).toBe("capacity:brake_fluid_capacity_oz=33oz/32oz");
  });

  it("missing capacity → qty 1 + unknown_capacity basis (never blocks the quote)", () => {
    const r = resolveRoleQuantity(ENGINE_OIL, EMPTY, undefined);
    expect(r.quantity).toBe(1);
    expect(r.basis).toBe("unknown_capacity");
  });

  it("missing capacity honors a stamped fitment quantity (>=1)", () => {
    const r = resolveRoleQuantity(ENGINE_OIL, EMPTY, 6);
    expect(r.quantity).toBe(6);
    expect(r.basis).toBe("unknown_capacity");
  });
});

describe("resolveRoleQuantity — per_cylinder roles", () => {
  it("uses spark_plug_quantity first", () => {
    const r = resolveRoleQuantity(SPARK_PLUG, { engine: { spark_plug_quantity: 6, cylinders: 4 } }, 4);
    expect(r.quantity).toBe(6);
    expect(r.basis).toBe("per_cylinder");
  });

  it("falls to cylinders when plug count is absent", () => {
    const r = resolveRoleQuantity(SPARK_PLUG, { engine: { cylinders: 8 } }, undefined);
    expect(r.quantity).toBe(8);
  });

  it("falls to the fitment quantity when no engine spec is present", () => {
    const r = resolveRoleQuantity(SPARK_PLUG, EMPTY, 4);
    expect(r.quantity).toBe(4);
  });

  it("falls to the default of 4 when nothing is known", () => {
    const r = resolveRoleQuantity(SPARK_PLUG, EMPTY, undefined);
    expect(r.quantity).toBe(4);
  });
});

describe("resolveRoleQuantity — fixed roles", () => {
  it("uses the reference n by default", () => {
    const r = resolveRoleQuantity(FRONT_ROTOR, EMPTY, undefined);
    expect(r.quantity).toBe(2);
    expect(r.basis).toBe("fixed:2");
  });

  it("an enrichment-stamped fitment quantity (!= 1) wins over the fixed default", () => {
    const r = resolveRoleQuantity(FRONT_ROTOR, EMPTY, 2);
    expect(r.quantity).toBe(2);
    expect(r.basis).toBe("fitment");
  });

  it("a fitment quantity of 1 does not override a fixed n", () => {
    const r = resolveRoleQuantity(FRONT_ROTOR, EMPTY, 1);
    expect(r.quantity).toBe(2);
    expect(r.basis).toBe("fixed:2");
  });

  it("a null role falls back to fitment quantity ?? 1", () => {
    expect(resolveRoleQuantity(null, EMPTY, 3)).toEqual({ quantity: 3, basis: "fitment" });
    expect(resolveRoleQuantity(null, EMPTY, undefined)).toEqual({ quantity: 1, basis: "fixed:1" });
  });
});

describe("effectiveServiceRole — conditional core promotion", () => {
  it("promotes a wear sensor as_needed → core when config flag is true", () => {
    expect(WEAR_SENSOR_FRONT.serviceRole).toBe("as_needed");
    expect(
      effectiveServiceRole(WEAR_SENSOR_FRONT, { config: { has_brake_pad_sensor: true } }),
    ).toBe("core");
  });

  it("promotes a wear sensor via the chassis fallback flag", () => {
    expect(
      effectiveServiceRole(WEAR_SENSOR_FRONT, { chassis: { has_brake_pad_sensor: true } }),
    ).toBe("core");
  });

  it("leaves a wear sensor as_needed when the flag is false or missing", () => {
    expect(
      effectiveServiceRole(WEAR_SENSOR_FRONT, { config: { has_brake_pad_sensor: false } }),
    ).toBe("as_needed");
    expect(effectiveServiceRole(WEAR_SENSOR_FRONT, EMPTY)).toBe("as_needed");
  });

  it("promotes the friction modifier → core when LSD additive is required", () => {
    expect(FRICTION_MODIFIER.serviceRole).toBe("as_needed");
    expect(
      effectiveServiceRole(FRICTION_MODIFIER, { drivetrain: { lsd_additive_required: true } }),
    ).toBe("core");
    expect(effectiveServiceRole(FRICTION_MODIFIER, EMPTY)).toBe("as_needed");
  });
});

describe("roleApplies — serviceable_filter gating", () => {
  it("excludes the trans filter only when has_serviceable_filter is positively false", () => {
    expect(roleApplies(TRANS_FILTER, { transmission: { has_serviceable_filter: false } })).toBe(false);
  });

  it("keeps the trans filter (fail-open) when the flag is missing", () => {
    expect(roleApplies(TRANS_FILTER, EMPTY)).toBe(true);
    expect(roleApplies(TRANS_FILTER, { transmission: { has_serviceable_filter: true } })).toBe(true);
  });
});
