const COMPACT_HEIGHT = 860;
const VERY_COMPACT_HEIGHT = 760;

const REGULAR_RATIO = 0.56;
const COMPACT_RATIO = 0.565;
const VERY_COMPACT_RATIO = 0.72;

const MIN_SHEET_HEIGHT = 468;
const MAX_SHEET_HEIGHT = 620;
const MAX_SCREEN_RATIO = 0.72;
const WIDE_COMPACT_WIDTH = 380;

interface BookingConfirmLayoutInput {
  width: number;
  height: number;
}

interface BookingConfirmLayout {
  sheetHeight: number;
  lottieTranslateY: number;
  copyTopPercent: string;
}

export function calculateBookingConfirmSheetHeight(windowHeight: number): number {
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) {
    return MIN_SHEET_HEIGHT;
  }

  const ratio =
    windowHeight < VERY_COMPACT_HEIGHT
      ? VERY_COMPACT_RATIO
      : windowHeight < COMPACT_HEIGHT
        ? COMPACT_RATIO
        : REGULAR_RATIO;

  const desiredHeight = Math.max(MIN_SHEET_HEIGHT, Math.round(windowHeight * ratio));
  const screenCap = Math.round(windowHeight * MAX_SCREEN_RATIO);
  const maxHeight = Math.min(MAX_SHEET_HEIGHT, screenCap);

  return Math.min(desiredHeight, maxHeight);
}

export function calculateBookingConfirmLayout({
  width,
  height,
}: BookingConfirmLayoutInput): BookingConfirmLayout {
  const isWideCompact = width >= WIDE_COMPACT_WIDTH;
  const isVeryCompactHeight = height < VERY_COMPACT_HEIGHT;
  const isCompactHeight = height < COMPACT_HEIGHT;

  let sheetHeight = calculateBookingConfirmSheetHeight(height);
  let lottieTranslateY = 0;
  let copyTopPercent = "37%";

  if (isWideCompact && isVeryCompactHeight) {
    sheetHeight = Math.min(sheetHeight, Math.max(420, Math.round(height * 0.63)));
    lottieTranslateY = -28;
    copyTopPercent = "22%";
  } else if (isWideCompact && isCompactHeight) {
    sheetHeight = Math.min(sheetHeight, Math.max(440, Math.round(height * 0.535)));
    lottieTranslateY = -36;
    copyTopPercent = "29%";
  } else if (isWideCompact) {
    sheetHeight = Math.min(sheetHeight, Math.max(480, Math.round(height * 0.5)));
    lottieTranslateY = -12;
    copyTopPercent = "34%";
  } else if (isVeryCompactHeight) {
    lottieTranslateY = -94;
    copyTopPercent = "19%";
  } else if (isCompactHeight) {
    lottieTranslateY = -66;
    copyTopPercent = "29%";
  }

  return {
    copyTopPercent,
    lottieTranslateY,
    sheetHeight,
  };
}
