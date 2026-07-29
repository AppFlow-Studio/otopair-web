/**
 * getPartsSearchPlans after the round-12 position split — front and rear
 * brake searches must be DISTINCT plans (the old combined "brake_pads" slug
 * deduped both axles into one search: the Crosstrek shipped rear-only brake
 * data), rotors must be searched for every registry make (previously
 * BMW-only), and same-page slugs (battery/battery_group) must still dedupe.
 */
import { describe, expect, it } from "vitest";
import {
  getPartsSearchPlans,
  getSourceConfig,
} from "../convex/vehicleEnrichment/sourceRegistry";

const crosstrek = {
  year: 2025,
  make: "Subaru",
  model: "Crosstrek",
  trim: "Limited",
  engineCode: "FB25D",
  displacement: "2.5",
} as any;

describe("getPartsSearchPlans — position-split brake slugs", () => {
  it("Subaru (OLP map): distinct front/rear pad AND rotor searches, battery deduped", () => {
    const config = getSourceConfig("Subaru")!;
    const plans = getPartsSearchPlans(config, crosstrek);
    const slugs = plans.map((p) => p.partSlug);

    expect(slugs).toContain("front_brake_pads");
    expect(slugs).toContain("rear_brake_pads");
    expect(slugs).toContain("front_brake_rotor");
    expect(slugs).toContain("rear_brake_rotor");
    expect(slugs).not.toContain("brake_pads"); // combined slug retired
    // battery_group + battery_oem still collapse into ONE battery search.
    expect(slugs.filter((s) => s === "battery")).toHaveLength(1);
    // No duplicate plans at all (unique-slug invariant).
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("queries carry the position words the SERP needs", () => {
    const config = getSourceConfig("Subaru")!;
    const plans = getPartsSearchPlans(config, crosstrek);
    const q = (slug: string) => plans.find((p) => p.partSlug === slug)!.query;
    expect(q("front_brake_pads")).toBe("2025 Crosstrek front brake pads");
    expect(q("rear_brake_rotor")).toBe("2025 Crosstrek rear brake rotor");
  });

  it("axle-critical searches sit ahead of tail consumables (budget cuts the tail)", () => {
    const config = getSourceConfig("Chevrolet")!;
    const slugs = getPartsSearchPlans(config, {
      ...crosstrek,
      make: "Chevrolet",
      model: "Equinox",
    }).map((p) => p.partSlug);
    expect(slugs.indexOf("rear_brake_rotor")).toBeLessThan(slugs.indexOf("wiper_blade"));
    expect(slugs.indexOf("battery")).toBeLessThan(slugs.indexOf("wiper_blade"));
  });

  it("Toyota/Honda/BMW maps are position-split too (rotors no longer BMW-only)", () => {
    for (const make of ["Toyota", "Honda"]) {
      const slugs = getPartsSearchPlans(getSourceConfig(make)!, crosstrek).map((p) => p.partSlug);
      expect(slugs, make).toContain("front_brake_rotor");
      expect(slugs, make).toContain("rear_brake_pads");
    }
    const bmwSlugs = getPartsSearchPlans(getSourceConfig("BMW")!, crosstrek).map((p) => p.partSlug);
    expect(bmwSlugs).toContain("front_brake_disc");
    expect(bmwSlugs).toContain("rear_brake_disc");
    expect(bmwSlugs).not.toContain("brake_disc");
  });
});
