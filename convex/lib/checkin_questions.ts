/**
 * checkin_questions.ts — Quarterly Check-In Question Engine
 *
 * Selects which of the 11 questions to show based on the vehicle's
 * current mode. Uses the visibility matrix from the spec.
 *
 * Visibility states:
 *   asked      — always shown
 *   optional   — shown if relevant context exists
 *   skipped    — never shown
 *   conditional — only if prior answer triggers it
 */

export type VehicleMode =
  | "lease"
  | "owned_new"
  | "owned_active"
  | "owned_endurance"
  | "owned_weekend";

export type Visibility = "asked" | "optional" | "skipped" | "conditional";

export interface CheckinQuestion {
  id: string;
  label: string;
  category: string;
  type: "number" | "binary" | "multi_select" | "three_option" | "four_option" | "text_expand";
  options?: Array<{ value: string; label: string }>;
  prefill?: string;
  conditionalOn?: { questionId: string; notEqual?: string };
}

const VISIBILITY_MATRIX: Record<string, Record<VehicleMode, Visibility>> = {
  Q1: { lease: "asked", owned_new: "asked", owned_active: "asked", owned_endurance: "asked", owned_weekend: "asked" },
  Q2: { lease: "asked", owned_new: "asked", owned_active: "asked", owned_endurance: "asked", owned_weekend: "asked" },
  Q3: { lease: "conditional", owned_new: "conditional", owned_active: "conditional", owned_endurance: "conditional", owned_weekend: "conditional" },
  Q4: { lease: "asked", owned_new: "asked", owned_active: "asked", owned_endurance: "asked", owned_weekend: "asked" },
  Q4b: { lease: "asked", owned_new: "asked", owned_active: "asked", owned_endurance: "asked", owned_weekend: "asked" },
  Q5: { lease: "optional", owned_new: "optional", owned_active: "asked", owned_endurance: "asked", owned_weekend: "optional" },
  Q6: { lease: "skipped", owned_new: "skipped", owned_active: "optional", owned_endurance: "asked", owned_weekend: "asked" },
  Q7: { lease: "asked", owned_new: "skipped", owned_active: "skipped", owned_endurance: "skipped", owned_weekend: "skipped" },
  Q8: { lease: "skipped", owned_new: "skipped", owned_active: "optional", owned_endurance: "asked", owned_weekend: "skipped" },
  Q9: { lease: "optional", owned_new: "optional", owned_active: "asked", owned_endurance: "asked", owned_weekend: "optional" },
  Q9_detail: { lease: "conditional", owned_new: "conditional", owned_active: "conditional", owned_endurance: "conditional", owned_weekend: "conditional" },
  Q10: { lease: "skipped", owned_new: "skipped", owned_active: "optional", owned_endurance: "optional", owned_weekend: "asked" },
  Q10_role: { lease: "conditional", owned_new: "conditional", owned_active: "conditional", owned_endurance: "conditional", owned_weekend: "conditional" },
  Q11: { lease: "asked", owned_new: "skipped", owned_active: "skipped", owned_endurance: "skipped", owned_weekend: "skipped" },
};

