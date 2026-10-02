import { describe, expect, it } from "vitest";

import { getSkippedOwnerQuestions } from "../lib/owner-profile-questions";

describe("inspection owner-profile questions", () => {
  it("does not ask the mechanic for obsolete generic service-history answers", () => {
    const skippedKeys = getSkippedOwnerQuestions({}).map((question) => question.key);

    expect(skippedKeys).not.toContain("lastServiceWhen");
    expect(skippedKeys).not.toContain("lastServiceWhat");
  });
});
