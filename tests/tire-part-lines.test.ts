import { describe, expect, it } from "vitest";
import {
  isTirePartRow,
  normalizeTireSize,
  tireLinesFromParts,
  tireLinesFromPrejob,
  tireLinesToPartPayloads,
  type TireLine,
} from "../lib/tire-part-lines";

const line = (over: Partial<TireLine> = {}): TireLine => ({
  position: "front",
  size: "225/45R18",
  brand: "Michelin",
  model: "Pilot Sport 4S",
  perTirePrice: "210",
  quantity: 2,
  ...over,
});

describe("normalizeTireSize", () => {
  it("uppercases, strips spaces, and keeps only digits / R / slash", () => {
    expect(normalizeTireSize("225 / 45 r 18")).toBe("225/45R18");
    expect(normalizeTireSize("P225/45R18")).toBe("225/45R18");
    expect(normalizeTireSize(null)).toBe("");
  });
});

describe("tireLinesToPartPayloads", () => {
  it("emits the TIRE-{size} sentinel and structured tire identity", () => {
    const [p] = tireLinesToPartPayloads([line()], "svc_1");
    expect(p.oem_number).toBe("TIRE-225/45R18");
    expect(p.is_tire).toBe(true);
    expect(p.tire_size).toBe("225/45R18");
    expect(p.tire_brand).toBe("Michelin");
    expect(p.tire_model).toBe("Pilot Sport 4S");
    expect(p.tire_position).toBe("front");
    expect(p.service_id).toBe("svc_1");
    expect(p.part_name).toBe("Tires — Michelin Pilot Sport 4S (x2)");
  });

  it("uses the per-unit convention: cost = per-tire price, quantity = count", () => {
    // cost × quantity must equal the $420 line total; the parts step and
    // createByShop both multiply, so cost stays per-tire.
    const [p] = tireLinesToPartPayloads([line({ perTirePrice: "210", quantity: 2 })]);
    expect(p.cost).toBe(210);
    expect(p.quantity).toBe(2);
    expect((p.cost ?? 0) * (p.quantity ?? 1)).toBe(420);
  });

  it("supports staggered front/rear lines with distinct sizes", () => {
    const payloads = tireLinesToPartPayloads([
      line({ position: "front", size: "225/40R18", quantity: 2 }),
      line({ position: "rear", size: "255/40R18", quantity: 2 }),
    ]);
    expect(payloads).toHaveLength(2);
    expect(payloads[0].oem_number).toBe("TIRE-225/40R18");
    expect(payloads[1].oem_number).toBe("TIRE-255/40R18");
    expect(payloads[1].tire_position).toBe("rear");
  });

  it("leaves cost 0 when the per-tire price is blank (unpriced)", () => {
    const [p] = tireLinesToPartPayloads([line({ perTirePrice: "" })]);
    expect(p.cost).toBe(0);
  });

  it("drops fully-empty lines (no size, brand, or model)", () => {
    const payloads = tireLinesToPartPayloads([
      line({ size: "", brand: "", model: "" }),
    ]);
    expect(payloads).toHaveLength(0);
  });

  it("names a line with no brand/model generically", () => {
    const [p] = tireLinesToPartPayloads([line({ brand: "", model: "", quantity: 4 })]);
    expect(p.part_name).toBe("Tires (x4)");
  });
});

describe("isTirePartRow", () => {
  it("matches the explicit flag and the legacy TIRE- sentinel", () => {
    expect(isTirePartRow({ is_tire: true })).toBe(true);
    expect(isTirePartRow({ oem_number: "TIRE-225/45R18" })).toBe(true);
    expect(isTirePartRow({ oem_number: "tire-225/45r18" })).toBe(true);
    expect(isTirePartRow({ oem_number: "04465-0E010" })).toBe(false);
    expect(isTirePartRow({})).toBe(false);
  });
});

describe("tireLinesFromPrejob", () => {
  it("pre-loads every axle that recorded a size", () => {
    const lines = tireLinesFromPrejob({
      tire_size_front: "225 / 45 R 18",
      tire_size_rear: "255/40R18",
      front: { brand: "michelin", model: "pilot sport 4s" },
      rear: { brand: null, model: null },
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ position: "front", size: "225/45R18", brand: "Michelin" });
    expect(lines[1]).toMatchObject({ position: "rear", size: "255/40R18" });
  });

  it("returns [] when there is no prejob tire data", () => {
    expect(tireLinesFromPrejob(null)).toEqual([]);
    expect(tireLinesFromPrejob({})).toEqual([]);
  });
});

describe("tireLinesFromParts", () => {
  it("round-trips structured tire rows back into editor lines", () => {
    const lines = tireLinesFromParts([
      {
        is_tire: true,
        oem_number: "TIRE-225/45R18",
        tire_size: "225/45R18",
        tire_brand: "Michelin",
        tire_model: "Pilot Sport 4S",
        tire_position: "front",
        cost: 210,
        quantity: 2,
      },
    ]);
    expect(lines).toEqual([
      {
        position: "front",
        size: "225/45R18",
        brand: "Michelin",
        model: "Pilot Sport 4S",
        perTirePrice: "210",
        quantity: 2,
      },
    ]);
  });

  it("parses the size out of the sentinel when tire_size is absent, and accepts a string cost", () => {
    const [l] = tireLinesFromParts([
      { oem_number: "TIRE-255/40R18", cost: "240", quantity: 2 },
    ]);
    expect(l.size).toBe("255/40R18");
    expect(l.perTirePrice).toBe("240");
  });

  it("ignores non-tire rows", () => {
    expect(
      tireLinesFromParts([{ oem_number: "04465-0E010", cost: 60, quantity: 1 }]),
    ).toEqual([]);
  });
});
