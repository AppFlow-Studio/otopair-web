import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "app/(portal)/dashboard/mechanic-dashboard.tsx"),
  "utf8",
);

function queueSection(start: string, end: string) {
  const section = source.slice(source.indexOf(start), source.indexOf(end));
  expect(section).not.toBe("");
  return section;
}

describe("mechanic dashboard awaiting queue", () => {
  test("does not enqueue in-progress bookings from any job queue source", () => {
    expect(queueSection("// 1) In progress", "// 2) Ready to start")).not.toContain(
      "items.push",
    );
    expect(queueSection("// 3) Diagnostics needing follow-up", "// 4) Completed")).toContain(
      'if (job.status === "in_progress") continue;',
    );
  });
});
