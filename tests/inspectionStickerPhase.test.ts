import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("shows inspection sticker fields only during the pre-check phase", () => {
  const source = readFileSync(
    "components/multi-point-inspection-dialog.tsx",
    "utf8",
  );

  expect(source).toContain(
    'activeZone === "FRT" && phase === "pre" ? (',
  );
});
