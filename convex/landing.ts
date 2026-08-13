// =============================================================================
// landing — public, unauthenticated queries for the marketing site. Everything
// here ships to anonymous visitors: expose marketing-safe fields only (no ids,
// contacts, payout state, or internals).
// =============================================================================
import { query } from "./_generated/server";

export type LandingShopPin = {
  name: string;
  lat: number;
  lng: number;
  city: string;
  verified: boolean;
};

// NYC metro bounding box — dev deployments hold test shops in far-away
// states; the public map only ever shows the real service area.
const NYC = { minLat: 40.35, maxLat: 41.05, minLng: -74.6, maxLng: -73.3 };

/** Active shops with coordinates, for the landing coverage map. shops is a
 *  small director-curated table, so a full read is bounded by reality. */
export const shopPins = query({
  args: {},
  handler: async (ctx): Promise<LandingShopPin[]> => {
    const shops = await ctx.db.query("shops").collect();
    return shops
      .filter(
        (s) =>
          s.is_active === true &&
          s.lat != null &&
          s.lng != null &&
          s.lat >= NYC.minLat &&
          s.lat <= NYC.maxLat &&
          s.lng >= NYC.minLng &&
          s.lng <= NYC.maxLng,
      )
      .slice(0, 200)
      .map((s) => ({
        name: s.name,
        lat: s.lat as number,
        lng: s.lng as number,
        city: [s.city, s.state].filter(Boolean).join(", ") || "Staten Island, NY",
        verified: s.is_verified === true,
      }));
  },
});

export type LandingSignup = {
  name: string;
  verified: boolean;
  /** Epoch ms the shop joined — the client renders the relative label. */
  joinedAt: number;
};

/** Newest shops in the service area, for the sidebar's "Live signups" feed.
 *  Same NYC-coordinates gate as shopPins — it keeps far-away dev/test rows
 *  off the marketing page. Name + join time + verification only. */
export const recentSignups = query({
  args: {},
  handler: async (ctx): Promise<LandingSignup[]> => {
    const shops = await ctx.db.query("shops").collect();
    return shops
      .filter(
        (s) =>
          s.is_active === true &&
          s.lat != null &&
          s.lng != null &&
          s.lat >= NYC.minLat &&
          s.lat <= NYC.maxLat &&
          s.lng >= NYC.minLng &&
          s.lng <= NYC.maxLng,
      )
      .map((s) => ({
        name: s.name,
        verified: s.is_verified === true,
        joinedAt: s._creationTime,
      }))
      .sort((a, b) => b.joinedAt - a.joinedAt)
      .slice(0, 3);
  },
});
