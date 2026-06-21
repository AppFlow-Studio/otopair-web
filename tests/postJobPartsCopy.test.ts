import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "components", "post-job-survey-dialog.tsx"),
  "utf8",
);

describe("parts step copy", () => {
  test("uses future/present tense for the pre-start parts step", () => {
    expect(source).toContain('"What parts are you using?"');
    expect(source).toContain('"Add each part to be installed. Skip if none."');
    expect(source).toContain('"Confirm parts to use"');
    expect(source).toContain('"This service requires parts — please add at least one part to be installed before submitting."');
    expect(source).not.toContain('"What parts did you use?"');
    expect(source).not.toContain('"Add each part you installed. Skip if none."');
    expect(source).not.toContain('"Confirm parts used"');
  });
});
