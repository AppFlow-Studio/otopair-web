// =============================================================================
// sourceAdapters/registry.ts — the single roster of rival source adapters.
//
// Every adapter whose tests pass is registered here; the pipeline never
// imports an adapter file directly — it asks the registry (byField) which
// adapters can attest a given gap and runs them as rivals for the claim
// ledger (claimLedger.ts) to reconcile.
//
// Pending (broken / tests failing): none — all six wave-1 adapters passed.
//
// Fetchability tiers (routing hint, mirrors AdapterResult.needs_headless):
//   plain_fetch   — server-side fetch works as-is: trico_wipers
//   json_endpoint — structured endpoint, server-side fetch works:
//                   brembo, wix_filters, sylvania_bulbs
//   needs_headless — domain blocks server-side fetch (bot interstitials);
//                   route through the headless tier: summit_centric, amsoil
// =============================================================================

import type { SourceAdapter } from "./types";
import { bremboAdapter } from "./brembo";
import { wixFiltersAdapter } from "./wixFilters";
import { summitCentricAdapter } from "./summitCentric";
import { sylvaniaBulbsAdapter } from "./sylvaniaBulbs";
import { tricoWipersAdapter } from "./tricoWipers";
import { amsoilAdapter } from "./amsoil";
import { rockautoAdapter } from "./rockauto";
import { myCarUserManualAdapter } from "./myCarUserManual";

/** How an adapter's domain can be fetched — used to pick the fetch tier. */
export type Fetchability = "plain_fetch" | "json_endpoint" | "needs_headless";

/** All registered adapters, in stable order. */
export const SOURCE_ADAPTERS: readonly SourceAdapter[] = [
  bremboAdapter,
  wixFiltersAdapter,
  summitCentricAdapter,
  sylvaniaBulbsAdapter,
  tricoWipersAdapter,
  amsoilAdapter,
  rockautoAdapter,
  myCarUserManualAdapter,
];

/** Fetch-tier routing hints, keyed by adapter name. */
export const ADAPTER_FETCHABILITY: Readonly<Record<string, Fetchability>> = {
  [bremboAdapter.name]: "json_endpoint",
  [wixFiltersAdapter.name]: "json_endpoint",
  [summitCentricAdapter.name]: "needs_headless",
  [sylvaniaBulbsAdapter.name]: "json_endpoint",
  [tricoWipersAdapter.name]: "plain_fetch",
  [amsoilAdapter.name]: "needs_headless",
  [rockautoAdapter.name]: "plain_fetch",
  [myCarUserManualAdapter.name]: "plain_fetch",
};

/**
 * Adapters keyed by PART NUMBER rather than by vehicle. They read
 * `AdapterVehicle.known_parts` and are inert without it, so a caller that
 * cannot supply part numbers should skip them rather than pay for a lookup
 * that can only return empty.
 *
 * NOT wix_filters, deliberately. It reads `known_parts` too — its OE
 * cross-reference sets may only CONFIRM a number we hold, never propose one
 * (see THE LAW in wixFilters.ts) — but it is still keyed by VEHICLE: the
 * cascade that decides which WIX filter fits is Y/M/M/E, and the part numbers
 * only gate the claim boundary at the end. It short-circuits before its first
 * request when it has nothing to confirm, so listing it here would buy no
 * saved fetches and would misdescribe how it is keyed.
 */
export const PART_KEYED_ADAPTERS: ReadonlySet<string> = new Set([
  rockautoAdapter.name,
]);

/** Adapters that can attest the given field key (registry order preserved). */
export function byField(fieldKey: string): SourceAdapter[] {
  return SOURCE_ADAPTERS.filter((a) => a.fields.includes(fieldKey));
}
