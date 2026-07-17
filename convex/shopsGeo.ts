// =============================================================================
// shopsGeo — address→lat/lng fallback for the network map. Shops without
// coordinates get geocoded from their street address via OSM Nominatim
// (1 req/s per usage policy, custom User-Agent) and the result is PATCHED
// onto the shop row, so the map query picks it up reactively and the lookup
// never repeats. Director action gated on shops.write; every fix is audited.
// =============================================================================
import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { logAudit, roleHasCapability, type DirectorRole } from "./directorGate";
import type { Id } from "./_generated/dataModel";

export const _missingCoords = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    { id: Id<"shops">; name: string; address: string | null; city: string | null; state: string | null; zip: string | null }[]
  > => {
    const shops = await ctx.db.query("shops").collect();
    return shops
      .filter((s) => s.lat == null || s.lng == null)
      .map((s) => ({
        id: s._id,
        name: s.name,
        address: s.address ?? null,
        city: s.city ?? null,
        state: s.state ?? null,
        zip: s.zip ?? null,
      }));
  },
});

export const _setCoords = internalMutation({
  args: {
    shop_id: v.id("shops"),
    lat: v.number(),
    lng: v.number(),
    matched: v.string(),
    actor_name: v.string(),
    actor_id: v.id("director_users"),
  },
  handler: async (ctx, { shop_id, lat, lng, matched, actor_name, actor_id }) => {
    await ctx.db.patch(shop_id, { lat, lng });
    await logAudit(
      ctx,
      { name: actor_name, userId: actor_id },
      {
        entity_type: "shop",
        entity_id: String(shop_id),
        action: "shop_geocoded",
        detail: `lat/lng set from address via Nominatim — matched "${matched.slice(0, 120)}"`,
      },
    );
  },
});

export type GeocodeResult = {
  geocoded: { id: string; name: string; lat: number; lng: number }[];
  failed: { id: string; name: string; reason: string }[];
};

export const geocodeMissingShops = action({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<GeocodeResult> => {
    const session = await ctx.runQuery(api.director_auth.validateSession, { token });
    if (!session) throw new Error("unauthorized: invalid or expired director session");
    if (!roleHasCapability(session.role as DirectorRole, "shops.write")) {
      throw new Error(`forbidden: role '${session.role}' lacks capability 'shops.write'`);
    }

    const missing = await ctx.runQuery(internal.shopsGeo._missingCoords, {});
    const out: GeocodeResult = { geocoded: [], failed: [] };

    for (let i = 0; i < missing.length; i++) {
      const s = missing[i];
      const parts = [s.address, s.city, s.state, s.zip].filter(Boolean);
      if (parts.length === 0) {
        out.failed.push({ id: String(s.id), name: s.name, reason: "no address on record" });
        continue;
      }
      // Nominatim usage policy: max 1 req/s, identifying User-Agent.
      if (i > 0) await new Promise((r) => setTimeout(r, 1100));
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(parts.join(", "))}`;
        const res = await fetch(url, {
          headers: { "User-Agent": "OtopairDirectorConsole/1.0 (ops geocoding)" },
        });
        if (!res.ok) {
          out.failed.push({ id: String(s.id), name: s.name, reason: `nominatim ${res.status}` });
          continue;
        }
        const hits = (await res.json()) as { lat: string; lon: string; display_name: string }[];
        if (!hits.length) {
          out.failed.push({ id: String(s.id), name: s.name, reason: "address not found" });
          continue;
        }
        const lat = parseFloat(hits[0].lat);
        const lng = parseFloat(hits[0].lon);
        if (!isFinite(lat) || !isFinite(lng)) {
          out.failed.push({ id: String(s.id), name: s.name, reason: "bad geocoder response" });
          continue;
        }
        await ctx.runMutation(internal.shopsGeo._setCoords, {
          shop_id: s.id,
          lat,
          lng,
          matched: hits[0].display_name,
          actor_name: session.name,
          actor_id: session.userId as Id<"director_users">,
        });
        out.geocoded.push({ id: String(s.id), name: s.name, lat, lng });
      } catch (e) {
        out.failed.push({
          id: String(s.id),
          name: s.name,
          reason: e instanceof Error ? e.message.slice(0, 80) : "fetch failed",
        });
      }
    }
    return out;
  },
});
