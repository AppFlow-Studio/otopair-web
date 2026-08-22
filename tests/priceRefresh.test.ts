import { describe, expect, it } from "vitest";
import { discoveryDeadNow } from "../convex/vehicleEnrichment/priceRefresh";

const H = 60 * 60 * 1000;
const D = 24 * H;

describe("discoveryDeadNow — escalating price-discovery backoff", () => {
  // Aug 20 2026: the heal-tail leg attempts a part seconds after it is
  // written; one transient miss used to inherit the full 7/30-day window and
  // froze pricing (two Nautilus parts with abundant dealer listings). A single
  // failure now suppresses for hours; only a REPEAT failure earns the full
  // per-outcome window.
  const NOW = 1_800_000_000_000;

  it("no stamp → always eligible", () => {
    expect(discoveryDeadNow({}, NOW)).toBe(false);
    expect(discoveryDeadNow({ price_discovery_outcome: "no_listing" }, NOW)).toBe(false);
  });

  it("first strike suppresses for hours, not days", () => {
    const p = {
      price_discovery_outcome: "no_listing",
      price_discovery_at: NOW - 2 * H,
      price_discovery_strikes: 1,
    };
    expect(discoveryDeadNow(p, NOW)).toBe(true);
    expect(discoveryDeadNow({ ...p, price_discovery_at: NOW - 7 * H }, NOW)).toBe(false);
  });

  it("legacy stamps (no strikes column) read as one strike — pre-existing frozen transients melt without a migration", () => {
    const legacy = {
      price_discovery_outcome: "unparsed",
      price_discovery_at: NOW - 7 * H,
    };
    expect(discoveryDeadNow(legacy, NOW)).toBe(false);
    expect(
      discoveryDeadNow({ ...legacy, price_discovery_at: NOW - 1 * H }, NOW),
    ).toBe(true);
  });

  it("repeat failure earns the full no_listing window (default 30d)", () => {
    const p = {
      price_discovery_outcome: "no_listing",
      price_discovery_at: NOW - 20 * D,
      price_discovery_strikes: 2,
    };
    expect(discoveryDeadNow(p, NOW)).toBe(true);
    expect(discoveryDeadNow({ ...p, price_discovery_at: NOW - 31 * D }, NOW)).toBe(false);
  });

  it("repeat unparsed keeps its shorter window (default 7d) — our own parser is fixable", () => {
    const p = {
      price_discovery_outcome: "unparsed",
      price_discovery_at: NOW - 5 * D,
      price_discovery_strikes: 3,
    };
    expect(discoveryDeadNow(p, NOW)).toBe(true);
    expect(discoveryDeadNow({ ...p, price_discovery_at: NOW - 8 * D }, NOW)).toBe(false);
  });

  it("unknown outcome values never suppress", () => {
    expect(
      discoveryDeadNow(
        {
          price_discovery_outcome: "some_future_verdict",
          price_discovery_at: NOW - 1,
          price_discovery_strikes: 5,
        },
        NOW,
      ),
    ).toBe(false);
  });
});
