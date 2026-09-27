import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("labels the inspection submission action simply as Submit", () => {
  const source = readFileSync(
    "components/multi-point-inspection-dialog.tsx",
    "utf8",
  );

  expect(source).not.toMatch(/Submit[^\r\n]*Vehicle Health/);
  expect(source).toMatch(
    /onClick=\{\(\) => handleSubmit\("start"\)\}[\s\S]{0,600}?[\r\n]\s*Submit[\r\n]/,
  );
});
