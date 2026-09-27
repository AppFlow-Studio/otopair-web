import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("names the pre-check and MPI phases in the inspection dialog title", () => {
  const source = readFileSync(
    "components/multi-point-inspection-dialog.tsx",
    "utf8",
  );

  expect(source).toContain(
    'title={phase === "pre" ? "Vehicle pre-check" : "Multi-point inspection"}',
  );
});
