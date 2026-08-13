/** Shared network-pin model for the coverage section: the live Convex pins,
 *  the launch-network stand-ins, and the merge rule that combines them. */

export type Pin = { name: string; lat: number; lng: number; city: string; verified: boolean };

// Launch-network stand-ins (real Staten Island coordinates). They only ever
// FILL — live shops always render, stand-ins top the map up to the floor so
// the launch map never looks empty, and any stand-in parked within half a
// mile of a real shop is dropped (some were seeded at real shops' blocks).
export const CURATED_PINS: Pin[] = [
  { name: "St. George Service Center", lat: 40.6437, lng: -74.0765, city: "Staten Island, NY", verified: true },
  { name: "Port Richmond Service", lat: 40.634, lng: -74.1354, city: "Staten Island, NY", verified: false },
  { name: "Mariners Harbor Garage", lat: 40.6318, lng: -74.1587, city: "Staten Island, NY", verified: true },
  { name: "New Dorp Auto Works", lat: 40.5734, lng: -74.116, city: "Staten Island, NY", verified: true },
  { name: "Eltingville Auto Care", lat: 40.5455, lng: -74.1645, city: "Staten Island, NY", verified: true },
  { name: "Great Kills Tire & Brake", lat: 40.5543, lng: -74.1515, city: "Staten Island, NY", verified: true },
];

const PIN_FLOOR = 6;
const DEDUPE_MILES = 0.5;

export function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** Live pins first (always all of them), curated stand-ins fill up to the
 *  floor. While the query is still loading (undefined), show the stand-ins
 *  so the map is never pinless. */
export function mergeNetworkPins(live: Pin[] | undefined): Pin[] {
  if (live === undefined) return CURATED_PINS;
  const fill = CURATED_PINS.filter(
    (c) => !live.some((r) => milesBetween(r.lat, r.lng, c.lat, c.lng) < DEDUPE_MILES),
  ).slice(0, Math.max(0, PIN_FLOOR - live.length));
  return [...live, ...fill];
}

/** Average nearest-neighbor distance across the shown network — the honest
 *  version of the "avg. distance" stat, derived from the same pins the map
 *  renders. Returns null below 2 pins. */
export function avgNearestMiles(pins: Pin[]): number | null {
  if (pins.length < 2) return null;
  let total = 0;
  for (const p of pins) {
    let best = Infinity;
    for (const q of pins) {
      if (q === p) continue;
      const d = milesBetween(p.lat, p.lng, q.lat, q.lng);
      if (d < best) best = d;
    }
    total += best;
  }
  return total / pins.length;
}
