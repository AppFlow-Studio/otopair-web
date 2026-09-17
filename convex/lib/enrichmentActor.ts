/**
 * enrichmentActor.ts — the one shape for "who triggered this enrichment run".
 *
 * An enrichment run is created in exactly one place (v3pipeline.enrichVehicleBatchV3
 * → v3mutations.createEnrichmentRun), but it can be *kicked off* from many entry
 * points — a driver adding their car, a mechanic capturing a VIN at the windscreen,
 * a director hitting "Re-run" / "Purge + re-enrich" in the panel, the nightly
 * vin_queue worker, or the CLI. Historically the run row only stored a hardcoded
 * `trigger: "new_vehicle"` and NO human identity, so an error-out alert could not
 * say who to go ask.
 *
 * This validator is threaded (always OPTIONAL) through every scheduler hop between
 * a trigger point and createEnrichmentRun, so a run can record the person behind
 * it when there is one. Reused verbatim at each hop — one import, so the object
 * shape can never drift between caller and callee (a mismatch would be a runtime
 * arg-validation throw on the scheduled call).
 *
 * `kind` classifies the source so the alert can label it without a lookup:
 *   "director" — a director/admin acting in the panel (id = director_users id)
 *   "mechanic" — a shop mechanic capturing a VIN (id = users id)
 *   "driver"   — a car owner adding/claiming their vehicle (id = users id)
 *   "system"   — cron / marketplace worker / CLI (rare to set; usually just omit)
 */

import { v } from "convex/values";

/** The actor object, as an OPTIONAL arg validator. Spread-safe: omit for system runs. */
export const enrichmentActorValidator = v.optional(
  v.object({
    /** Display name for the alert — e.g. "Temur", "Ada Lovelace". */
    name: v.string(),
    /** The originating record id (director_users / users), stored as a string. */
    id: v.optional(v.string()),
    /** "director" | "mechanic" | "driver" | "system" */
    kind: v.string(),
  }),
);

export type EnrichmentActor = {
  name: string;
  id?: string;
  kind: string;
};

/** Human-readable one-liner for an actor, for logs / fallback text. */
export function describeActor(actor: EnrichmentActor | null | undefined): string {
  if (!actor) return "system";
  const who = actor.name?.trim() || "unknown";
  return actor.kind ? `${who} (${actor.kind})` : who;
}
