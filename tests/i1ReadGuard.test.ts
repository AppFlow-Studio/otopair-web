/**
 * passesI1ReadGuard unit tests — pure module, no Convex setup needed.
 *
 * The combined read guard: strict make-id check + brand-signature backstop,
 * with mechanic_verified as the only escape hatch. Mirrors the quarantine's
 * policy (verified rows are never quarantined) so the read path can't drop
 * what quarantine deliberately spared.
 */
import { describe, it, expect } from "vitest";

import { passesI1ReadGuard } from "../convex/partSelector";
import type { Id } from "../convex/_generated/dataModel";

const make = (s: string) => s as Id<"makes">;

const ALFA = make("make_alfa");
const FORD = make("make_ford");

function guard(overrides: Partial<Parameters<typeof passesI1ReadGuard>[0]>) {
  return passesI1ReadGuard({
    partMakeId: ALFA,
    configMakeId: ALFA,
    oemPartNumber: "50534635",
    configMakeName: "Alfa Romeo",
    ...overrides,
  });
}

describe("passesI1ReadGuard", () => {
  it("passes an own-make part with a clean number", () => {
    expect(guard({})).toBe(true);
  });

  it("passes a universal consumable (null part make)", () => {
    expect(guard({ partMakeId: null })).toBe(true);
  });

  it("passes when the config make is unknown (can't prove a mismatch)", () => {
    expect(guard({ configMakeId: null, configMakeName: null })).toBe(true);
  });

  it("drops a cross-make part (strict, not family-aware)", () => {
    expect(guard({ partMakeId: FORD })).toBe(false);
  });

  it("drops an own-make-stamped part with a foreign brand signature", () => {
    // Motorcraft battery number stamped with the Alfa's own make_id — the
    // write-time provenance bug the signature backstop exists for.
    expect(guard({ oemPartNumber: "BXT-65-750" })).toBe(false);
  });

  it("mechanic_verified overrides a make-id mismatch", () => {
    expect(guard({ partMakeId: FORD, mechanicVerified: true })).toBe(true);
  });

  it("mechanic_verified overrides a foreign brand signature", () => {
    expect(guard({ oemPartNumber: "BXT-65-750", mechanicVerified: true })).toBe(
      true,
    );
  });

  it("verified + clean still passes (no accidental inversion)", () => {
    expect(guard({ mechanicVerified: true })).toBe(true);
  });

  it("explicit false verification does not exempt", () => {
    expect(guard({ partMakeId: FORD, mechanicVerified: false })).toBe(false);
  });
});
