import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "components/booking/booking-workflow-guard.tsx"),
  "utf8",
);

describe("BookingWorkflowGuard", () => {
  test("replaces an unavailable workflow with acknowledgement-only dialog", () => {
    expect(source).toContain("getBookingWorkflowUnavailableNotice");
    expect(source).toContain('enableShortcuts={false}');
    expect(source).toContain('zIndexClassName="z-[80]"');
    expect(source).toContain('label: "Acknowledge"');
  });

  test("keeps an unavailable acknowledgement visible until it is acknowledged", () => {
    expect(source).toContain("const latchedNotice = useRef<string | null>(null)");
    expect(source).toContain("latchedNotice.current ??= currentNotice");
    expect(source).toContain("latchedNotice.current ?? currentNotice");
  });
});
