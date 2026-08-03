/**
 * serviceCopyTier — maps the onboarding `car_knowledge_level` self
 * rating onto the service-guide tier we render in `ServiceInfoSheet`.
 *
 *   1 / "beginner"      → "simple"        (I prefer things explained)
 *   2 / "intermediate"  → "intermediate"  (I know some stuff)
 *   3 / "experienced"   → "technician"    (I'm car-savvy)
 *
 * Mirrors the logic in `convex/oto/envelope.ts:knowledgeLabel` so the
 * InfoSheet and Oto AI grounding agree on the user's tier — otherwise
 * a level-3 user would read shop-speak in the info sheet but get
 * customer-friendly chat (or vice-versa).
 *
 * Null / unknown → "simple". Same fallback Oto uses when the user
 * never answered the onboarding question.
 */

import type { ServiceCopyTier } from "@/constants/serviceCopy";

export function resolveServiceCopyTier(
  level: number | string | null | undefined,
): ServiceCopyTier {
  if (level == null) return "simple";
  if (typeof level === "number") {
    if (!Number.isFinite(level)) return "simple";
    if (level <= 1) return "simple";
    if (level === 2) return "intermediate";
    return "technician";
  }
  const s = level.trim().toLowerCase();
  if (!s) return "simple";
  if (/(beginner|novice|new|1)/.test(s)) return "simple";
  if (/(intermediate|some|2)/.test(s)) return "intermediate";
  if (/(experienced|expert|advanced|pro|enthusiast|3|4|5)/.test(s)) {
    return "technician";
  }
  return "simple";
}
