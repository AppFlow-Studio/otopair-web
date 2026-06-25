import { describe, it, expect } from "vitest";
import { fakeDb } from "./helpers/fakeLaborDb";
import {
  CAMRY_FWD_CONFIG_KEY,
  computeLaborTierFloorHours,
} from "../convex/lib/laborFallback";

const SVC = "svc1";
const CAT = "cat_routine";
const CAMRY = "camry_cfg";

function seed() {
  return fakeDb({
    services: [{ _id: SVC, slug: "oil_change", labor_multiplier_category_id: CAT }],
    pricing_labor_multipliers: [
      { _id: "m1", labor_category_id: CAT, tier: "T2c", multiplier: 1.2 },
    ],
    vehicle_configs: [{ _id: CAMRY, config_key: CAMRY_FWD_CONFIG_KEY }],
    labor_times: [
      { _id: "camry_lt", vehicle_config_id: CAMRY, service_id: SVC, book_hours: 0.5 },
    ],
  });
}

describe("computeLaborTierFloorHours", () => {
  it("returns camry_hours × tier multiplier", async () => {
    const db = seed();
    const h = await computeLaborTierFloorHours({ db } as any, {
      serviceId: SVC, vehicleTier: "T2c",
    });
    expect(h).toBeCloseTo(0.6, 5); // 0.5 × 1.2
  });

  it("returns null when the service has no labor category", async () => {
    const db = fakeDb({ services: [{ _id: SVC, slug: "x" }] });
    const h = await computeLaborTierFloorHours({ db } as any, {
      serviceId: SVC, vehicleTier: "T2c",
    });
    expect(h).toBeNull();
  });

  it("returns null when the Camry baseline is not seeded", async () => {
    const db = fakeDb({
      services: [{ _id: SVC, slug: "oil_change", labor_multiplier_category_id: CAT }],
      pricing_labor_multipliers: [{ _id: "m1", labor_category_id: CAT, tier: "T2c", multiplier: 1.2 }],
    });
    const h = await computeLaborTierFloorHours({ db } as any, {
      serviceId: SVC, vehicleTier: "T2c",
    });
    expect(h).toBeNull();
  });
});
