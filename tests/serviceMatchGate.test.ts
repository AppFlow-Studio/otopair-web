/**
 * The custom-job match gate (Off-Catalog Work spec, §2 Leak 2).
 *
 * The failure this guards against: a mechanic can't find "Transmission Fluid
 * Exchange" in the picker and types it as a custom job. Custom work can never
 * write a maintenance anchor, so the driver's health score keeps decaying and
 * we eventually remind them to redo a service they already paid for.
 *
 * Two directions matter, and they are not symmetric:
 *
 *   A miss  (real service scored "none")  → the harm above, silently, for months.
 *   A false (custom work scored "high")   → one wrong pre-selection the mechanic
 *                                           taps past.
 *
 * So these tests are strict about never missing, and only moderately strict
 * about not over-matching.
 */
import { describe, test, expect } from "vitest";
import {
  matchServiceName,
  serviceMatchKey,
  serviceTokens,
  tokenSimilarity,
  normalizeServiceName,
  type MatchCandidateInput,
} from "../convex/lib/serviceMatch";

// A slice of the real catalog, names and slugs as they appear in `services`.
const CATALOG: MatchCandidateInput[] = [
  { serviceId: "s1", name: "Oil Change", slug: "oil_change" },
  { serviceId: "s2", name: "Brake Pad Replacement", slug: "brake_pad_replacement" },
  { serviceId: "s3", name: "Transmission Service", slug: "transmission_service" },
  { serviceId: "s4", name: "Coolant Flush", slug: "coolant_flush" },
  { serviceId: "s5", name: "Brake Fluid Flush", slug: "brake_fluid_flush" },
  { serviceId: "s6", name: "Tire Rotation", slug: "tire_rotation" },
  { serviceId: "s7", name: "Fuel System Cleaning", slug: "fuel_system_cleaning" },
  { serviceId: "s8", name: "Spark Plugs", slug: "spark_plugs" },
];

describe("normalisers stay separate", () => {
  test("normalizeServiceName is unchanged from what wrote pending_service_submissions", () => {
    // Frozen by compatibility: lowercase, trim, collapse whitespace. Nothing
    // else. If this test fails, existing normalized_name rows are orphaned.
    expect(normalizeServiceName("  Carbon   Cleaning  ")).toBe("carbon cleaning");
    expect(normalizeServiceName("Brake-Pad Replacement")).toBe(
      "brake-pad replacement",
    );
  });

  test("serviceMatchKey is order- and punctuation-insensitive", () => {
    expect(serviceMatchKey("Replace Brake Pads")).toBe(
      serviceMatchKey("Brake Pad Replacement"),
    );
    expect(serviceMatchKey("Brake-Pad (Front)")).toBe(
      serviceMatchKey("front brake pads"),
    );
  });

  test("noise words drop out but an all-noise name keeps something", () => {
    expect(serviceTokens("Oil Change Service")).toEqual(["oil", "change"]);
    // Every token is noise — must not collapse to "", which would match every
    // other all-noise string exactly.
    expect(serviceTokens("the service job").length).toBeGreaterThan(0);
  });
});

describe("token similarity", () => {
  test("shop shorthand still overlaps via the prefix rule", () => {
    expect(
      tokenSimilarity(serviceTokens("trans fluid"), serviceTokens("Transmission")),
    ).toBeGreaterThan(0);
  });

  test("a repeated token cannot inflate the overlap", () => {
    const score = tokenSimilarity(
      ["brake", "brake", "brake"],
      ["brake", "pad"],
    );
    // Set-deduped to {brake} vs {brake, pad} → 2*1/(1+2).
    expect(score).toBeCloseTo(2 / 3, 5);
  });

  test("unrelated names score near zero", () => {
    expect(
      tokenSimilarity(serviceTokens("Windshield Tint"), serviceTokens("Oil Change")),
    ).toBe(0);
  });
});