const ALL_QUESTIONS: CheckinQuestion[] = [
  {
    id: "Q1",
    label: "What's on the odometer?",
    category: "core",
    type: "number",
    prefill: "projected_mileage",
  },
  {
    id: "Q2",
    label: "Any service done on this car in the last few months?",
    category: "core",
    type: "multi_select",
    options: [
      { value: "oil_change", label: "Oil Change" },
      { value: "brakes", label: "Brakes" },
      { value: "tires", label: "Tires" },
      { value: "battery", label: "Battery" },
      { value: "inspection", label: "Inspection" },
      { value: "other", label: "Other" },
      { value: "none", label: "None" },
    ],
  },
  {
    id: "Q3",
    label: "Was this done through Otopair?",
    category: "core",
    type: "three_option",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
      { value: "partial", label: "Some of it" },
    ],
    conditionalOn: { questionId: "Q2", notEqual: "none" },
  },
  {
    id: "Q4",
    label: "Any warning lights on right now?",
    category: "condition",
    type: "binary",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  },
  {
    id: "Q4b",
    label: "How are these looking on your car?",
    category: "condition",
    type: "multi_select",
    options: [
      { value: "oil_good", label: "Oil — all good" },
      { value: "brakes_good", label: "Brakes — all good" },
      { value: "tires_good", label: "Tires — all good" },
      { value: "battery_good", label: "Battery — all good" },
      { value: "none", label: "Not sure / Skip" },
    ],
  },
  {
    id: "Q5",
    label: "Anything feel different? Noises, vibrations, pulling?",
    category: "condition",
    type: "text_expand",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  },
  {
    id: "Q6",
    label: "Does the car start up without hesitation every time?",
    category: "condition",
    type: "three_option",
    options: [
      { value: "yes", label: "Yes, every time" },
      { value: "hesitates", label: "Sometimes hesitates" },
      { value: "no_start", label: "Had a no-start" },
    ],
  },
  {
    id: "Q7",
    label: "Is your lease ending in the next 6 months?",
    category: "lifecycle",
    type: "three_option",
    options: [
      { value: "no", label: "No" },
      { value: "ending_soon", label: "Yes, ending soon" },
      { value: "bought_out", label: "Already bought it out" },
    ],
  },
  {
    id: "Q8",
    label: "Planning to keep, sell, or trade this vehicle in the next 6 months?",
    category: "lifecycle",
    type: "three_option",
    options: [
      { value: "keeping", label: "Keeping it" },
      { value: "might_sell", label: "Might sell or trade" },
      { value: "not_sure", label: "Not sure" },
    ],
  },
  {
    id: "Q9",
    label: "Has your driving changed? New commute, different job, more or less driving?",
    category: "usage",
    type: "four_option",
    options: [
      { value: "same", label: "Same as before" },
      { value: "more", label: "Driving more" },
      { value: "less", label: "Driving less" },
      { value: "different", label: "Different type of driving" },
    ],
  },
  {
    id: "Q9_detail",
    label: "What best describes your driving now?",
    category: "usage",
    type: "three_option",
    options: [
      { value: "city", label: "Mostly city / stop-and-go" },
      { value: "highway", label: "Mostly highway" },
      { value: "mixed", label: "Mixed driving" },
    ],
  },
  {
    id: "Q10",
    label: "Is this still your {{role}} car?",
    category: "usage",
    type: "binary",
    options: [
      { value: "yes", label: "Yes, same role" },
      { value: "changed", label: "No, it's changed" },
    ],
  },
  {
    id: "Q10_role",
    label: "What's your car's new role?",
    category: "usage",
    type: "four_option",
    options: [
      { value: "primary", label: "Primary daily driver" },
      { value: "weekend", label: "Weekend / fun car" },
      { value: "stored", label: "Stored / rarely driven" },
      { value: "shared", label: "Shared among family" },
    ],
  },
  {
    id: "Q11",
    label: "Are you tracking close to your mileage allowance?",
    category: "usage",
    type: "three_option",
    options: [
      { value: "on_track", label: "On track" },
      { value: "running_ahead", label: "Running ahead" },
      { value: "well_under", label: "Well under" },
    ],
  },
];

/**
 * Select which questions to show for a given vehicle mode.
 * Returns the ordered question list with "skipped" questions removed.
 * Conditional questions (Q3) are included but flagged — the UI handles
 * showing/hiding based on prior answers.
 */
export function getCheckinQuestions(
  mode: VehicleMode
): CheckinQuestion[] {
  return ALL_QUESTIONS.filter((q) => {
    const vis = VISIBILITY_MATRIX[q.id]?.[mode];
    return vis !== "skipped";
  });
}

/**
 * Get the visibility state for a specific question in a given mode.
 */
export function getQuestionVisibility(
  questionId: string,
  mode: VehicleMode
): Visibility {
  return VISIBILITY_MATRIX[questionId]?.[mode] ?? "skipped";
}

/**
 * Get the list of question IDs that will be shown.
 */
export function getCheckinQuestionIds(mode: VehicleMode): string[] {
  return getCheckinQuestions(mode).map((q) => q.id);
}
