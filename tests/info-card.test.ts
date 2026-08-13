import { describe, expect, it } from "vitest";
import { sanitizeInfoCard } from "../components/flagship/info-card";

describe("sanitizeInfoCard", () => {
  it("returns null when there is no title", () => {
    expect(sanitizeInfoCard({ layout: "list", items: ["a"] })).toBeNull();
    expect(sanitizeInfoCard({ title: "   ", items: ["a"] })).toBeNull();
    expect(sanitizeInfoCard(null)).toBeNull();
    expect(sanitizeInfoCard("nope")).toBeNull();
    expect(sanitizeInfoCard(42)).toBeNull();
  });

  it("keeps a valid list payload and drops unexpected fields", () => {
    const card = sanitizeInfoCard({
      title: "Warranty",
      summary: "How coverage works",
      layout: "list",
      items: ["12-month parts", "Labor guarantee"],
      footnote: "Terms apply",
      evil: "<script>alert(1)</script>", // unexpected field — ignored
    });
    expect(card).toEqual({
      title: "Warranty",
      summary: "How coverage works",
      layout: "list",
      items: ["12-month parts", "Labor guarantee"],
      rows: undefined,
      stats: undefined,
      pros: undefined,
      cons: undefined,
      footnote: "Terms apply",
    });
    // Confirm the unexpected key didn't leak through.
    expect(card && "evil" in card).toBe(false);
  });

  it("allowlists the layout, falling back to a layout the data supports", () => {
    // Unknown layout + only rows present → coerced to "rows".
    const rowsCard = sanitizeInfoCard({
      title: "Specs",
      layout: "banana",
      rows: [{ label: "Range", value: "300mi" }],
    });
    expect(rowsCard?.layout).toBe("rows");

    // Valid-but-mismatched layout: asked for "stats" but only items exist.
    const listCard = sanitizeInfoCard({
      title: "Steps",
      layout: "stats",
      items: ["one", "two"],
    });
    expect(listCard?.layout).toBe("list");

    // Unknown layout with no data at all → defaults to "list".
    expect(sanitizeInfoCard({ title: "Empty", layout: "xyz" })?.layout).toBe("list");
  });

  it("caps array lengths and string lengths", () => {
    const longItems = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const card = sanitizeInfoCard({
      title: "x".repeat(500),
      layout: "list",
      items: longItems,
    });
    expect(card?.items).toHaveLength(6); // capped at 6
    expect(card?.title.length).toBe(80); // title capped at 80
  });

  it("normalizes whitespace and drops empty/non-string entries", () => {
    const card = sanitizeInfoCard({
      title: "  Many   spaces  here ",
      layout: "list",
      items: ["  good  ", "", null, 123, "   ", "also good"],
    });
    expect(card?.title).toBe("Many spaces here");
    expect(card?.items).toEqual(["good", "also good"]);
  });

  it("validates rows and stats objects, capping stats at 4", () => {
    const card = sanitizeInfoCard({
      title: "Mixed",
      layout: "rows",
      rows: [
        { label: "A", value: "1" },
        { label: "", value: "" }, // dropped (both empty)
        { junk: true }, // becomes empty → dropped
      ],
      stats: Array.from({ length: 9 }, (_, i) => ({ value: `${i}`, label: `s${i}` })),
    });
    expect(card?.rows).toEqual([{ label: "A", value: "1" }]);
    expect(card?.stats).toHaveLength(4);
  });

  it("builds a compare card from pros/cons", () => {
    const card = sanitizeInfoCard({
      title: "Trade-offs",
      layout: "compare",
      pros: ["Fast", "Cheap"],
      cons: ["Loud"],
    });
    expect(card?.layout).toBe("compare");
    expect(card?.pros).toEqual(["Fast", "Cheap"]);
    expect(card?.cons).toEqual(["Loud"]);
  });
});
