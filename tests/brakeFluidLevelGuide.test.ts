import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Brake fluid level guide", () => {
  it("keeps the five-level guide attached to its inspection field and responsive dialog", () => {
    const source = readFileSync("components/multi-point-inspection-dialog.tsx", "utf8");

    expect(source).toContain('field.key === "bf_level"');
    expect(source).toContain("BrakeFluidLevelGuide");
    expect(source).toContain("/brake-fluid-diagram-3.png");
    expect(source).toContain("bg-muted/30 p-1");
    expect(source).toContain("w-[26rem]");
    expect(source).toContain("shrink-0 p-1 text-muted-foreground");
    expect(source).toContain('outerClassName="2xl:hidden"');
  });
});
