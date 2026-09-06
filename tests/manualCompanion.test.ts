import { describe, it, expect } from "vitest";
import {
  COMPANION_MIN_SCORE,
  decideCompanion,
  rankCompanionCandidates,
  scoreCompanionCandidate,
} from "../convex/vehicleEnrichment/manualCompanion";

const TARGET = { title: "Warranty and Maintenance Booklet" };
const LEGACY_2021 = { year: 2021, make: "Subaru" };
const LEGACY_2023 = { year: 2023, make: "Subaru" };

// The ACTUAL six results returned for
// '2021 Subaru "Warranty and Maintenance Booklet" pdf' on Aug 18 2026.
// Exactly one of them is the document; five are people discussing it.
const REAL_RESULTS = [
  { url: "https://www.subaruoutback.org/threads/2020-warranty-and-maintenance-booklet.519332/" },
  { url: "https://www.subaruxvforum.com/threads/2021-maintenance-and-warranty-booklet.178887/" },
  { url: "https://www.reddit.com/r/SubaruForester/comments/wacxvf/official_maintenance_schedule_for_the_2021/" },
  { url: "https://www.facebook.com/groups/SubaruAscent/posts/4439112196358264/" },
  { url: "https://www.subaruforester.org/threads/2019-warranty-and-maintenance-booklet-how-to-find-digitally.812518/" },
  { url: "https://techinfo.subaru.com/stis/doc/warrantyBooklet/2023_war_and_maint_060822.PDF" },
];

describe("scoreCompanionCandidate", () => {
  it("ranks the manufacturer's own PDF highly", () => {
    const s = scoreCompanionCandidate(
      { url: "https://techinfo.subaru.com/stis/doc/warrantyBooklet/2023_war_and_maint_060822.PDF" },
      LEGACY_2023,
      TARGET,
    );
    expect(s.score).toBeGreaterThanOrEqual(COMPANION_MIN_SCORE);
    expect(s.reasons.join()).toMatch(/oem_host/);
  });

  it("disqualifies a forum thread named after the booklet", () => {
    // The most common false positive: the thread title matches the deferral
    // title word for word, so title matching alone puts it on top.
    const s = scoreCompanionCandidate(
      { url: "https://www.subaruxvforum.com/threads/2021-maintenance-and-warranty-booklet.178887/" },
      LEGACY_2021,
      TARGET,
    );
    expect(s.score).toBeLessThan(COMPANION_MIN_SCORE);
    expect(s.reasons.join()).toMatch(/discussion_host/);
  });

  it("disqualifies reddit and facebook", () => {
    for (const url of [
      "https://www.reddit.com/r/SubaruForester/comments/wacxvf/official_maintenance_schedule_for_the_2021/",
      "https://www.facebook.com/groups/SubaruAscent/posts/4439112196358264/",
    ]) {
      expect(scoreCompanionCandidate({ url }, LEGACY_2021, TARGET).score).toBeLessThan(
        COMPANION_MIN_SCORE,
      );
    }
  });

  it("flags a year the candidate does not carry", () => {
    const s = scoreCompanionCandidate(
      { url: "https://techinfo.subaru.com/stis/doc/warrantyBooklet/2023_war_and_maint_060822.PDF" },
      LEGACY_2021,
      TARGET,
    );
    expect(s.yearMismatch).toBe(true);
  });
});

describe("rankCompanionCandidates on the real result set", () => {
  it("picks the manufacturer PDF out of six results", () => {
    const ranked = rankCompanionCandidates(REAL_RESULTS, LEGACY_2023, TARGET);
    expect(ranked[0].url).toContain("techinfo.subaru.com");
  });

  it("puts every discussion result below the usable threshold", () => {
    const ranked = rankCompanionCandidates(REAL_RESULTS, LEGACY_2023, TARGET);
    const forums = ranked.filter((r) => !r.url.includes("techinfo.subaru.com"));
    for (const f of forums) expect(f.score, f.url).toBeLessThan(COMPANION_MIN_SCORE);
  });

  it("year-matching always outranks a higher-scoring wrong year", () => {
    const ranked = rankCompanionCandidates(
      [
        { url: "https://techinfo.subaru.com/stis/doc/warrantyBooklet/2023_war_and_maint.PDF" },
        { url: "https://example-dealer.com/2021-subaru-warranty-and-maintenance-booklet.pdf" },
      ],
      LEGACY_2021,
      TARGET,
    );
    // The OEM host scores higher, but it is the wrong model year.
    expect(ranked[0].url).toContain("2021");
  });
});

describe("decideCompanion", () => {
  it("returns the pick when a right-year document is found", () => {
    const v = decideCompanion(rankCompanionCandidates(REAL_RESULTS, LEGACY_2023, TARGET));
    expect(v.status).toBe("candidate");
    if (v.status === "candidate") expect(v.pick.url).toContain("techinfo");
  });

  it("reports year_mismatch rather than none — the document exists", () => {
    // This is the real 2021 Legacy outcome. Saying "nothing found" would be
    // wrong and would hide the actionable fact: the booklet exists, only the
    // wrong edition is published.
    const v = decideCompanion(rankCompanionCandidates(REAL_RESULTS, LEGACY_2021, TARGET));
    expect(v.status).toBe("year_mismatch");
  });

  it("never returns a wrong-year document as a usable pick", () => {
    // A 2023 schedule stamped oem_manual @ 0.95 on a 2021 car is exactly the
    // present-but-wrong failure the pipeline forbids.
    const v = decideCompanion(rankCompanionCandidates(REAL_RESULTS, LEGACY_2021, TARGET));
    expect(v.status).not.toBe("candidate");
  });

  it("handles an empty result set", () => {
    expect(decideCompanion([])).toEqual({ status: "none", reason: "no_results" });
  });
});
