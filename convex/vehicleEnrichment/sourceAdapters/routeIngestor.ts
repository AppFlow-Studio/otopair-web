// =============================================================================
// sourceAdapters/routeIngestor.ts — a RouteSource, wearing the adapter contract.
//
// The registry runs SourceAdapters; routeSources/ produces claims. This is the
// one-function bridge, kept in sourceAdapters/ so the registry's import graph
// does not reach into the route engine.
//
// The adapter NAME is the source id, deliberately. `mycarusermanual` claims
// written before this refactor and after it carry the same adapter string, so
// nothing in the ledger, the run accounting, or the director panels sees a
// discontinuity — the walk moved, the identity did not.
// =============================================================================

import { ingestRouteSpecs } from "../routeSources/ingest";
import type { RouteSource } from "../routeSources/types";
import { SPEC_FIELD_KEYS } from "../manualSpecs";
import type { SourceAdapter } from "./types";

/**
 * Wrap a route source as a rival source adapter.
 *
 * `fields` defaults to the full SPEC_FIELDS contract because that is what the
 * route extraction asks for; a source that can only reach part of it should
 * narrow this so `byField` does not pay for a walk that cannot answer the gap.
 */
export function routeAdapterFor(
  source: RouteSource,
  fields: readonly string[] = SPEC_FIELD_KEYS,
): SourceAdapter {
  return {
    name: source.id,
    family: source.family,
    fields,
    lookup: (vehicle) => ingestRouteSpecs(source, vehicle),
  };
}
