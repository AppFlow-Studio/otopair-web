import { describe, it, expect } from "vitest";
import {
  extractBuildId,
  parseJsonLoose,
  olpModelCandidates,
  pickOlpVehicle,
  type OlpVehicleRow,
} from "../convex/vehicleEnrichment/olpLabor";
import modelBrowse from "./fixtures/olp/model-browse-civic.json";

describe("extractBuildId", () => {
  it("finds buildId in script src", () => {
    const html =
      '<script src="/_next/static/9LcCyZqhNWcZKlN9hHFXY/_ssgManifest.js" defer></script>';
    expect(extractBuildId(html)).toBe("9LcCyZqhNWcZKlN9hHFXY");
  });
  it("accepts _buildManifest too", () => {
    const html = '<script src="/_next/static/abc-123_X/_buildManifest.js"></script>';
    expect(extractBuildId(html)).toBe("abc-123_X");
  });
  it("returns null when absent", () => {
    expect(extractBuildId("<html><body>nope</body></html>")).toBeNull();
  });
});

describe("parseJsonLoose", () => {
  it("parses plain JSON", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses JSON wrapped in HTML (Firecrawl rawHtml of a JSON URL)", () => {
    const wrapped = '<html><body><pre>{"pageProps":{"x":2}}</pre></body></html>';
    expect(parseJsonLoose(wrapped)).toEqual({ pageProps: { x: 2 } });
  });
  it("returns null on garbage", () => {
    expect(parseJsonLoose("not json at all")).toBeNull();
  });
});

describe("olpModelCandidates", () => {
  it("orders most specific first and dedupes", () => {
    // OLP nameplates are trim-qualified: civic, civic-si, civic-type-r
    expect(olpModelCandidates("Civic", "Si")).toEqual(["civic-si", "si", "civic"]);
  });
  it("strips xDrive like the RepairPal candidates do", () => {
    expect(olpModelCandidates("5 Series", "M550i xDrive")).toEqual([
      "5-series-m550i-xdrive",
      "m550i-xdrive",
      "m550i",
      "5-series",
    ]);
  });
  it("handles empty trim", () => {
    expect(olpModelCandidates("Jetta", "")).toEqual(["jetta"]);
  });
});

describe("pickOlpVehicle", () => {
  const vehicles = (modelBrowse as any).pageProps.data
    .vehicles as OlpVehicleRow[];

  it("picks the turbo 1.5 over the 2.0 NA for a turbo hint", () => {
    const r = pickOlpVehicle(vehicles, 2018, {
      displacementL: 1.5,
      cylinders: 4,
      turbo: true,
    });
    expect(r?.engineSlug).toBe("1.5l-i4-turbo");
  });
  it("picks the 2.0 NA when displacement says so", () => {
    const r = pickOlpVehicle(vehicles, 2018, {
      displacementL: 2.0,
      cylinders: 4,
      turbo: false,
    });
    expect(r?.engineSlug).toBe("2.0l-i4");
  });
  it("returns the single row when the year has only one engine", () => {
    const r = pickOlpVehicle(vehicles, 2005, {
      displacementL: null,
      cylinders: null,
      turbo: null,
    });
    expect(r?.engineSlug).toBe("1.7l-i4-d17");
  });
  it("returns null for a year OLP does not list", () => {
    expect(
      pickOlpVehicle(vehicles, 1999, { displacementL: 1.6, cylinders: 4, turbo: false }),
    ).toBeNull();
  });
});

import {
  matchJobs,
  OLP_JOB_MAP,
  type OlpLaborJob,
} from "../convex/vehicleEnrichment/olpLabor";
import laborJobs from "./fixtures/olp/labor-jobs-civic.json";

