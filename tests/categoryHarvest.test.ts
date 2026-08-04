import { describe, expect, it } from "vitest";
import {
  categoriesForRoles,
  candidatesFromCategoryPage,
  extractCategoryLinks,
  extractVehicleSlugPath,
  interchangeCandidates,
  pickVehicleSlug,
} from "../convex/vehicleEnrichment/categoryHarvest";

const SLUG = "/v-2020-mercedes-benz-glc43-amg--4matic--3-0l-v6-gas";
const BASE = `https://classicparts.mbusa.com${SLUG}`;

describe("extractVehicleSlugPath", () => {
  it("pulls the vehicle slug from a category URL", () => {
    expect(extractVehicleSlugPath(`${BASE}/maintenance-and-lubrication--filters`)).toBe(SLUG);
  });
  it("pulls it from the bare vehicle root", () => {
    expect(extractVehicleSlugPath(BASE)).toBe(SLUG);
  });
  it("returns null for detail pages and junk", () => {
    expect(
      extractVehicleSlugPath(
        "https://classicparts.mbusa.com/oem-parts/mercedes-benz-oil-filter-2761800009",
      ),
    ).toBeNull();
    expect(extractVehicleSlugPath(null)).toBeNull();
  });
});

describe("extractCategoryLinks", () => {
  // Shape lifted from the run-1 cached markdown of the GLC-43 vehicle page.
  const markdown = `
## Categories
- [All](https://classicparts.mbusa.com${SLUG})
- [Parts](https://classicparts.mbusa.com${SLUG}/auto-parts)
- [Filters](https://classicparts.mbusa.com${SLUG}/maintenance-and-lubrication--filters)
- [Ignition Coil](https://classicparts.mbusa.com${SLUG}/ignition--ignition-coil)
- [Rear Brakes](https://classicparts.mbusa.com${SLUG}/brakes--rear-brakes)
`;
  it("captures slug, url and label from markdown nav", () => {
    const links = extractCategoryLinks(markdown, SLUG);
    const slugs = links.map((l) => l.slug);
    expect(slugs).toContain("maintenance-and-lubrication--filters");
    expect(slugs).toContain("ignition--ignition-coil");
    expect(slugs).toContain("brakes--rear-brakes");
    const ign = links.find((l) => l.slug === "ignition--ignition-coil")!;
    expect(ign.label).toBe("Ignition Coil");
    expect(ign.url).toBe(`https://classicparts.mbusa.com${SLUG}/ignition--ignition-coil`);
  });
  it("also captures bare hrefs from HTML", () => {
    const html = `<a href="https://classicparts.mbusa.com${SLUG}/cooling-system--radiator">Radiator</a>`;
    const links = extractCategoryLinks(html, SLUG);
    expect(links.map((l) => l.slug)).toContain("cooling-system--radiator");
  });
});

describe("categoriesForRoles", () => {
  const links = [
    { slug: "maintenance-and-lubrication--filters", url: `${BASE}/maintenance-and-lubrication--filters`, label: "Filters" },
    { slug: "ignition--ignition-coil", url: `${BASE}/ignition--ignition-coil`, label: "Ignition Coil" },
    { slug: "brakes--front-brakes", url: `${BASE}/brakes--front-brakes`, label: "Front Brakes" },
    { slug: "brakes--rear-brakes", url: `${BASE}/brakes--rear-brakes`, label: "Rear Brakes" },
  ];
  it("routes each role to a matching category and groups by page", () => {
    const pages = categoriesForRoles(["spark_plug", "rear_rotor", "rear_brake_pad"], links);
    const bySlug = Object.fromEntries(pages.map((p) => [p.slug, p.roles]));
    expect(bySlug["ignition--ignition-coil"]).toEqual(["spark_plug"]);
    expect(bySlug["brakes--rear-brakes"].sort()).toEqual(["rear_brake_pad", "rear_rotor"]);
  });
  it("never routes a positioned role to the opposite axle's category", () => {
    const pages = categoriesForRoles(["rear_rotor"], [links[2]]); // only front-brakes offered
    expect(pages).toEqual([]);
  });
});

