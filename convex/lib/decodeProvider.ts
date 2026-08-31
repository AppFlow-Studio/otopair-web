/**
 * lib/decodeProvider.ts — which structured VIN-decode/spec provider the pipeline
 * uses. Kill-switch flag, mirrors egressProxy.ts / manualReducto.ts.
 *
 * `PARTS_DECODE_PROVIDER=carapi` switches processVin + v3 enrichment off the paid
 * Vehicle Databases (VDB) advanced-vin-decode and onto the CarAPI + NHTSA +
 * wheel-size.com + MarketCheck-NeoVIN + Claude stack. Default `vdb` (unchanged
 * behavior) so the switch is opt-in and instantly reversible.
 *
 * NOTE: this flag gates ONLY the structured decode source. Vehicle IMAGES stay
 * on VDB regardless (see lib/vehicle_image.ts, app/api/vehicle-image/route.ts).
 */

export type DecodeProvider = "vdb" | "carapi";

export function decodeProvider(): DecodeProvider {
  return process.env.PARTS_DECODE_PROVIDER?.toLowerCase() === "carapi" ? "carapi" : "vdb";
}