describe("matchJobs", () => {
  const jobs = laborJobs as OlpLaborJob[];
  const bySvc = Object.fromEntries(
    matchJobs(jobs).map((m) => [m.service, m]),
  );

  it("covers every LABOR_SERVICE_CONFIG service slug", () => {
    // keep OLP_JOB_MAP keys aligned with convex/services/laborDeterminant.ts
    expect(Object.keys(OLP_JOB_MAP).sort()).toEqual(
      [
        "battery_replacement", "brake_fluid_flush", "brake_pad_replacement",
        "coolant_flush", "differential_service", "filter_replacement",
        "oil_change", "power_steering_flush", "rotor_replacement",
        "spark_plugs", "timing_belt", "transmission_service", "wheel_alignment",
      ].sort(),
    );
  });

  it("matches oil_change to the plain slug when present, falls back to synthetic when plain is absent", () => {
    // fixture has oil-change-synthetic but not oil-change (chain-engine Civic
    // doesn't list the plain slug) — falls back to synthetic 0.3
    expect(bySvc.oil_change.olp_hours).toBe(0.3);
    expect(bySvc.oil_change.olp_jobs[0].slug).toBe("oil-change-synthetic");
  });

  it("matches brake pads front+rear and uses the first for olp_hours", () => {
    expect(bySvc.brake_pad_replacement.olp_hours).toBe(1);
    expect(bySvc.brake_pad_replacement.olp_jobs.map((j) => j.slug)).toEqual([
      "brake-pads-front",
      "brake-pads-rear",
    ]);
  });

  it("matches rotors to the pair rows before the pads+rotors combos", () => {
    expect(bySvc.rotor_replacement.olp_hours).toBe(1.5);
    expect(bySvc.rotor_replacement.olp_jobs.map((j) => j.slug)).toEqual([
      "brake-rotors-front-pair",
      "brake-rotors-rear-pair",
      "brake-pads-rotors-front",
    ]);
  });

  it("matches differential_service to the routine fluid-change job, not the full service", () => {
    // routine diff service = fluid change (0.7h), not the broader 'service' (1.2h)
    expect(bySvc.differential_service.olp_hours).toBe(0.7);
    expect(bySvc.differential_service.olp_jobs[0].slug).toBe("differential-fluid-change");
  });

  it("returns no match for timing_belt on a chain engine", () => {
    // fixture has timing-chain, not timing-belt — correctly unmatched
    expect(bySvc.timing_belt.olp_hours).toBeNull();
    expect(bySvc.timing_belt.olp_jobs).toEqual([]);
  });

  it("flags insane hours and skips them for olp_hours", () => {
    const fake: OlpLaborJob[] = [
      { name: "Wheel Alignment", slug: "wheel-alignment", category: "maintenance", laborHours: 999 },
    ];
    const m = matchJobs(fake).find((x) => x.service === "wheel_alignment")!;
    expect(m.olp_jobs[0].sane).toBe(false);
    expect(m.olp_hours).toBeNull();
  });
});

describe("matchJobs oil_change slug preference", () => {
  it("prefers plain oil-change over synthetic when both are present", () => {
    const jobs: OlpLaborJob[] = [
      { name: "Oil Change - Synthetic", slug: "oil-change-synthetic", category: "maintenance", laborHours: 0.3 },
      { name: "Oil Change", slug: "oil-change", category: "maintenance", laborHours: 0.5 },
    ];
    const m = matchJobs(jobs, OLP_JOB_MAP).find((x) => x.service === "oil_change")!;
    expect(m.olp_hours).toBe(0.5);
    expect(m.olp_jobs[0].slug).toBe("oil-change");
  });
});

describe("matchJobs cylinder-aware spark plugs", () => {
  const jobs: OlpLaborJob[] = [
    { name: "Spark Plugs", slug: "spark-plugs", category: "engine", laborHours: 4.5 },
    { name: "Spark Plugs - V6", slug: "spark-plugs-v6", category: "engine", laborHours: 2.7 },
    { name: "Spark Plugs - V8", slug: "spark-plugs-v8", category: "engine", laborHours: 2.7 },
  ];
  const sp = (hints?: { cylinders?: number | null }) =>
    matchJobs(jobs, OLP_JOB_MAP, hints).find((m) => m.service === "spark_plugs")!;

  it("picks the V8 row for an 8-cylinder engine (not the generic 4.5h)", () => {
    expect(sp({ cylinders: 8 }).olp_hours).toBe(2.7);
    expect(sp({ cylinders: 8 }).olp_jobs[0].slug).toBe("spark-plugs-v8");
  });
  it("picks the V6 row for a 6-cylinder engine", () => {
    expect(sp({ cylinders: 6 }).olp_hours).toBe(2.7);
  });
  it("uses the base row for I4 / unknown cylinders (back-compat)", () => {
    expect(sp({ cylinders: 4 }).olp_hours).toBe(4.5);
    expect(sp().olp_hours).toBe(4.5); // no hints → unchanged
  });
});
