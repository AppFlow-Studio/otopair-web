/**
 * B-P5 (OTO_HANDOFF.md): mood-enum mismatch — 4 of the 7 tool moods were
 * coerced to "neutral" in the episodic mirror, flattening the emotional
 * signal. mapToolMoodToEpisodic maps the four tool-only moods by valence.
 */
import { describe, test, expect } from "vitest";
import { mapToolMoodToEpisodic } from "../convex/oto/moodMap";

describe("mapToolMoodToEpisodic", () => {
  test("the 3 shared moods pass through unchanged", () => {
    expect(mapToolMoodToEpisodic("curious")).toBe("curious");
    expect(mapToolMoodToEpisodic("frustrated")).toBe("frustrated");
    expect(mapToolMoodToEpisodic("neutral")).toBe("neutral");
  });

  test("the 4 tool-only moods map by valence, NOT all to neutral", () => {
    expect(mapToolMoodToEpisodic("worried")).toBe("concerned");
    expect(mapToolMoodToEpisodic("hyped")).toBe("satisfied");
    expect(mapToolMoodToEpisodic("confused")).toBe("concerned");
    expect(mapToolMoodToEpisodic("calm")).toBe("neutral"); // calm IS neutral
  });

  test("only ONE of the four previously-flattened moods still lands on neutral", () => {
    const flattened = ["calm", "worried", "hyped", "confused"];
    const toNeutral = flattened.filter((m) => mapToolMoodToEpisodic(m) === "neutral");
    expect(toNeutral).toEqual(["calm"]); // worried/hyped/confused now carry signal
  });

  test("episodic-enum members map to themselves", () => {
    for (const m of ["neutral", "curious", "concerned", "frustrated", "satisfied"]) {
      expect(mapToolMoodToEpisodic(m)).toBe(m);
    }
  });

  test("an unrecognized mood returns null (caller logs + falls back)", () => {
    expect(mapToolMoodToEpisodic("furious")).toBeNull();
    expect(mapToolMoodToEpisodic("")).toBeNull();
  });
});
