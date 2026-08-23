/**
 * D1 Fix B — a recommendation for work this visit actually did must never
 * reach the customer report.
 *
 * deriveSuggestedRecommendations is a pure function of inspection state, so it
 * emits "Wiper Blade Replacement / soon" off a red `wipe` reading and has no
 * idea the wipers were fitted an hour ago. Abdul hit it twice on Aug 20 — once
 * on wipers, once on a tire he'd already replaced.
 *
 * The 2-hour deferred reveal was built for exactly this ("a problem fixed in
 * the same visit never surfaces a stale recommendation") but only ever deferred
 * the reveal; it never re-checked. These tests pin the re-check, and pin the
 * two cases where suppression must NOT happen.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_PERFORMED_WORK,
  recommendationWasPerformed,
  type PerformedWork,
} from "../convex/lib/performedWork";
import { serviceMatchKey } from "../convex/lib/serviceMatch";

function performed(opts: {
  serviceIds?: string[];
  slugs?: string[];
  names?: string[];
}): PerformedWork {
  return {
    serviceIds: new Set(opts.serviceIds ?? []),
    slugs: new Set(opts.slugs ?? []),
    matchKeys: new Set((opts.names ?? []).map(serviceMatchKey)),
  };
}

describe("recommendationWasPerformed", () => {
  it("suppresses a catalog rec whose service was on the job", () => {
    expect(
      recommendationWasPerformed(
        { recommended_service_id: "svc_tires" },
        performed({ serviceIds: ["svc_tires"] }),
      ),
    ).toBe(true);
  });

  it("keeps a catalog rec for a service this visit did not touch", () => {
    expect(
      recommendationWasPerformed(
        { recommended_service_id: "svc_brakes" },
        performed({ serviceIds: ["svc_tires"] }),
      ),
    ).toBe(false);
  });

  it("suppresses the wiper advisory when a wiper line was completed", () => {
    // The exact session case: freeform rec (no catalog service), matched by
    // name against the off-catalog line the mechanic actually did.
    expect(
      recommendationWasPerformed(
        { freeform_text: "Wiper Blade Replacement" },
        performed({ names: ["Replace wiper blades"] }),
      ),
    ).toBe(true);
  });

  it("clears the oil top-off when the visit changed the oil", () => {
    // Per spec: "an oil change clears the oil top-off. Never recommend both."
    // These two share no useful tokens, so it needs the explicit pairing.
    expect(
      recommendationWasPerformed(
        { freeform_text: "Oil Top-Off" },
        performed({ slugs: ["oil_change"] }),
      ),
    ).toBe(true);
  });

  it("does not clear the oil top-off from an unrelated service", () => {
    expect(
      recommendationWasPerformed(
        { freeform_text: "Oil Top-Off" },
        performed({ slugs: ["tire_replacement"] }),
      ),
    ).toBe(false);
  });

  it("keeps everything when nothing was performed", () => {
    // EMPTY_PERFORMED_WORK is what a cancelled / no-show booking yields. A
    // swallowed finding on a car nobody touched is the dangerous direction.
    expect(
      recommendationWasPerformed(
        { recommended_service_id: "svc_tires" },
        EMPTY_PERFORMED_WORK,
      ),
    ).toBe(false);
    expect(
      recommendationWasPerformed(
        { freeform_text: "Wiper Blade Replacement" },
        EMPTY_PERFORMED_WORK,
      ),
    ).toBe(false);
  });

  it("ignores a blank freeform label rather than matching everything", () => {
    expect(
      recommendationWasPerformed(
        { freeform_text: "   " },
        performed({ names: ["Oil Change"] }),
      ),
    ).toBe(false);
  });
});
