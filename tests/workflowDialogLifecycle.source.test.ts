import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const readSource = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("workflow dialog lifecycle", () => {
  test("recreates the MPI dialog body from current booking data after it closes", () => {
    const source = readSource("components/multi-point-inspection-dialog.tsx");

    expect(source).toMatch(/if \(!props\.open\) return null;/);
  });

  test("does not close booking workflows when only the assigned mechanic changes", () => {
    const source = readSource("components/booking-detail-panel.tsx");

    expect(source).toMatch(
      /setShowPrejobDialog\(false\)[\s\S]*?setCopiedField\(null\);[\s\S]*?\}, \[jobId\]\);/,
    );
    expect(source).toMatch(
      /setAssigningMechanicId\(currentAssignmentKey\);[\s\S]*?\}, \[jobId, currentAssignmentKey\]\);/,
    );
  });
});
