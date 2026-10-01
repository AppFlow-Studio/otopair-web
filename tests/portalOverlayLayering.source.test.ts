import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const read = (file: string) =>
  fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

const dropdownMenu = read("components/ui/dropdown-menu.tsx");
const bottomSheet = read("components/ui/bottom-sheet.tsx");
const createBookingDrawer = read("app/(portal)/schedule/create-booking-drawer.tsx");
const schedulePage = read("app/(portal)/schedule/page.tsx");
const dashboardPage = read("app/(portal)/dashboard/page.tsx");
const bookingsPage = read("app/(portal)/bookings/page.tsx");

describe("Dropdown menu layering (bug #347)", () => {
  test("Content and SubContent sit at z-[60], not z-50", () => {
    expect(dropdownMenu).toContain('"z-[60] min-w-40 overflow-hidden rounded-lg');
    expect(dropdownMenu).toContain('"z-[60] min-w-40 overflow-hidden rounded-md');
    expect(dropdownMenu).not.toContain('"z-50 ');
  });

  test("clears the BottomSheet but stays below the dialog tiers", () => {
    const sheetZ = Number(bottomSheet.match(/fixed inset-0 z-\[(\d+)\]/)?.[1]);
    const menuZs = [...dropdownMenu.matchAll(/"z-\[(\d+)\] min-w-40/g)].map((m) => Number(m[1]));
    expect(menuZs).toHaveLength(2);
    for (const z of menuZs) {
      expect(z).toBeGreaterThan(sheetZ);
      expect(z).toBeLessThan(65);
    }
  });

  test("BottomSheet Escape leaves an Escape a menu already consumed alone", () => {
    expect(bottomSheet).toContain("if (e.defaultPrevented) return;");
  });

  test.each([
    ["schedule", schedulePage],
    ["dashboard", dashboardPage],
    ["bookings", bookingsPage],
  ])("%s hotkeys ignore keys aimed at an open Radix menu", (_page, source) => {
    expect(source).toContain(
      '(e.target as HTMLElement | null)?.closest?.("[data-radix-menu-content]")',
    );
  });
});

describe("Assigned-to list width (bug #438)", () => {
  test("create-booking Assigned-to list no longer follows the content-width trigger", () => {
    expect(createBookingDrawer).toContain(
      '<SelectPopover placement="bottom start" className="w-56 min-w-(--trigger-width) max-w-[calc(100vw-2rem)]">',
    );
  });

  test("schedule toolbar mechanic filter gets the same width", () => {
    expect(schedulePage).toContain(
      '<SelectPopover placement="bottom end" className="w-56 min-w-(--trigger-width) max-w-[calc(100vw-2rem)]">',
    );
  });
});
