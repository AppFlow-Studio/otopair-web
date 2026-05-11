export type LateStartTimingConfig = {
  testMode: boolean;
  warningLeadMinutes: number;
  initialCycleMinutes: number;
  cycleIncrementMinutes: number;
  minVisibleReviewMs: number;
};

const LATE_START_PRODUCTION_WARNING_LEAD_MINUTES = 5;
const LATE_START_PRODUCTION_INITIAL_CYCLE_MINUTES = 15;
const LATE_START_PRODUCTION_CYCLE_INCREMENT_MINUTES = 15;
const LATE_START_TEST_WARNING_LEAD_MINUTES = 1;
const LATE_START_TEST_INITIAL_CYCLE_MINUTES = 2;
const LATE_START_TEST_CYCLE_INCREMENT_MINUTES = 2;
const LATE_START_TEST_MIN_VISIBLE_REVIEW_MS = 30_000;

export function isLateStartTestModeEnabled() {
  return process.env.LATE_START_TEST_MODE === "true";
}

export function getLateStartTimingConfig(): LateStartTimingConfig {
  if (isLateStartTestModeEnabled()) {
    return {
      testMode: true,
      warningLeadMinutes: LATE_START_TEST_WARNING_LEAD_MINUTES,
      initialCycleMinutes: LATE_START_TEST_INITIAL_CYCLE_MINUTES,
      cycleIncrementMinutes: LATE_START_TEST_CYCLE_INCREMENT_MINUTES,
      minVisibleReviewMs: LATE_START_TEST_MIN_VISIBLE_REVIEW_MS,
    };
  }

  return {
    testMode: false,
    warningLeadMinutes: LATE_START_PRODUCTION_WARNING_LEAD_MINUTES,
    initialCycleMinutes: LATE_START_PRODUCTION_INITIAL_CYCLE_MINUTES,
    cycleIncrementMinutes: LATE_START_PRODUCTION_CYCLE_INCREMENT_MINUTES,
    minVisibleReviewMs: LATE_START_TEST_MIN_VISIBLE_REVIEW_MS,
  };
}
