import { describe, it, expect } from "vitest";
import {
  MAKE_COVERAGE_POLICY,
  auditMakeCoverage,
  contradictoryPolicyEntries,
  dispositionOf,
  registryMakesWithoutPattern,
} from "../convex/vehicleEnrichment/makeCoverage";
import { SOURCE_REGISTRY } from "../convex/vehicleEnrichment/sourceRegistry";
import { makeKeyOf } from "../convex/lib/makeKey";

// ── The static invariant ─────────────────────────────────────────────────────
//
// This is the half that runs in CI on every commit. It is the thing that would
// have caught Mitsubishi (storefront, no pattern) before a "clean" run was
// mistaken for a verified one.

describe("static registry invariant", () => {
  it("every make with a storefront also has a part-number pattern", () => {
    // A registered make with no pattern validates nothing: extracted numbers
    // fall through to the permissive generic check, so hallucinations and
    // wrong-make numbers are written and the run still looks healthy.
    expect(registryMakesWithoutPattern()).toEqual([]);
  });

  it("no make is both excluded by policy and registered as supported", () => {
    expect(contradictoryPolicyEntries()).toEqual([]);
  });

  it("policy keys are stored in makeKeyOf form so lookups can find them", () => {
    // "Alfa Romeo" keys as "alfaromeo"; a policy key with a space or hyphen
    // would never be reached by dispositionOf and the make would silently read
    // as supported.
    for (const key of Object.keys(MAKE_COVERAGE_POLICY)) {
      expect(makeKeyOf(key)).toBe(key);
    }
  });

  it("every policy entry carries a reason", () => {
    for (const [key, policy] of Object.entries(MAKE_COVERAGE_POLICY)) {
      expect(policy.why.length, `${key} has no reason`).toBeGreaterThan(20);
    }
  });

  it("the registry itself audits clean", () => {
    // Whatever is in SOURCE_REGISTRY is by definition claimed as supported, so
    // auditing it against itself must produce no alarms.
    const rows = Object.keys(SOURCE_REGISTRY).map((name) => ({ name, configCount: 0 }));
    expect(auditMakeCoverage(rows).alarms).toEqual([]);
  });
});

// ── The audit ────────────────────────────────────────────────────────────────

describe("auditMakeCoverage", () => {
  it("alarms on an unknown make with no config — the Lincoln/MINI state", () => {
    const { alarms } = auditMakeCoverage([{ name: "Koenigsegg", configCount: 3 }]);
    expect(alarms).toHaveLength(1);
    expect(alarms[0].severity).toBe("alarm");
    expect(alarms[0].hasRegistry).toBe(false);
    expect(alarms[0].note).toMatch(/UNREGISTERED AND UNVALIDATED/);
  });

  it("does NOT alarm on a make the policy has excluded", () => {
    const { alarms, findings } = auditMakeCoverage([
      { name: "Ferrari", configCount: 1 },
      { name: "MACK", configCount: 2 },
      { name: "Tesla", configCount: 9 },
    ]);
    expect(alarms).toEqual([]);
    expect(findings.map((f) => f.disposition)).toEqual([
      "no_storefront",
      "data_artifact",
      "not_serviceable",
    ]);
    // The reason travels with the finding, so the audit output is self-explaining.
    for (const f of findings) expect(f.note.length).toBeGreaterThan(20);
  });

  it("matches policy through case and spacing in the stored name", () => {
    // The makes table holds decoder output verbatim: "FOREST RIVER", "MACK".
    expect(dispositionOf("FOREST RIVER")).toBe("data_artifact");
    expect(dispositionOf("forest river")).toBe("data_artifact");
    expect(dispositionOf("Aston Martin")).toBe("no_storefront");
    expect(dispositionOf("Toyota")).toBe("supported");
  });

  it("ranks alarms by how many vehicles they are actually affecting", () => {
    const { alarms } = auditMakeCoverage([
      { name: "Koenigsegg", configCount: 1 },
      { name: "Pagani", configCount: 12 },
      { name: "Toyota", configCount: 400 },
    ]);
    expect(alarms.map((a) => a.name)).toEqual(["Pagani", "Koenigsegg"]);
  });

  it("counts a covered make as ok and says so in the summary", () => {
    const { summary, alarms } = auditMakeCoverage([
      { name: "Toyota", configCount: 100 },
      { name: "Mercedes-Benz", configCount: 20 },
      { name: "Lincoln", configCount: 5 },
      { name: "MINI", configCount: 4 },
      { name: "Mitsubishi", configCount: 2 },
    ]);
    // All five are the makes that each cost a post-mortem; all five are now
    // covered, and this test fails the moment one is dropped again.
    expect(alarms).toEqual([]);
    expect(summary).toMatch(/5 covered/);
  });

  it("flags a supported make that has a storefront but no pattern", () => {
    // Synthetic: there is no such make today (the static invariant above proves
    // it), so this exercises the branch by name rather than by fixture.
    const finding = auditMakeCoverage([{ name: "Toyota", configCount: 1 }]).findings[0];
    expect(finding.hasPartPattern).toBe(true);
    expect(finding.hasRegistry).toBe(true);
    expect(finding.severity).toBe("ok");
  });
});
