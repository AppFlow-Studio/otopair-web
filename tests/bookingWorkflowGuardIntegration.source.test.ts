import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const read = (file: string) =>
  fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("booking workflow guard integration", () => {
  test("guards every active booking workflow host", () => {
    for (const file of [
      "components/booking-detail-panel.tsx",
      "app/(portal)/dashboard/mechanic-dashboard.tsx",
      "app/(portal)/dashboard/page.tsx",
      "components/booking/mid-job-scope-dialog.tsx",
    ]) {
      expect(read(file)).toContain("BookingWorkflowGuard");
    }
  });

  test("offers completed MPI inspection editing from the overflow menu", () => {
    const source = read("components/booking-detail-panel.tsx");

    expect(source).toMatch(
      /if \(canOpenMpi && !mpiGateOpen\) \{[\s\S]*?key: "edit-inspection",[\s\S]*?label: "Edit inspection",[\s\S]*?setShowPrejobDialog\(true\)/,
    );
  });
});