describe("exact matches", () => {
  test("the canonical name itself", () => {
    const v = matchServiceName("Oil Change", CATALOG);
    expect(v.confidence).toBe("exact");
    expect(v.best?.serviceId).toBe("s1");
  });

  test("reordered and re-verbed phrasing", () => {
    const v = matchServiceName("Replace Brake Pads", CATALOG);
    expect(v.confidence).toBe("exact");
    expect(v.best?.serviceId).toBe("s2");
  });

  test("the slug, typed verbatim", () => {
    const v = matchServiceName("brake_fluid_flush", CATALOG);
    expect(v.confidence).toBe("exact");
    expect(v.best?.serviceId).toBe("s5");
  });

  test("case and padding are irrelevant", () => {
    const v = matchServiceName("   sPaRk   PLUGS  ", CATALOG);
    expect(v.confidence).toBe("exact");
    expect(v.best?.serviceId).toBe("s8");
  });
});

describe("aliases are trusted absolutely", () => {
  const withAlias: MatchCandidateInput[] = [
    ...CATALOG,
    {
      serviceId: "s7",
      name: "Fuel System Cleaning",
      slug: "fuel_system_cleaning",
      aliases: ["carbon clean", "walnut blasting"],
    },
  ];

  test("an alias hit outranks any fuzzy score", () => {
    const v = matchServiceName("Walnut Blasting", withAlias);
    expect(v.confidence).toBe("exact");
    expect(v.best?.serviceId).toBe("s7");
    expect(v.best?.via).toBe("alias");
  });

  test("a name that only matches via alias would otherwise have missed", () => {
    // Proves the alias is doing the work: without it, "carbon clean" is custom.
    const without = matchServiceName("carbon clean", CATALOG);
    expect(without.confidence).toBe("none");
    const withIt = matchServiceName("carbon clean", withAlias);
    expect(withIt.confidence).toBe("exact");
  });
});

describe("the dangerous direction — real services must never score none", () => {
  // Each of these is a real catalog service a mechanic might type by hand.
  // Landing on "none" means a custom job gets created and the driver is
  // quietly penalised, so the bar is: at least ask.
  const mustNotMiss: Array<[string, string]> = [
    ["Transmission Fluid Exchange", "s3"],
    ["trans fluid change", "s3"],
    ["Front Brake Pads", "s2"],
    ["brake pads", "s2"],
    ["Coolant flush and fill", "s4"],
    ["rotate tires", "s6"],
    ["Full Synthetic Oil Change", "s1"],
    ["change the oil", "s1"],
  ];

  for (const [typed, expectedId] of mustNotMiss) {
    test(`"${typed}" is at least asked about`, () => {
      const v = matchServiceName(typed, CATALOG);
      expect(v.confidence).not.toBe("none");
      // The right service has to be reachable, not necessarily ranked first.
      expect(v.candidates.map((c) => c.serviceId)).toContain(expectedId);
    });
  }
});

describe("genuinely custom work stays custom", () => {
  const mustNotAutoSelect = [
    "Carbon cleaning (walnut blast)",
    "Roll fenders",
    "Ceramic coating",
    "Dashcam hardwire install",
    "Underbody rustproofing",
  ];

  for (const typed of mustNotAutoSelect) {
    test(`"${typed}" is never pre-selected`, () => {
      const v = matchServiceName(typed, CATALOG);
      // "medium" is acceptable (it only asks); "high"/"exact" would pre-select
      // a canonical service for work that isn't one.
      expect(["none", "medium"]).toContain(v.confidence);
    });
  }
});

describe("distinct services are not confused with each other", () => {
  test("brake fluid flush does not resolve to brake pads", () => {
    const v = matchServiceName("Brake Fluid Flush", CATALOG);
    expect(v.best?.serviceId).toBe("s5");
  });

  test("coolant flush does not resolve to brake fluid flush", () => {
    const v = matchServiceName("Coolant Flush", CATALOG);
    expect(v.best?.serviceId).toBe("s4");
  });
});

describe("degenerate input", () => {
  test("too short to mean anything", () => {
    expect(matchServiceName("a", CATALOG).confidence).toBe("none");
    expect(matchServiceName("", CATALOG).confidence).toBe("none");
  });

  test("punctuation only", () => {
    expect(matchServiceName("---", CATALOG).confidence).toBe("none");
  });

  test("an empty catalog matches nothing rather than throwing", () => {
    expect(matchServiceName("Oil Change", []).confidence).toBe("none");
  });
});
