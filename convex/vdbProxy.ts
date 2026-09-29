/**
 * vdbProxy — the mobile app's VehicleDatabases lookups, made server-side.
 *
 * The app used to call api.vehicledatabases.com itself, with the key inlined
 * into the JS bundle (EXPO_PUBLIC_VEHICLE_DB_API_KEY) where anyone could pull
 * it out of the .ipa/.apk and spend our quota (bug #435). The app now sends
 * only the request path; the key stays in VEHICLE_DATABASES_API_KEY on this
 * deployment.
 *
 * Deliberately not an open proxy: signed-in callers only, and only the three
 * read-only endpoints the car image, colour and trim pickers use. Everything
 * else VDB sells (advanced-vin-decode, repair, …) stays server-only.
 */

import { action } from "./_generated/server";
import { v } from "convex/values";

const VDB_BASE = "https://api.vehicledatabases.com";

const ALLOWED_PREFIXES = [
  "/vehicle-images/",
  "/ymm-specs/options/v3/trim/",
  "/ymm-specs/options/v3/model/",
];

/**
 * The full VDB URL for a client-supplied path, or null when the path isn't one
 * of the allowed endpoints. Checks the URL *after* parsing, so dot segments
 * (raw or percent-encoded) can't walk out of an allowed prefix and a
 * protocol-relative path can't point the key at another host.
 */
export function vdbUrlFor(path: string): string | null {
  if (!path.startsWith("/") || path.length > 1024) return null;
  let url: URL;
  try {
    url = new URL(path, VDB_BASE);
  } catch {
    return null;
  }
  if (url.origin !== VDB_BASE || url.search || url.hash) return null;
  if (!ALLOWED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    return null;
  }
  return url.href;
}

export const get = action({
  args: { path: v.string() },
  handler: async (ctx, args): Promise<{ status: number; body: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Your session has expired. Please sign in again.");

    const url = vdbUrlFor(args.path);
    if (!url) throw new Error("Unsupported vehicle lookup.");

    const apiKey = process.env.VEHICLE_DATABASES_API_KEY;
    if (!apiKey) {
      console.error("[vdbProxy] VEHICLE_DATABASES_API_KEY is not set on this deployment");
      return { status: 503, body: "" };
    }

    // Header casing matches convex/lib/vehicleDatabases.ts — VDB's gateway
    // has been seen to 403 a lowercased "x-authkey".
    const response = await fetch(url, { headers: { "x-AuthKey": apiKey } });
    return { status: response.status, body: await response.text() };
  },
});
