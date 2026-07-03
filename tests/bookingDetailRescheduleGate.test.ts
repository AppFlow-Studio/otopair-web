import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "components", "booking-detail-panel.tsx"),
  "utf8",
);

describe("booking detail reschedule action gate", () => {
  test("hides normal reschedule once a job is in progress", () => {
    const canRescheduleBlock = source.match(
      /const canReschedule =[\s\S]*?;\r?\n\s*const canAdjustMidJob/,
    )?.[0];

    expect(canRescheduleBlock).toBeTruthy();
    expect(canRescheduleBlock).toContain('s === "vehicle_at_shop"');
    expect(canRescheduleBlock).not.toContain('s === "in_progress"');
  });
});
