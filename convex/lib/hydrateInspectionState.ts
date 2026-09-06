/**
 * convex/lib/hydrateInspectionState.ts — stored `vehicle_inspections.zones`
 * (snake_case, per-field-type records) → the runtime `InspectionState`
 * shape (`lib/inspection-template.ts`) that `deriveSuggestedRecommendations`,
 * `deriveTierInspectionScope`, and `convex/lib/inspectionHealth.ts`'s
 * `deriveCoreGrades` all read.
 *
 * Extracted out of convex/bookings.ts (which still re-exports it for its
 * own existing callers) so convex/inspectionHealthDeferred.ts can reuse it
 * without creating a circular import between the two.
 */

import {
  INSPECTION_ZONES_BY_ID,
  createInspectionState,
  defaultZoneState,
  type InspectionState,
} from "../../lib/inspection-template";

export function hydrateTieredInspectionState(inspection: any): InspectionState {
  const state = createInspectionState();
  for (const input of inspection?.zones ?? []) {
    const zoneId = input.zone_id as keyof typeof INSPECTION_ZONES_BY_ID;
    const zone = INSPECTION_ZONES_BY_ID[zoneId];
    if (!zone || zoneId === "OWNER") continue;
    const base = defaultZoneState(zone);
    state.zones[zoneId] = {
      ...base,
      done: !!input.done,
      dirty: false,
      measures: { ...base.measures, ...(input.measures ?? {}) },
      tri: { ...base.tri, ...(input.tri ?? {}) },
      descriptors: { ...base.descriptors, ...(input.descriptors ?? {}) },
      text: { ...base.text, ...(input.text ?? {}) },
      select: { ...base.select, ...(input.select ?? {}) },
      statuses: { ...base.statuses, ...(input.statuses ?? {}) },
      methods: { ...base.methods, ...(input.methods ?? {}) },
      photoIds: [...(input.photo_ids ?? [])].map(String),
      photoTags: { ...base.photoTags, ...(input.photo_tags ?? {}) },
      lights: {
        ...base.lights,
        ...Object.fromEntries(
          Object.entries((input.lights ?? {}) as Record<string, any[]>).map(
            ([key, entries]) => [
              key,
              entries.map((e) => ({ light: e.light, otherText: e.other_text })),
            ],
          ),
        ),
      },
    };
  }
  return state;
}
