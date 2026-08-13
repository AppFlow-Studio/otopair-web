/**
 * vehicle_image.ts — Vehicle Databases "Vehicle Images" API resolver.
 *
 * Endpoints:
 *   GET /vehicle-images/{VIN}
 *   GET /vehicle-images/{year}/{make}/{model}/{trim}   (trim required)
 *
 * Cache-first: returns `vehicles.image_url` immediately if populated.
 * On a miss, hits VDB with VIN-first → YMMT-fallback, parses
 * `data.images.{exterior, colors}` (the existing web route gets this
 * wrong by treating `data.images` as a flat array), prefers EVOX
 * front-3/4 renders, guards against VDB returning the wrong make for
 * a given VIN, and aliases Volkswagen/VW. Persists the result via
 * `vehicles.saveVehicleImageUrl` so subsequent emails are free.
 *
 * Mirrors the working RN implementation supplied by the user.
 */
"use node";

import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import { internalAction } from "../_generated/server";

const VDB_BASE = "https://api.vehicledatabases.com/vehicle-images";
const FETCH_TIMEOUT_MS = 6000;

// EVOX color-image filename markers — front 3/4 angle is the most
// flattering generic render. Prefer these before falling back to
// exterior[0].
const EVOX_FRONT_MARKERS = ["3231303031", "6130313031"];

export const resolveVehicleImage = internalAction({
  args: {
    vin: v.optional(v.string()),
    year: v.optional(v.number()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim: v.optional(v.string()),
    // When set, a successful resolution ALSO stamps the config's YMMT-level
    // cache (vehicle_configs.image_url) — the path the Data portal's catalog
    // "fetch image" trigger uses for configs with no linked VIN.
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
  },
  handler: async (ctx, args): Promise<string | null> => {
    const vin = (args.vin ?? "").toUpperCase().trim();

    // 1) Cache check — read whatever's already on the vehicle row.
    let year = args.year ?? null;
    let make = args.make ?? null;
    let model = args.model ?? null;
    let trim = args.trim ?? null;
    if (vin) {
      const cached: any = await ctx.runQuery(
        (internal as any).vehicles.getCachedVehicleImage,
        { vin },
      );
      if (cached?.image_url) {
        // Promote to the config's YMMT slot before returning. The VIN row's
        // image predates the saveVehicleImageUrl promotion for every render
        // resolved so far, so without this the config cache can only ever be
        // filled by a paid VDB call — a cache hit would leave it empty.
        await stampConfig(ctx, args.vehicle_config_id, cached.image_url as string);
        return cached.image_url as string;
      }

      // YMMT-level cache hit — a sibling VIN with the same
      // year/make/model/trim already resolved an image for this
      // vehicle_config. Return it and back-fill this VIN's row so the
      // next read hits step 1 directly (no join needed).
      if (cached?.config_image_url) {
        if (vin.length === 17) {
          try {
            await ctx.runMutation(api.vehicles.saveVehicleImageUrl, {
              vin,
              image_url: cached.config_image_url as string,
            });
          } catch (err) {
            console.warn(
              "[vehicle_image] failed to back-fill image_url from config cache:",
              err,
            );
          }
        }
        return cached.config_image_url as string;
      }

      year = year ?? cached?.year ?? null;
      make = make ?? cached?.make ?? null;
      model = model ?? cached?.model ?? null;
      trim = trim ?? cached?.trim ?? null;
    }

    const apiKey = process.env.VEHICLE_DATABASES_API_KEY;
    if (!apiKey) {
      console.warn(
        "[vehicle_image] VEHICLE_DATABASES_API_KEY not configured; skipping live fetch.",
      );
      return null;
    }

    // 2) Build URL list — VIN first (most reliable), then YMMT.
    const urls: string[] = [];
    if (vin.length === 17) urls.push(`${VDB_BASE}/${vin}`);
    if (year && make && model && trim) {
      for (const m of normalizeMakes(make)) {
        urls.push(
          `${VDB_BASE}/${year}/${encodeURIComponent(m)}/${encodeURIComponent(model)}/${encodeURIComponent(trim)}`,
        );
      }
    }
    if (urls.length === 0) return null;

    for (const url of urls) {
      const json = await fetchVdb(url, apiKey);
      if (!json || json.status !== "success") continue;

      // Guard against VDB returning the wrong make for a VIN.
      if (make) {
        const returnedMake = String(json.data?.make ?? "").toLowerCase();
        const expectedMake = make.toLowerCase();
        if (
          returnedMake &&
          !returnedMake.includes(expectedMake) &&
          !expectedMake.includes(returnedMake)
        ) {
          continue;
        }
      }

      const exterior: string[] = Array.isArray(json.data?.images?.exterior)
        ? json.data.images.exterior
        : [];
      const colors: string[] = Array.isArray(json.data?.images?.colors)
        ? json.data.images.colors
        : [];

      const picked = pickEvoxFront(exterior) ?? colors[0] ?? exterior[0] ?? null;
      if (!picked) continue;

      // 3) Persist for next time. Best-effort — a write failure should
      //    not prevent us from returning the URL we just resolved.
      if (vin.length === 17) {
        try {
          await ctx.runMutation(api.vehicles.saveVehicleImageUrl, {
            vin,
            image_url: picked,
          });
        } catch (err) {
          console.warn(
            "[vehicle_image] failed to cache image_url on vehicles row:",
            err,
          );
        }
      }
      await stampConfig(ctx, args.vehicle_config_id, picked);

      return picked;
    }

    return null;
  },
});

/** Best-effort stamp of the config's YMMT cache. First-fetched-wins is enforced
 *  in _stampConfigImage; a write failure must not lose the resolved URL. */
async function stampConfig(
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  vehicleConfigId: string | undefined,
  imageUrl: string,
): Promise<void> {
  if (!vehicleConfigId) return;
  try {
    await ctx.runMutation(internal.vehicles._stampConfigImage, {
      vehicle_config_id: vehicleConfigId as any,
      image_url: imageUrl,
    });
  } catch (err) {
    console.warn("[vehicle_image] failed to stamp config image_url:", err);
  }
}

async function fetchVdb(url: string, apiKey: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "x-AuthKey": apiKey },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function pickEvoxFront(exterior: string[]): string | null {
  if (exterior.length === 0) return null;
  return (
    exterior.find((u) => EVOX_FRONT_MARKERS.some((m) => u.includes(m))) ??
    exterior[0] ??
    null
  );
}

function normalizeMakes(make: string): string[] {
  const m = make.trim();
  const lower = m.toLowerCase();
  if (lower === "volkswagen") return ["Volkswagen", "VW"];
  if (lower === "vw") return ["VW", "Volkswagen"];
  return [m];
}
