import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "components/post-job-survey-dialog.tsx"),
  "utf8",
);

describe("PostJobSurveyDialog normal submission", () => {
  test("shows a local error when its parent completion mutation rejects", () => {
    const normalSubmitStart = source.indexOf("await onSubmit({");
    const normalTryStart = source.lastIndexOf("try {", normalSubmitStart);
    const normalSubmitEnd = source.indexOf("async function handleFilesSelected", normalSubmitStart);
    const normalSubmit = source.slice(normalTryStart, normalSubmitEnd);

    expect(normalSubmit).toMatch(/try\s*\{[\s\S]*await onSubmit\([\s\S]*catch[\s\S]*setError/);
  });
});
