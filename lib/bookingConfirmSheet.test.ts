import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateBookingConfirmLayout,
  calculateBookingConfirmSheetHeight,
} from "./bookingConfirmSheet.ts";

test("booking confirmation sheet gives compact phones enough height for actions", () => {
  assert.equal(calculateBookingConfirmSheetHeight(827), 468);
});

test("booking confirmation sheet scales up on very compact phones without taking the whole screen", () => {
  assert.equal(calculateBookingConfirmSheetHeight(667), 480);
});

test("booking confirmation sheet keeps a usable minimum on taller phones", () => {
  assert.equal(calculateBookingConfirmSheetHeight(900), 504);
});

test("booking confirmation layout shortens the sheet on wider compact devices", () => {
  assert.deepEqual(calculateBookingConfirmLayout({ width: 393, height: 667 }), {
    copyTopPercent: "22%",
    lottieTranslateY: -28,
    sheetHeight: 420,
  });
});

test("booking confirmation layout preserves the tighter narrow phone staging", () => {
  assert.deepEqual(calculateBookingConfirmLayout({ width: 360, height: 827 }), {
    copyTopPercent: "29%",
    lottieTranslateY: -66,
    sheetHeight: 468,
  });
});
