/**
 * OtoIndex, the car-data API, lives in its own repo and on its own origin
 * (`oto-facts`, `next dev -p 3100`). It is a product of Otopair: its layout
 * declares Otopair as the parent organization, and otopair.com/developers
 * is the hand-off to it rather than a second developer portal.
 *
 * The brand and domain are not decided yet. OtoIndex's own lib/api-host.ts
 * derives every public URL from NEXT_PUBLIC_APP_URL and falls back to
 * vinspeclookup.com, so this file mirrors that default exactly: when the
 * domain lands, set NEXT_PUBLIC_OTOINDEX_URL here and NEXT_PUBLIC_APP_URL
 * there, and nothing else moves. In development the fallback is the port
 * the sibling dev server runs on.
 */
const strip = (s: string) => s.replace(/\/+$/, "");

const FALLBACK = process.env.NODE_ENV === "development" ? "http://localhost:3100" : "https://vinspeclookup.com";

/** The OtoIndex site's origin. */
export const OTOINDEX_URL = strip(process.env.NEXT_PUBLIC_OTOINDEX_URL || FALLBACK);

/** Host without the scheme, for printing in copy and in code samples. */
export const OTOINDEX_HOST = OTOINDEX_URL.replace(/^https?:\/\//, "");

/** The pages otopair.com links to. Paths match the sibling's routes; its own
 *  /developers 308s to /contact while access is by request. */
export const OTOINDEX = {
  home: OTOINDEX_URL,
  docs: `${OTOINDEX_URL}/docs`,
  authentication: `${OTOINDEX_URL}/docs/authentication`,
  errors: `${OTOINDEX_URL}/docs/errors`,
  rateLimits: `${OTOINDEX_URL}/docs/rate-limits`,
  quickstart: `${OTOINDEX_URL}/quickstart`,
  pricing: `${OTOINDEX_URL}/pricing`,
  contact: `${OTOINDEX_URL}/contact`,
  coverage: `${OTOINDEX_URL}/coverage`,
  status: `${OTOINDEX_URL}/status`,
  changelog: `${OTOINDEX_URL}/changelog`,
} as const;

/** Keyless sample endpoints: public, CORS-open, no signup, real response
 *  shapes for one reference vehicle. Verified against the running service. */
export const OTOINDEX_SAMPLES: { path: string; what: string }[] = [
  { path: "/api/sample/v1/vehicle", what: "identity, engine and chassis for one configuration" },
  { path: "/api/sample/v1/fluids", what: "OEM fluid types and capacities" },
  { path: "/api/sample/v0/labor", what: "real-world labor times per service" },
];
