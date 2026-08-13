/**
 * classifySnapshotRow unit tests — pure classifier for the one-time
 * priced_parts_snapshot integrity sweep.
 */
import { describe, it, expect } from "vitest";

import { classifySnapshotRow } from "../convex/snapshotRevalidation";
import type { Id } from "../convex/_generated/dataModel";

const make = (s: string) => s as Id<"makes">;
const ALFA = make("make_alfa");
const FORD = make("make_ford");

function classify(
  overrides: Partial<Parameters<typeof classifySnapshotRow>[0]>,
) {
  return classifySnapshotRow({
    partMakeId: ALFA,
    configMakeId: ALFA,
    oemNumber: "50534635",
    configMakeName: "Alfa Romeo",
    fitmentMechanicVerified: false,
    ...overrides,
  });
}

describe("classifySnapshotRow", () => {
  it("clean own-make row → ok", () => {
    expect(classify({})).toBe("ok");
  });

  it("make-id mismatch → cross_make", () => {
    expect(classify({ partMakeId: FORD })).toBe("cross_make");
  });

  it("own-make-stamped Motorcraft number → foreign_signature", () => {
    expect(classify({ oemNumber: "BXT-65-750" })).toBe("foreign_signature");
  });

  it("mechanic-verified fitment → verified_exempt (beats both detectors)", () => {
    expect(
      classify({ partMakeId: FORD, fitmentMechanicVerified: true }),
    ).toBe("verified_exempt");
    expect(
      classify({ oemNumber: "BXT-65-750", fitmentMechanicVerified: true }),
    ).toBe("verified_exempt");
  });

  it("unresolvable config make → unresolvable (fail-open, never stamped)", () => {
    expect(
      classify({ configMakeId: null, configMakeName: null }),
    ).toBe("unresolvable");
  });

  it("config make name known but id missing → still classifiable via signature", () => {
    // Oldest snapshots may lack part_id; the signature check still works off
    // the make NAME alone.
    expect(
      classify({
        partMakeId: null,
        configMakeId: null,
        configMakeName: "Alfa Romeo",
        oemNumber: "BXT-65-750",
      }),
    ).toBe("foreign_signature");
  });

  it("missing part (null partMakeId) with clean number → ok", () => {
    expect(classify({ partMakeId: null })).toBe("ok");
  });

  it("universal consumable on any config → ok", () => {
    expect(
      classify({ partMakeId: null, oemNumber: "OTOPAIR-UNIV-DOT4" }),
    ).toBe("ok");
  });
});
