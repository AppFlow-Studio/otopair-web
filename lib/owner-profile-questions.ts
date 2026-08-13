// Canonical owner-profile (onboarding) questions surfaced in the inspection's
// OWNER zone. The customer answers these during onboarding in the separate
// "Oto" app; whatever they SKIP shows up here so the mechanic — who is
// physically with the car — can fill observed answers.
//
// Each question's `key` is the backing field on the `vehicle_owners` table.
// "Skipped" = that field is null / undefined / empty. Answers are written back
// via `convex/inspections.ts:saveOwnerProfileAnswers`.

export type OwnerQuestionType = "single" | "multi" | "boolean" | "text";

export type OwnerQuestionOption = { value: string; label: string };

export type OwnerQuestion = {
  /** Field name on the vehicle_owners record. */
  key: string;
  question: string;
  type: OwnerQuestionType;
  options?: OwnerQuestionOption[];
  /** Short hint shown under the question. */
  hint?: string;
};

export const OWNER_PROFILE_QUESTIONS: OwnerQuestion[] = [
  {
    key: "ownershipType",
    question: "Does the customer own or lease this vehicle?",
    type: "single",
    options: [
      { value: "owned", label: "Owned" },
      { value: "leased", label: "Leased" },
    ],
  },
  {
    key: "ownedSinceNew",
    question: "Owned since new?",
    type: "boolean",
    hint: "Helps gauge service history confidence",
  },
  {
    key: "annualMileageBand",
    question: "How much do they drive per year?",
    type: "single",
    options: [
      { value: "light", label: "Light (<7k)" },
      { value: "avg", label: "Average (7–12k)" },
      { value: "heavy", label: "Heavy (12–18k)" },
      { value: "very_heavy", label: "Very heavy (18k+)" },
    ],
  },
  {
    key: "usagePattern",
    question: "What type of driving?",
    type: "single",
    options: [
      { value: "mostly_local", label: "Mostly local" },
      { value: "mostly_highway", label: "Mostly highway" },
      { value: "mixed", label: "Mixed" },
    ],
  },
  {
    key: "lastServiceWhen",
    question: "When was the last service?",
    type: "single",
    options: [
      { value: "lt1mo", label: "< 1 month" },
      { value: "1_3mo", label: "1–3 months" },
      { value: "3_6mo", label: "3–6 months" },
      { value: "6_12mo", label: "6–12 months" },
      { value: "12plus", label: "12+ months" },
      { value: "not_sure", label: "Not sure" },
    ],
  },
  {
    key: "lastServiceWhat",
    question: "What was done at the last service?",
    type: "multi",
    options: [
      { value: "oil_change", label: "Oil change" },
      { value: "brakes", label: "Brakes" },
      { value: "tires", label: "Tires" },
      { value: "battery", label: "Battery" },
      { value: "inspection", label: "Inspection" },
      { value: "other", label: "Other" },
      { value: "none", label: "None" },
    ],
  },
  {
    key: "garageRole",
    question: "What's this vehicle's role?",
    type: "single",
    options: [
      { value: "primary", label: "Primary / daily" },
      { value: "weekend", label: "Weekend / secondary" },
      { value: "stored", label: "Stored / seasonal" },
      { value: "shared", label: "Shared / family" },
    ],
  },
  {
    key: "knownIssues",
    question: "Any known issues or concerns the customer mentioned?",
    type: "text",
    hint: "Free text",
  },
];

export const OWNER_PROFILE_QUESTIONS_BY_KEY: Record<string, OwnerQuestion> =
  OWNER_PROFILE_QUESTIONS.reduce((acc, q) => {
    acc[q.key] = q;
    return acc;
  }, {} as Record<string, OwnerQuestion>);

/** Minimal shape of the owner record needed to compute skipped questions. */
export type OwnerProfileRecord = Record<string, unknown> | null | undefined;

function isAnswered(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return Boolean(value);
}

/**
 * Returns the subset of owner-profile questions the customer has NOT answered
 * (the "skipped" ones), so the inspection's OWNER zone only asks what's missing.
 */
export function getSkippedOwnerQuestions(
  owner: OwnerProfileRecord,
): OwnerQuestion[] {
  return OWNER_PROFILE_QUESTIONS.filter((q) => !isAnswered(owner?.[q.key]));
}

export type OwnerProfileAnswerValue = string | string[] | boolean | null;

/**
 * Coerce a raw answer to the value type expected by the vehicle_owners field,
 * so the save mutation can patch it directly. Returns `undefined` for empty
 * answers (skip the patch) — never overwrites with null.
 */
export function coerceOwnerAnswer(
  question: OwnerQuestion,
  raw: OwnerProfileAnswerValue,
): string | string[] | boolean | undefined {
  if (raw == null) return undefined;
  if (question.type === "multi") {
    const arr = Array.isArray(raw) ? raw.filter((s) => typeof s === "string") : [];
    return arr.length ? arr : undefined;
  }
  if (question.type === "boolean") {
    return typeof raw === "boolean" ? raw : undefined;
  }
  // single | text
  const str = typeof raw === "string" ? raw.trim() : "";
  return str.length ? str : undefined;
}