describe("candidatesFromCategoryPage", () => {
  it("harvests role-passing detail links from markdown and format-gates numbers", () => {
    const markdown = `
- [Spark Plug](https://classicparts.mbusa.com/oem-parts/mercedes-benz-spark-plug-2761590000)
- [Ignition Coil](https://classicparts.mbusa.com/oem-parts/mercedes-benz-ignition-coil-2769063700)
`;
    const out = candidatesFromCategoryPage({
      html: null,
      markdown,
      url: `${BASE}/ignition--ignition-coil`,
      make: "Mercedes-Benz",
      roleKeys: ["spark_plug"],
    });
    expect(out).toHaveLength(1);
    expect(out[0].roleKey).toBe("spark_plug");
    expect(out[0].oem.replace(/[^0-9A-Z]/gi, "")).toBe("2761590000");
    expect(out[0].title).toBe("Spark Plug");
  });
  it("drops candidates whose title fails the role lexicon", () => {
    const markdown = `- [Battery Cable](https://classicparts.mbusa.com/oem-parts/mercedes-benz-battery-cable-0009824420)`;
    const out = candidatesFromCategoryPage({
      html: null,
      markdown,
      url: `${BASE}/electrical--battery`,
      make: "Mercedes-Benz",
      roleKeys: ["battery"],
    });
    expect(out).toEqual([]);
  });
});

describe("pickVehicleSlug", () => {
  const GLC43 = "https://classicparts.mbusa.com/v-2020-mercedes-benz-glc43-amg--4matic--3-0l-v6-gas/ignition--ignition-coil";
  const GLC63 = "https://classicparts.mbusa.com/v-2020-mercedes-benz-glc63-amg--4matic--4-0l-v8-gas/brakes--rear-brakes";
  const vehicle = { year: 2020, model: "AMG GLC 43", displacement: "3" };

  it("REJECTS the neighbor vehicle that burned us live (GLC63 for a GLC43)", () => {
    expect(pickVehicleSlug([GLC63], vehicle)).toBeNull();
  });
  it("accepts the exact vehicle", () => {
    expect(pickVehicleSlug([GLC63, GLC43], vehicle)).toBe(
      "/v-2020-mercedes-benz-glc43-amg--4matic--3-0l-v6-gas",
    );
  });
  it("rejects a right-model wrong-displacement slug", () => {
    const wrongDisp = "https://classicparts.mbusa.com/v-2020-mercedes-benz-glc43-amg--4matic--4-0l-v8-gas";
    expect(pickVehicleSlug([wrongDisp], vehicle)).toBeNull();
  });
  it("rejects a wrong-year slug", () => {
    const wrongYear = "https://classicparts.mbusa.com/v-2019-mercedes-benz-glc43-amg--4matic--3-0l-v6-gas";
    expect(pickVehicleSlug([wrongYear], vehicle)).toBeNull();
  });
  it("skips the displacement gate when displacement is unparseable", () => {
    expect(pickVehicleSlug([GLC43], { year: 2020, model: "AMG GLC 43", displacement: null })).toBe(
      "/v-2020-mercedes-benz-glc43-amg--4matic--3-0l-v6-gas",
    );
  });
});

describe("category negative screens", () => {
  it("spark_plug never takes ignition-LOCK even when no better category exists", () => {
    const pages = categoriesForRoles(
      ["spark_plug"],
      [{ slug: "electrical--ignition-lock", url: "u1", label: "Ignition Lock" }],
    );
    expect(pages).toEqual([]);
  });
  it("coolant never takes a belt category", () => {
    const pages = categoriesForRoles(
      ["coolant"],
      [{ slug: "belts-and-cooling--accessory-drive-belt-system-components", url: "u2", label: null }],
    );
    expect(pages).toEqual([]);
  });
});

describe("interchangeCandidates", () => {
  it("keeps same-make-format numbers and drops foreign/blocked ones", () => {
    const out = interchangeCandidates({
      // Honda-format + Subaru-format numbers must die on the Mercedes gate.
      interchange: ["0004204904", "26296AL03A", "45022T0AA01", "0004213000"],
      make: "Mercedes-Benz",
      exclude: new Set(["0004213000"]),
    });
    expect(out.map((n) => n.replace(/[^0-9A-Z]/gi, ""))).toEqual(["0004204904"]);
  });
});
