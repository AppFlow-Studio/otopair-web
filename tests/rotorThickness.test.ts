/**
 * The nominal-vs-minimum guard.
 *
 * OEM storefronts publish diameter x NOMINAL ("330x22mm") and almost never the
 * discard minimum. If a nominal reaches the minimum column, classify("rotor")
 * grades healthy rotors as "Below min" and we recommend brake jobs that aren't
 * needed. A null is always preferable to a wrong number here.
 */
import { describe, it, expect } from "vitest";
import {
  classifyThicknessLabel,
  labelSupportsKind,
  parseRotorThickness,
  pickRotorThickness,
} from "../convex/vehicleEnrichment/rotorThickness";

describe("classifyThicknessLabel", () => {
  it("recognises discard/minimum wording", () => {
    for (const label of [
      "Minimum Thickness",
      "minimum thickness",
      "Min. Thickness",
      "Min Thickness",
      "MIN TH",
      "Discard Thickness",
      "Discard at",
      "Wear Limit",
      "Service Limit",
      "Minimum Disc Thickness",
      "Min. Rotor Thickness",
    ]) {
      expect(classifyThicknessLabel(label), label).toBe("discard_min");
    }
  });

  it("recognises machine-to wording, and it outranks a leading 'Minimum'", () => {
    expect(classifyThicknessLabel("Machining Limit")).toBe("machine_to");
    expect(classifyThicknessLabel("Machine to")).toBe("machine_to");
    expect(classifyThicknessLabel("Refinish Thickness")).toBe("machine_to");
    expect(classifyThicknessLabel("Resurface limit")).toBe("machine_to");
    // Contains "Minimum" but is NOT the discard figure.
    expect(classifyThicknessLabel("Minimum Machining Thickness")).toBe("machine_to");
  });

  it("treats an unqualified thickness as NOMINAL — never a minimum", () => {
    expect(classifyThicknessLabel("Thickness")).toBe("nominal");
    expect(classifyThicknessLabel("Disc Thickness")).toBe("nominal");
    expect(classifyThicknessLabel("New Thickness")).toBe("nominal");
    expect(classifyThicknessLabel("Nominal")).toBe("nominal");
  });

  it("returns null for labels that say nothing about thickness", () => {
    expect(classifyThicknessLabel("Diameter")).toBeNull();
    expect(classifyThicknessLabel("Weight")).toBeNull();
    expect(classifyThicknessLabel("")).toBeNull();
    expect(classifyThicknessLabel(null)).toBeNull();
  });
});

describe("labelSupportsKind — the LLM cross-check", () => {
  it("rejects a discard_min claim backed only by a bare 'Thickness' label", () => {
    expect(labelSupportsKind("Thickness", "discard_min")).toBe(false);
    expect(labelSupportsKind("Minimum Thickness", "discard_min")).toBe(true);
  });

  it("rejects a discard_min claim backed by a machining label", () => {
    expect(labelSupportsKind("Machining Limit", "discard_min")).toBe(false);
  });
});

describe("parseRotorThickness — size strings", () => {
  it("'330x22mm' yields nominal 22, never 330 and never a minimum", () => {
    const readings = parseRotorThickness("Front Disc Brake Rotor 330x22mm");
    expect(readings).toHaveLength(1);
    expect(readings[0].kind).toBe("nominal");
    expect(readings[0].valueMm).toBe(22);
    expect(readings.some((r) => r.valueMm === 330)).toBe(false);
    expect(readings.some((r) => r.kind === "discard_min")).toBe(false);
  });

  it("handles spaced and unicode-x forms", () => {
    expect(parseRotorThickness("330 x 22 mm")[0].valueMm).toBe(22);
    expect(parseRotorThickness("400×38mm")[0].valueMm).toBe(38);
  });

  it("ignores AxB text that is not a rotor size", () => {
    // Lug thread spec — diameter far below any rotor.
    expect(parseRotorThickness("Thread 12x1.25")).toEqual([]);
  });
});

describe("parseRotorThickness — labelled values", () => {
  it("reads a labelled minimum", () => {
    const readings = parseRotorThickness("Minimum Thickness: 24.0 mm");
    expect(readings).toEqual([
      {
        kind: "discard_min",
        valueMm: 24,
        observedLabel: "Minimum Thickness",
        observedValueText: "24.0 mm",
      },
    ]);
  });

  it("reads a cast marking", () => {
    const readings = parseRotorThickness("Stamped on the hat: MIN TH 24MM");
    expect(readings[0].kind).toBe("discard_min");
    expect(readings[0].valueMm).toBe(24);
  });

  it("converts inches and preserves the original text verbatim", () => {
    const readings = parseRotorThickness("Min. Thickness 0.945 in");
    expect(readings[0].kind).toBe("discard_min");
    expect(readings[0].valueMm).toBe(24);
    expect(readings[0].observedValueText).toBe("0.945 in");
  });

  it("REFUSES a bare number with no label", () => {
    expect(parseRotorThickness("22 mm")).toEqual([]);
    expect(parseRotorThickness("Weight: 8.2 mm")).toEqual([]);
  });

  it("REFUSES a labelled value with no unit — missing beats guessed", () => {
    expect(parseRotorThickness("Minimum Thickness: 24.0")).toEqual([]);
  });

  it("does not let a label leak across a table cell or newline", () => {
    expect(parseRotorThickness("| Minimum Thickness | 24.0 mm |")[0].kind).toBe(
      "discard_min",
    );
    // The number belongs to "Diameter", not to the minimum on the line above.
    expect(parseRotorThickness("Minimum Thickness\nDiameter 330 mm")).toEqual([]);
  });

  it("classifies a full spec block correctly", () => {
    const readings = parseRotorThickness(
      [
        "Disc Thickness: 26.0 mm",
        "Machining Limit: 24.5 mm",
        "Minimum Thickness: 24.0 mm",
      ].join("\n"),
    );
    expect(readings.map((r) => [r.kind, r.valueMm])).toEqual([
      ["nominal", 26],
      ["machine_to", 24.5],
      ["discard_min", 24],
    ]);
  });
});

describe("pickRotorThickness", () => {
  it("separates the three numbers and keeps the audit trail", () => {
    const pick = pickRotorThickness(
      parseRotorThickness(
        "Thickness 26.0 mm | Machine to 24.5 mm | Discard Thickness 24.0 mm",
      ),
    );
    expect(pick).toEqual({
      discardMinMm: 24,
      nominalMm: 26,
      machineToMm: 24.5,
      observedLabel: "Discard Thickness",
      observedValueText: "24.0 mm",
    });
  });

  it("a nominal-only page yields NO minimum", () => {
    const pick = pickRotorThickness(parseRotorThickness("Rotor 330x22mm"));
    expect(pick.nominalMm).toBe(22);
    expect(pick.discardMinMm).toBeNull();
    expect(pick.observedLabel).toBeNull();
  });

  it("breaks ties toward the smallest minimum and largest nominal", () => {
    const pick = pickRotorThickness(
      parseRotorThickness(
        "Minimum Thickness 24.0 mm; Minimum Thickness 22.0 mm; Thickness 26.0 mm; Thickness 28.0 mm",
      ),
    );
    expect(pick.discardMinMm).toBe(22);
    expect(pick.nominalMm).toBe(28);
  });
});
